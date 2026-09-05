import { randomUUID } from 'node:crypto';

import { Cron } from 'croner';

import { A2ASTRO_METADATA_KEY, OUTFITTER_TASK_EXTENSION_URI, OUTFITTER_TASK_METADATA_KEY, type A2aSendMessageRequest } from './a2a-types.ts';
import { clientFor } from './a2a-client.ts';
import { findAgent } from './config.ts';
import { type Job, JobStore, type Run } from './jobs.ts';

export interface Dispatcher {
  (job: Job, run: Run): Promise<{ readonly taskId?: string; readonly contextId?: string }>;
}

/** Build the A2A message a2astro sends when a job fires. */
export const buildJobMessage = (job: Job, run: Run): A2aSendMessageRequest => ({
  message: {
    messageId: `a2astro-${run.id}`,
    role: 'ROLE_USER',
    parts: [{ text: job.body }],
    extensions: [OUTFITTER_TASK_EXTENSION_URI],
    metadata: {
      [OUTFITTER_TASK_METADATA_KEY]: { ticketRunId: run.id, idempotency: { messageId: `a2astro-${run.id}`, scope: 'a2astro' } },
      [A2ASTRO_METADATA_KEY]: { jobId: job.id, runId: run.id, workflow: job.workflow },
    },
  },
  configuration: { returnImmediately: true },
});

/** Default dispatcher: send the job body to the agent's A2A endpoint. */
export const a2aDispatcher: Dispatcher = async (job, run) => {
  const agent = findAgent(job.agentId);
  if (!agent) throw new Error(`agent '${job.agentId}' is not configured`);
  const response = await clientFor(agent).sendMessage(buildJobMessage(job, run));
  if ('task' in response) return { taskId: response.task.id, contextId: response.task.contextId };
  return { contextId: response.message.contextId };
};

/**
 * In-process scheduler. One `Cron` per enabled job; firing records a run and
 * dispatches it. Occurrences missed while the server was down are not replayed.
 */
export class Scheduler {
  private readonly crons = new Map<string, Cron>();

  constructor(
    private readonly store: JobStore,
    private readonly dispatch: Dispatcher = a2aDispatcher,
    private readonly log: (message: string) => void = (m) => console.log(`[scheduler] ${m}`),
  ) {}

  start(): void {
    for (const job of this.store.listJobs()) this.schedule(job);
    this.log(`started with ${this.crons.size} scheduled job(s)`);
  }

  stop(): void {
    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();
  }

  /** (Re)schedule one job; call after create/update/delete. */
  schedule(job: Job | undefined, id = job?.id): void {
    if (id) this.crons.get(id)?.stop();
    if (id) this.crons.delete(id);
    if (!job || !job.enabled) return;
    const target = job.schedule.kind === 'cron' ? job.schedule.expression : new Date(job.schedule.at);
    if (target instanceof Date && target <= new Date()) return;
    const timezone = job.schedule.kind === 'cron' ? job.schedule.timezone : undefined;
    const cron = new Cron(target, { timezone, protect: true, catch: (error) => this.log(`job ${job.id} failed: ${String(error)}`) }, () => {
      void this.fire(job.id, 'schedule');
    });
    this.crons.set(job.id, cron);
  }

  nextRun(jobId: string): Date | undefined {
    return this.crons.get(jobId)?.nextRun() ?? undefined;
  }

  async fire(jobId: string, trigger: Run['trigger']): Promise<Run | undefined> {
    const job = this.store.getJob(jobId);
    if (!job) return undefined;
    const run = this.store.recordRun({ jobId: job.id, agentId: job.agentId, firedAt: new Date().toISOString(), trigger, status: 'dispatching' });
    try {
      const result = await this.dispatch(job, run);
      this.log(`job '${job.title}' dispatched to ${job.agentId} as task ${result.taskId ?? '(message)'}`);
      return this.store.updateRun(run.id, { status: 'dispatched', taskId: result.taskId, contextId: result.contextId });
    } catch (error) {
      this.log(`job '${job.title}' dispatch failed: ${String(error)}`);
      return this.store.updateRun(run.id, { status: 'failed', error: String(error) });
    }
  }
}

const globalKey = Symbol.for('a2astro.scheduler');
type Holder = { store: JobStore; scheduler: Scheduler; instance: string };

/** Process-wide singleton so Astro's dev server HMR does not start duplicate cron timers. */
export const getScheduler = (): Holder => {
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  let holder = g[globalKey];
  if (!holder) {
    const store = JobStore.default();
    const scheduler = new Scheduler(store);
    scheduler.start();
    holder = { store, scheduler, instance: randomUUID() };
    g[globalKey] = holder;
  }
  return holder;
};
