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

export const sortTasks = (tasks: readonly A2aTask[]): A2aTask[] =>
  [...tasks].sort((a, b) => {
    const settledDelta = Number(isSettled(a.status.state)) - Number(isSettled(b.status.state));
    if (settledDelta !== 0) return settledDelta;
    return (b.status.timestamp ?? '').localeCompare(a.status.timestamp ?? '');
  });

export const countByState = (tasks: readonly A2aTask[]): Map<A2aTaskState, number> => {
  const counts = new Map<A2aTaskState, number>();
  for (const task of tasks) counts.set(task.status.state, (counts.get(task.status.state) ?? 0) + 1);
  return counts;
};

/** Fetch card and task list for one agent; never throws, marks offline instead. */
export const snapshotAgent = async (agent: AgentConfig): Promise<AgentSnapshot> => {
  const client = clientFor(agent);
  const fetchedAt = new Date().toISOString();
  try {
    const [card, tasks] = await Promise.all([client.card(), client.listTasks()]);
    return { agent, online: true, card, tasks: sortTasks(tasks), fetchedAt };
  } catch (error) {
    return { agent, online: false, tasks: [], error: String(error), fetchedAt };
  }
};

export const snapshotAll = (): Promise<AgentSnapshot[]> => Promise.all(loadConfig().agents.map(snapshotAgent));
