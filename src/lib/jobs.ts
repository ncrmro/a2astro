import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Cron } from 'croner';

import { loadConfig } from './config.ts';

export type Schedule =
  | { readonly kind: 'cron'; readonly expression: string; readonly timezone?: string }
  | { readonly kind: 'once'; readonly at: string };

export interface Job {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  /** Workflow slug the agent should execute; also drawn as the run's graph. */
  readonly workflow?: string;
  /** Message body sent to the agent when the job fires (untrusted text on the agent side). */
  readonly body: string;
  readonly schedule: Schedule;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RunStatus = 'dispatching' | 'dispatched' | 'failed';

export interface Run {
  readonly id: string;
  readonly jobId: string;
  readonly agentId: string;
  readonly firedAt: string;
  readonly trigger: 'schedule' | 'manual';
  readonly status: RunStatus;
  /** Task the agent minted for this run; absent when dispatch failed or the agent answered with a plain message. */
  readonly taskId?: string;
  readonly contextId?: string;
  readonly error?: string;
}

interface StoreDocument {
  readonly version: 1;
  jobs: Job[];
  runs: Run[];
}

const EMPTY: StoreDocument = { version: 1, jobs: [], runs: [] };
const MAX_RUNS = 2000;

export class JobStore {
  private document: StoreDocument;

  constructor(private readonly path: string) {
    this.document = this.read();
  }

  static default(): JobStore {
    return new JobStore(join(loadConfig().dataDir, 'jobs.json'));
  }

  private read(): StoreDocument {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreDocument>;
      return { version: 1, jobs: parsed.jobs ?? [], runs: parsed.runs ?? [] };
    } catch {
      return { ...EMPTY, jobs: [], runs: [] };
    }
  }

  private write(): void {
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.document, null, 2));
    renameSync(tmp, this.path);
  }

  listJobs(): readonly Job[] {
    return [...this.document.jobs].sort((a, b) => a.title.localeCompare(b.title));
  }

  getJob(id: string): Job | undefined {
    return this.document.jobs.find((j) => j.id === id);
  }

  createJob(input: Omit<Job, 'id' | 'createdAt' | 'updatedAt'>): Job {
    validateSchedule(input.schedule);
    const now = new Date().toISOString();
    const job: Job = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.document.jobs.push(job);
    this.write();
    return job;
  }

  updateJob(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Job | undefined {
    const index = this.document.jobs.findIndex((j) => j.id === id);
    if (index === -1) return undefined;
    if (patch.schedule) validateSchedule(patch.schedule);
    const job: Job = { ...this.document.jobs[index], ...patch, id, updatedAt: new Date().toISOString() };
    this.document.jobs[index] = job;
    this.write();
    return job;
  }

  deleteJob(id: string): boolean {
    const before = this.document.jobs.length;
    this.document.jobs = this.document.jobs.filter((j) => j.id !== id);
    if (this.document.jobs.length === before) return false;
    this.write();
    return true;
  }

  listRuns(filter: { readonly jobId?: string; readonly agentId?: string } = {}): readonly Run[] {
    return this.document.runs
      .filter((r) => (filter.jobId ? r.jobId === filter.jobId : true) && (filter.agentId ? r.agentId === filter.agentId : true))
      .sort((a, b) => b.firedAt.localeCompare(a.firedAt));
  }

  getRun(id: string): Run | undefined {
    return this.document.runs.find((r) => r.id === id);
  }

  findRunByTask(agentId: string, taskId: string): Run | undefined {
    return this.document.runs.find((r) => r.agentId === agentId && r.taskId === taskId);
  }

  recordRun(run: Omit<Run, 'id'>): Run {
    const created: Run = { ...run, id: randomUUID() };
    this.document.runs.push(created);
    if (this.document.runs.length > MAX_RUNS) this.document.runs.splice(0, this.document.runs.length - MAX_RUNS);
    this.write();
    return created;
  }

  updateRun(id: string, patch: Partial<Run>): Run | undefined {
    const index = this.document.runs.findIndex((r) => r.id === id);
    if (index === -1) return undefined;
    const run: Run = { ...this.document.runs[index], ...patch, id };
    this.document.runs[index] = run;
    this.write();
    return run;
  }
}

export const validateSchedule = (schedule: Schedule): void => {
  if (schedule.kind === 'cron') {
    if (typeof schedule.expression !== 'string' || schedule.expression.trim().length === 0) throw new Error('cron expression is required');
    // Throws on an invalid pattern.
    new Cron(schedule.expression, { timezone: schedule.timezone, paused: true }).stop();
    return;
  }
  if (schedule.kind === 'once') {
    if (Number.isNaN(Date.parse(schedule.at))) throw new Error('one-time schedule needs a valid ISO date-time');
    return;
  }
  throw new Error('schedule.kind must be cron or once');
};

/** Human-readable schedule summary for lists and calendar chips. */
export const describeSchedule = (schedule: Schedule): string =>
  schedule.kind === 'cron' ? `cron ${schedule.expression}${schedule.timezone ? ` (${schedule.timezone})` : ''}` : `once at ${schedule.at}`;

/** Occurrences of a schedule inside [from, to). */
export const occurrencesBetween = (schedule: Schedule, from: Date, to: Date, limit = 500): Date[] => {
  if (schedule.kind === 'once') {
    const at = new Date(schedule.at);
    return at >= from && at < to ? [at] : [];
  }
  const cron = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  try {
    const out: Date[] = [];
    let cursor: Date | null = new Date(from.getTime() - 1000);
    while (out.length < limit) {
      cursor = cron.nextRun(cursor);
      if (!cursor || cursor >= to) break;
      out.push(cursor);
    }
    return out;
  } finally {
    cron.stop();
  }
};

export const nextOccurrence = (schedule: Schedule, from = new Date()): Date | undefined => {
  if (schedule.kind === 'once') {
    const at = new Date(schedule.at);
    return at > from ? at : undefined;
  }
  const cron = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  try {
    return cron.nextRun(from) ?? undefined;
  } finally {
    cron.stop();
  }
};
