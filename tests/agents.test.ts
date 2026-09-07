import { describe, expect, it } from 'vitest';

import { groupAgentTasks } from '../src/lib/agents.ts';
import type { A2aTask, A2aTaskState } from '../src/lib/a2a-types.ts';

const task = (id: string, state: A2aTaskState, timestamp?: string): A2aTask => ({
  id,
  contextId: `context-${id}`,
  status: { state, ...(timestamp ? { timestamp } : {}) },
});

describe('groupAgentTasks', () => {
  it('splits current, queued, and previous tasks', () => {
    const groups = groupAgentTasks([
      task('queued', 'TASK_STATE_SUBMITTED'),
      task('working', 'TASK_STATE_WORKING'),
      task('input', 'TASK_STATE_INPUT_REQUIRED'),
      task('auth', 'TASK_STATE_AUTH_REQUIRED'),
      task('unspecified', 'TASK_STATE_UNSPECIFIED'),
      task('complete', 'TASK_STATE_COMPLETED'),
      task('failed', 'TASK_STATE_FAILED'),
    ]);

    expect(groups.current.map(({ id }) => id)).toEqual(['working', 'input', 'auth', 'unspecified']);
    expect(groups.queued.map(({ id }) => id)).toEqual(['queued']);
    expect(groups.previous.map(({ id }) => id)).toEqual(['complete', 'failed']);
  });

  it('orders queued tasks oldest first', () => {
    const groups = groupAgentTasks([
      task('new', 'TASK_STATE_SUBMITTED', '2026-09-07T12:00:00Z'),
      task('old', 'TASK_STATE_SUBMITTED', '2026-09-07T10:00:00Z'),
      task('middle', 'TASK_STATE_SUBMITTED', '2026-09-07T11:00:00Z'),
    ]);
    expect(groups.queued.map(({ id }) => id)).toEqual(['old', 'middle', 'new']);
  });

  it('puts working first, then waiting tasks, newest first within each group', () => {
    const groups = groupAgentTasks([
      task('input-old', 'TASK_STATE_INPUT_REQUIRED', '2026-09-07T09:00:00Z'),
      task('working-old', 'TASK_STATE_WORKING', '2026-09-07T10:00:00Z'),
      task('auth-new', 'TASK_STATE_AUTH_REQUIRED', '2026-09-07T12:00:00Z'),
      task('working-new', 'TASK_STATE_WORKING', '2026-09-07T11:00:00Z'),
    ]);
    expect(groups.current.map(({ id }) => id)).toEqual(['working-new', 'working-old', 'auth-new', 'input-old']);
  });

  it('falls back to incoming task order when a timestamp is missing', () => {
    const groups = groupAgentTasks([
      task('first', 'TASK_STATE_SUBMITTED'),
      task('second', 'TASK_STATE_SUBMITTED', '2026-09-07T10:00:00Z'),
      task('third', 'TASK_STATE_SUBMITTED'),
    ]);
    expect(groups.queued.map(({ id }) => id)).toEqual(['first', 'second', 'third']);
  });
});
