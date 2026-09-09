import { type A2aAgentCard, type A2aTask, type A2aTaskState, isSettled } from './a2a-types.ts';
import { clientFor } from './a2a-client.ts';
import { type AgentConfig, loadConfig } from './config.ts';

export interface AgentSnapshot {
  readonly agent: AgentConfig;
  readonly online: boolean;
  readonly card?: A2aAgentCard;
  readonly tasks: readonly A2aTask[];
  readonly error?: string;
  readonly fetchedAt: string;
}

export interface AgentTaskGroups {
  readonly current: A2aTask[];
  readonly queued: A2aTask[];
  readonly previous: A2aTask[];
  readonly previousTotal: number;
}

const PREVIOUS_TASK_LIMIT = 50;

const CURRENT_PRIORITY: Partial<Record<A2aTaskState, number>> = {
  TASK_STATE_WORKING: 0,
  TASK_STATE_INPUT_REQUIRED: 1,
  TASK_STATE_AUTH_REQUIRED: 1,
};

const byTimestamp = (direction: 'asc' | 'desc') =>
  (a: { task: A2aTask; index: number }, b: { task: A2aTask; index: number }): number => {
    const aTimestamp = a.task.status.timestamp;
    const bTimestamp = b.task.status.timestamp;
    if (aTimestamp && !bTimestamp) return -1;
    if (!aTimestamp && bTimestamp) return 1;
    if (!aTimestamp || !bTimestamp) return a.index - b.index;
    const comparison = aTimestamp.localeCompare(bTimestamp);
    return direction === 'asc' ? comparison : -comparison;
  };

/** Split tasks into the three queues shown on an agent page. */
export const groupAgentTasks = (tasks: readonly A2aTask[]): AgentTaskGroups => {
  const current: { task: A2aTask; index: number }[] = [];
  const queued: { task: A2aTask; index: number }[] = [];
  const previous: { task: A2aTask; index: number }[] = [];

  tasks.forEach((task, index) => {
    if (task.status.state === 'TASK_STATE_SUBMITTED') queued.push({ task, index });
    else if (task.status.state in CURRENT_PRIORITY || !isSettled(task.status.state)) current.push({ task, index });
    else previous.push({ task, index });
  });

  current.sort((a, b) => {
    const priority = (CURRENT_PRIORITY[a.task.status.state] ?? 2) - (CURRENT_PRIORITY[b.task.status.state] ?? 2);
    return priority || byTimestamp('desc')(a, b);
  });
  queued.sort(byTimestamp('asc'));
  previous.sort(byTimestamp('desc'));
  const previousTotal = previous.length;

  return {
    current: current.map(({ task }) => task),
    queued: queued.map(({ task }) => task),
    previous: previous.slice(0, PREVIOUS_TASK_LIMIT).map(({ task }) => task),
    previousTotal,
  };
};

export const countByState = (tasks: readonly A2aTask[]): Map<A2aTaskState, number> => {
  const counts = new Map<A2aTaskState, number>();
  for (const task of tasks) counts.set(task.status.state, (counts.get(task.status.state) ?? 0) + 1);
  return counts;
};

/** Fetch card and task list for one agent; never throws, marks offline instead. */
export interface SnapshotOptions {
  /** Include each task's artifacts, which the task list omits by default; the chat transcript needs them for recorded outputs. */
  readonly includeArtifacts?: boolean;
}

export const snapshotAgent = async (agent: AgentConfig, options: SnapshotOptions = {}): Promise<AgentSnapshot> => {
  const client = clientFor(agent);
  const fetchedAt = new Date().toISOString();
  try {
    const [card, tasks] = await Promise.all([client.card(), client.listTasks({ includeArtifacts: options.includeArtifacts })]);
    return { agent, online: true, card, tasks, fetchedAt };
  } catch (error) {
    return { agent, online: false, tasks: [], error: String(error), fetchedAt };
  }
};

export const snapshotAll = (): Promise<AgentSnapshot[]> => Promise.all(loadConfig().agents.map((agent) => snapshotAgent(agent)));
