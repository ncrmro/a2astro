import { describe, expect, it } from 'vitest';

import type { A2aTask } from '../src/lib/a2a-types.ts';
import { deriveProgress, workflowSlugFor } from '../src/lib/progress.ts';
import { scanCatalogs } from '../src/lib/workflows.ts';

const catalog = scanCatalogs([new URL('../fixtures/catalog', import.meta.url).pathname]);
const engineer = catalog.workflows.get('engineer')!.definition;
const KEY = 'a2astro/v1';

const task = (state: A2aTask['status']['state'], extra: Partial<A2aTask> = {}): A2aTask => ({
  id: 't1',
  contextId: 'c1',
  status: { state, timestamp: '2026-09-05T00:00:00Z' },
  ...extra,
});

describe('deriveProgress', () => {
  it('leaves everything pending without a task', () => {
    const p = deriveProgress(engineer, undefined);
    expect(p.source).toBe('none');
    expect([...p.status.values()].every((s) => s === 'pending')).toBe(true);
  });

  it('infers the first node as working for a WORKING task with no metadata', () => {
    const p = deriveProgress(engineer, task('TASK_STATE_WORKING'));
    expect(p.source).toBe('inferred');
    expect(p.current).toBe('issue');
    expect(p.status.get('issue')).toBe('working');
    expect(p.status.get('develop')).toBe('pending');
  });

  it('infers all done for COMPLETED and first failed/rest skipped for FAILED', () => {
    expect([...deriveProgress(engineer, task('TASK_STATE_COMPLETED')).status.values()].every((s) => s === 'done')).toBe(true);
    const failed = deriveProgress(engineer, task('TASK_STATE_FAILED'));
    expect(failed.status.get('issue')).toBe('failed');
    expect(failed.status.get('merge')).toBe('skipped');
  });

  it('uses a2astro/v1 node metadata from artifacts and the status message', () => {
    const p = deriveProgress(
      engineer,
      task('TASK_STATE_WORKING', {
        artifacts: [
          { artifactId: 'a1', parts: [], metadata: { [KEY]: { node: 'issue', nodeState: 'done' } } },
          { artifactId: 'a2', parts: [], metadata: { [KEY]: { node: 'develop' } } },
        ],
        status: {
          state: 'TASK_STATE_WORKING',
          message: { messageId: 'm', role: 'ROLE_AGENT', parts: [], metadata: { [KEY]: { node: 'draft', nodeState: 'working' } } },
        },
      }),
    );
    expect(p.source).toBe('metadata');
    expect(p.status.get('issue')).toBe('done');
    expect(p.status.get('develop')).toBe('done');
    expect(p.status.get('draft')).toBe('working');
    expect(p.current).toBe('draft');
    expect(p.status.get('review')).toBe('pending');
  });

  it('never leaves a node working once the task is terminal', () => {
    const p = deriveProgress(
      engineer,
      task('TASK_STATE_FAILED', { history: [{ messageId: 'h', role: 'ROLE_AGENT', parts: [], metadata: { [KEY]: { node: 'develop', nodeState: 'working' } } }] }),
    );
    expect(p.status.get('develop')).toBe('failed');
    expect(p.current).toBeUndefined();
  });

  it('ignores node ids that are not in the workflow', () => {
    const p = deriveProgress(engineer, task('TASK_STATE_WORKING', { metadata: { [KEY]: { node: 'nope' } } }));
    expect(p.source).toBe('inferred');
  });
});

describe('workflowSlugFor', () => {
  it('prefers task metadata, then the first history message, then the fallback', () => {
    expect(workflowSlugFor(task('TASK_STATE_WORKING', { metadata: { [KEY]: { workflow: 'bug-issue' } } }), 'engineer')).toBe('bug-issue');
    expect(
      workflowSlugFor(task('TASK_STATE_WORKING', { history: [{ messageId: 'h', role: 'ROLE_USER', parts: [], metadata: { [KEY]: { workflow: 'issue-triage' } } }] }), 'engineer'),
    ).toBe('issue-triage');
    expect(workflowSlugFor(task('TASK_STATE_WORKING'), 'engineer')).toBe('engineer');
    expect(workflowSlugFor(undefined, undefined)).toBeUndefined();
  });
});
