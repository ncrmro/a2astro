import { type A2aTask, isTerminal, readA2astroMetadata } from './a2a-types.ts';
import { type GraphLayout, type NodeStatus, layoutWorkflow, topologicalIds } from './graph.ts';
import type { WorkflowDefinition } from './workflows.ts';

export interface WorkflowProgress {
  readonly layout: GraphLayout;
  readonly status: ReadonlyMap<string, NodeStatus>;
  /** Node the agent is on right now, if any. */
  readonly current?: string;
  /** Whether node statuses came from explicit `a2astro/v1` metadata or were inferred from task state. */
  readonly source: 'metadata' | 'inferred' | 'none';
}

/**
 * Derive per-node status for a workflow from an A2A task.
 *
 * Explicit path: any status message, history message, or artifact carrying
 * `metadata["a2astro/v1"].node` marks that node. `nodeState` defaults to
 * `working` for the status message and `done` for artifacts. Later events win.
 *
 * Inferred path (no node metadata): SUBMITTED leaves everything pending;
 * WORKING marks the first node working; COMPLETED marks all nodes done;
 * FAILED/REJECTED/CANCELED marks the first node failed and the rest skipped;
 * INPUT/AUTH_REQUIRED marks the first node working (waiting on a human).
 */
export const deriveProgress = (definition: WorkflowDefinition, task: A2aTask | undefined): WorkflowProgress => {
  const layout = layoutWorkflow(definition);
  const order = topologicalIds(layout);
  const status = new Map<string, NodeStatus>(order.map((id) => [id, 'pending' as NodeStatus]));
  if (!task) return { layout, status, source: 'none' };

  const known = new Set(order);
  let current: string | undefined;
  let sawMetadata = false;
  const apply = (metadata: Record<string, unknown> | undefined, fallback: NodeStatus): void => {
    const meta = readA2astroMetadata(metadata);
    if (!meta?.node || !known.has(meta.node)) return;
    sawMetadata = true;
    const state = meta.nodeState ?? fallback;
    status.set(meta.node, state);
    if (state === 'working') current = meta.node;
    else if (current === meta.node) current = undefined;
  };
  for (const message of task.history ?? []) apply(message.metadata, 'working');
  for (const artifact of task.artifacts ?? []) apply(artifact.metadata, 'done');
  apply(task.status.message?.metadata, 'working');
  apply(task.metadata, 'working');

  if (sawMetadata) {
    if (isTerminal(task.status.state)) {
      // A settled task cannot still be working on a node.
      for (const [id, s] of status) {
        if (s === 'working') status.set(id, task.status.state === 'TASK_STATE_COMPLETED' ? 'done' : 'failed');
      }
      current = undefined;
    }
    return { layout, status, current, source: 'metadata' };
  }

  const first = order[0];
  switch (task.status.state) {
    case 'TASK_STATE_WORKING':
    case 'TASK_STATE_INPUT_REQUIRED':
    case 'TASK_STATE_AUTH_REQUIRED':
      if (first) {
        status.set(first, 'working');
        current = first;
      }
      break;
    case 'TASK_STATE_COMPLETED':
      for (const id of order) status.set(id, 'done');
      break;
    case 'TASK_STATE_FAILED':
    case 'TASK_STATE_REJECTED':
    case 'TASK_STATE_CANCELED':
      order.forEach((id, index) => status.set(id, index === 0 ? 'failed' : 'skipped'));
      break;
    default:
      break;
  }
  return { layout, status, current, source: 'inferred' };
};

/** Which workflow slug a task belongs to: task metadata first, then the agent default. */
export const workflowSlugFor = (task: A2aTask | undefined, fallback: string | undefined): string | undefined =>
  readA2astroMetadata(task?.metadata)?.workflow ??
  readA2astroMetadata(task?.history?.[0]?.metadata)?.workflow ??
  fallback;
