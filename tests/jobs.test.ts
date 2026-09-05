import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildMonth } from '../src/lib/calendar.ts';
import { JobStore, occurrencesBetween, nextOccurrence, validateSchedule } from '../src/lib/jobs.ts';
import { Scheduler, buildJobMessage } from '../src/lib/scheduler.ts';

const freshStore = () => new JobStore(join(mkdtempSync(join(tmpdir(), 'a2astro-jobs-')), 'jobs.json'));

describe('JobStore', () => {
  it('round-trips jobs and runs through the JSON file', () => {
    const store = freshStore();
    const job = store.createJob({ title: 'T', agentId: 'vega', body: 'do it', schedule: { kind: 'cron', expression: '0 9 * * *' }, enabled: true });
    const run = store.recordRun({ jobId: job.id, agentId: 'vega', firedAt: new Date().toISOString(), trigger: 'manual', status: 'dispatching' });
    store.updateRun(run.id, { status: 'dispatched', taskId: 'task-1' });
    const reopened = new JobStore((store as unknown as { path: string }).path);
    expect(reopened.getJob(job.id)?.title).toBe('T');
    expect(reopened.findRunByTask('vega', 'task-1')?.status).toBe('dispatched');
    expect(reopened.deleteJob(job.id)).toBe(true);
    expect(reopened.listRuns({ jobId: job.id })).toHaveLength(1);
  });

  it('rejects invalid schedules', () => {
    expect(() => validateSchedule({ kind: 'cron', expression: 'not a cron' })).toThrow();
    expect(() => validateSchedule({ kind: 'once', at: 'yesterday' })).toThrow();
    expect(() => validateSchedule({ kind: 'cron', expression: '*/5 * * * *' })).not.toThrow();
  });
});

describe('occurrences', () => {
  it('expands a cron inside a window and a one-shot only when inside it', () => {
    const from = new Date(2026, 8, 1);
    const to = new Date(2026, 8, 8);
    expect(occurrencesBetween({ kind: 'cron', expression: '0 9 * * *' }, from, to)).toHaveLength(7);
    expect(occurrencesBetween({ kind: 'once', at: new Date(2026, 8, 3, 10).toISOString() }, from, to)).toHaveLength(1);
    expect(occurrencesBetween({ kind: 'once', at: new Date(2026, 9, 3).toISOString() }, from, to)).toHaveLength(0);
    expect(nextOccurrence({ kind: 'once', at: new Date(2000, 0, 1).toISOString() })).toBeUndefined();
  });
});

describe('buildMonth', () => {
  it('lays out a Monday-first grid and pairs fired occurrences with runs', () => {
    const store = freshStore();
    const job = store.createJob({ title: 'Daily', agentId: 'vega', body: 'b', schedule: { kind: 'cron', expression: '0 9 * * *' }, enabled: true });
    const firedAt = new Date(2026, 8, 2, 9, 0, 5).toISOString();
    store.recordRun({ jobId: job.id, agentId: 'vega', firedAt, trigger: 'schedule', status: 'dispatched', taskId: 't' });
    const month = buildMonth(2026, 9, store.listJobs(), store.listRuns(), new Date(2026, 8, 5, 12));
    expect(month.weeks[0][0].date.getDay()).toBe(1);
    expect(month.weeks.every((w) => w.length === 7)).toBe(true);
    const day2 = month.weeks.flat().find((d) => d.iso === '2026-09-02')!;
    expect(day2.entries).toHaveLength(1);
    expect(day2.entries[0].run?.taskId).toBe('t');
    const day20 = month.weeks.flat().find((d) => d.iso === '2026-09-20')!;
    expect(day20.entries[0].run).toBeUndefined();
    expect(month.previous).toEqual({ year: 2026, month: 8 });
    expect(month.next).toEqual({ year: 2026, month: 10 });
  });
});

describe('Scheduler', () => {
  it('records a run and the task the dispatcher returns', async () => {
    const store = freshStore();
    const job = store.createJob({ title: 'Manual', agentId: 'vega', workflow: 'engineer', body: 'ship it', schedule: { kind: 'cron', expression: '0 0 1 1 *' }, enabled: true });
    const seen: string[] = [];
    const scheduler = new Scheduler(
      store,
      async (j, run) => {
        seen.push(j.id);
        const message = buildJobMessage(j, run);
        expect(message.message.metadata?.['a2astro/v1']).toMatchObject({ jobId: j.id, runId: run.id, workflow: 'engineer' });
        expect(message.message.metadata?.['outfitter-task/v1']).toMatchObject({ ticketRunId: run.id });
        expect(message.configuration?.returnImmediately).toBe(true);
        return { taskId: 'task-9', contextId: 'ctx' };
      },
      () => undefined,
    );
    scheduler.start();
    expect(scheduler.nextRun(job.id)).toBeInstanceOf(Date);
    const run = await scheduler.fire(job.id, 'manual');
    expect(seen).toEqual([job.id]);
    expect(run).toMatchObject({ status: 'dispatched', taskId: 'task-9' });
    scheduler.stop();
  });

  it('marks a run failed when dispatch throws and skips disabled jobs', async () => {
    const store = freshStore();
    const job = store.createJob({ title: 'Broken', agentId: 'nobody', body: 'x', schedule: { kind: 'cron', expression: '0 0 1 1 *' }, enabled: false });
    const scheduler = new Scheduler(store, async () => { throw new Error('boom'); }, () => undefined);
    scheduler.start();
    expect(scheduler.nextRun(job.id)).toBeUndefined();
    const run = await scheduler.fire(job.id, 'manual');
    expect(run).toMatchObject({ status: 'failed', error: 'Error: boom' });
    scheduler.stop();
  });
});
