/**
 * Direct chat with a resident agent, expressed in the A2A task plane.
 *
 * A conversation is one A2A `contextId`; a turn is one Task inside it. Sending
 * a chat message either opens a new context (no `contextId`), adds a turn to an
 * existing one (`contextId`, which the server attaches only when this principal
 * already owns it), or continues an interrupted task (`taskId`, the review
 * path — authorized the same way).
 */
import { randomUUID } from 'node:crypto';

import {
  A2ASTRO_METADATA_KEY,
  OUTFITTER_TASK_EXTENSION_URI,
  OUTFITTER_TASK_METADATA_KEY,
  type A2aSendMessageRequest,
  type A2aTask,
  type A2aTaskState,
  isOutputArtifact,
  isSettled,
  readA2astroMetadata,
  textOf,
} from './a2a-types.ts';
import { recordedOutputs, type RecordedOutput } from './outputs.ts';

export interface ChatSendInput {
  readonly text: string;
  /** Continue an existing conversation. */
  readonly contextId?: string;
  /** Continue one interrupted task (INPUT_REQUIRED / AUTH_REQUIRED). */
  readonly taskId?: string;
  /** Workflow slug to draw this turn against, when the agent default is wrong. */
  readonly workflow?: string;
  /** Injected in tests. */
  readonly messageId?: string;
  readonly sentAt?: string;
}

/** Build the A2A message a2astro sends for one chat turn or review reply. */
export const buildChatMessage = (input: ChatSendInput): A2aSendMessageRequest => {
  const messageId = input.messageId ?? `a2astro-chat-${randomUUID()}`;
  const sentAt = input.sentAt ?? new Date().toISOString();
  return {
    message: {
      messageId,
      role: 'ROLE_USER',
      parts: [{ text: input.text }],
      ...(input.contextId ? { contextId: input.contextId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      extensions: [OUTFITTER_TASK_EXTENSION_URI],
      metadata: {
        [OUTFITTER_TASK_METADATA_KEY]: { idempotency: { messageId, scope: 'a2astro' } },
        [A2ASTRO_METADATA_KEY]: { chat: true, sentAt, ...(input.workflow ? { workflow: input.workflow } : {}) },
      },
    },
    // Never block the request on the agent's turn: the page subscribes instead.
    configuration: { returnImmediately: true },
  };
};

export interface ConversationTurn {
  readonly task: A2aTask;
  readonly state: A2aTaskState;
  /** What the operator sent, when the task carries a user message. */
  readonly prompt?: string;
  /** The agent's latest reply text: status message first, then artifacts. */
  readonly reply?: string;
  /** Workflow outputs recorded so far, including while the task is live. */
  readonly outputs: readonly RecordedOutput[];
  readonly at: string;
  readonly awaitingInput: boolean;
}

export interface Conversation {
  readonly contextId: string;
  readonly turns: readonly ConversationTurn[];
  /** Latest activity across the conversation's turns. */
  readonly updatedAt: string;
  /** First prompt, used as the conversation's label. */
  readonly title: string;
  readonly open: boolean;
  /** True when every turn was started from the chat surface. */
  readonly chat: boolean;
}

const AWAITING: readonly A2aTaskState[] = ['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'];

/** Ordering key: a2astro's own `sentAt` when present, else the task's last update. */
export const turnOrder = (task: A2aTask): string => {
  const first = task.history?.[0];
  return readA2astroMetadata(first?.metadata)?.sentAt ?? readA2astroMetadata(task.metadata)?.sentAt ?? task.status.timestamp ?? '';
};

const promptOf = (task: A2aTask): string | undefined => {
  const user = (task.history ?? []).filter((m) => m.role === 'ROLE_USER');
  const text = textOf(user.at(-1)?.parts);
  return text || undefined;
};

const replyOf = (task: A2aTask): string | undefined => {
  const status = textOf(task.status.message?.parts);
  if (status) return status;
  const artifact = (task.artifacts ?? []).findLast((candidate) => !isOutputArtifact(candidate));
  const fromArtifact = textOf(artifact?.parts);
  if (fromArtifact) return fromArtifact;
  const agent = (task.history ?? []).filter((m) => m.role === 'ROLE_AGENT').at(-1);
  return textOf(agent?.parts) || undefined;
};

export const toTurn = (task: A2aTask): ConversationTurn => ({
  task,
  state: task.status.state,
  prompt: promptOf(task),
  reply: replyOf(task),
  outputs: recordedOutputs(task.artifacts),
  at: turnOrder(task),
  awaitingInput: AWAITING.includes(task.status.state),
});

const isChatTask = (task: A2aTask): boolean =>
  readA2astroMetadata(task.metadata)?.chat === true ||
  (task.history ?? []).some((m) => readA2astroMetadata(m.metadata)?.chat === true);

/**
 * Group an agent's tasks into conversations by `contextId`, newest first.
 * Every context is a conversation — a job-dispatched task and a chat turn in
 * the same context belong to the same thread, which is what the agent sees.
 */
export const toConversations = (tasks: readonly A2aTask[]): Conversation[] => {
  const byContext = new Map<string, A2aTask[]>();
  for (const task of tasks) {
    const list = byContext.get(task.contextId) ?? [];
    list.push(task);
    byContext.set(task.contextId, list);
  }
  const conversations = [...byContext.entries()].map(([contextId, group]): Conversation => {
    const turns = group.map(toTurn).sort((a, b) => a.at.localeCompare(b.at) || a.task.id.localeCompare(b.task.id));
    const updatedAt = turns.reduce((latest, t) => (t.task.status.timestamp ?? '') > latest ? (t.task.status.timestamp ?? '') : latest, '');
    const title = turns.find((t) => t.prompt)?.prompt?.split('\n')[0]?.slice(0, 80) ?? contextId.slice(0, 12);
    return {
      contextId,
      turns,
      updatedAt,
      title,
      open: turns.some((t) => !isSettled(t.state)),
      chat: group.every(isChatTask),
    };
  });
  return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const findConversation = (conversations: readonly Conversation[], contextId: string | undefined): Conversation | undefined =>
  contextId ? conversations.find((c) => c.contextId === contextId) : conversations[0];

/** The turn a live chat page should subscribe to, if any. */
export const liveTurn = (conversation: Conversation | undefined): ConversationTurn | undefined =>
  [...(conversation?.turns ?? [])].reverse().find((t) => !isSettled(t.state));
