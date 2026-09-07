import { describe, expect, it } from 'vitest';

import {
  A2ASTRO_METADATA_KEY,
  OUTFITTER_TASK_EXTENSION_URI,
  OUTFITTER_TASK_METADATA_KEY,
  type A2aTask,
} from '../src/lib/a2a-types.ts';
import { buildChatMessage, findConversation, liveTurn, toConversations, toTurn } from '../src/lib/chat.ts';

const task = (over: Partial<A2aTask> & Pick<A2aTask, 'id' | 'contextId'>): A2aTask => ({
  status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-09-05T10:00:00.000Z' },
  ...over,
});

describe('buildChatMessage', () => {
  it('declares the outfitter extension and marks the turn as chat', () => {
    const request = buildChatMessage({ text: 'hello', messageId: 'm1', sentAt: '2026-09-05T10:00:00.000Z' });
    expect(request.message.extensions).toContain(OUTFITTER_TASK_EXTENSION_URI);
    expect(request.message.metadata?.[A2ASTRO_METADATA_KEY]).toMatchObject({ chat: true, sentAt: '2026-09-05T10:00:00.000Z' });
    expect(request.configuration?.returnImmediately).toBe(true);
    expect(request.message.contextId).toBeUndefined();
    expect(request.message.taskId).toBeUndefined();
  });

  it('carries contextId and taskId only when continuing', () => {
    const request = buildChatMessage({ text: 'approved', contextId: 'ctx-1', taskId: 'task-1', messageId: 'm2' });
    expect(request.message.contextId).toBe('ctx-1');
    expect(request.message.taskId).toBe('task-1');
  });

  it('is idempotent by its own message id', () => {
    const request = buildChatMessage({ text: 'hi', messageId: 'm3' });
    expect(request.message.metadata?.['outfitter-task/v1']).toMatchObject({ idempotency: { messageId: 'm3', scope: 'a2astro' } });
  });
});

describe('toTurn', () => {
  it('reads the prompt from the last user message and the reply from the status message', () => {
    const turn = toTurn(
      task({
        id: 't1',
        contextId: 'c1',
        history: [{ messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'what is up' }] }],
        status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-09-05T10:00:00.000Z', message: { messageId: 'm2', role: 'ROLE_AGENT', parts: [{ text: 'all good' }] } },
      }),
    );
    expect(turn.prompt).toBe('what is up');
    expect(turn.reply).toBe('all good');
    expect(turn.awaitingInput).toBe(false);
  });

  it('falls back to the latest artifact when no status message exists', () => {
    const turn = toTurn(task({ id: 't2', contextId: 'c1', artifacts: [{ artifactId: 'a1', parts: [{ text: 'result' }] }] }));
    expect(turn.reply).toBe('result');
  });

  it('skips output artifacts when choosing an artifact reply', () => {
    const turn = toTurn(
      task({
        id: 't-output',
        contextId: 'c1',
        artifacts: [
          { artifactId: 'reply', parts: [{ text: 'work complete' }] },
          {
            artifactId: 'output',
            name: 'pull_request',
            parts: [{ data: { number: 42 } }],
            extensions: [OUTFITTER_TASK_EXTENSION_URI],
            metadata: { [OUTFITTER_TASK_METADATA_KEY]: { output: 'pull_request', type: 'pull-request', value: { number: 42 } } },
          },
        ],
      }),
    );
    expect(turn.reply).toBe('work complete');
  });

  it('flags interrupted tasks as awaiting input', () => {
    const turn = toTurn(task({ id: 't3', contextId: 'c1', status: { state: 'TASK_STATE_INPUT_REQUIRED', timestamp: '2026-09-05T10:00:00.000Z' } }));
    expect(turn.awaitingInput).toBe(true);
  });
});

describe('toConversations', () => {
  const tasks: A2aTask[] = [
    task({
      id: 't1',
      contextId: 'c1',
      status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-09-05T10:00:00.000Z' },
      metadata: { [A2ASTRO_METADATA_KEY]: { chat: true, sentAt: '2026-09-05T09:00:00.000Z' } },
      history: [{ messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'first question' }] }],
    }),
    task({
      id: 't2',
      contextId: 'c1',
      status: { state: 'TASK_STATE_WORKING', timestamp: '2026-09-05T11:00:00.000Z' },
      metadata: { [A2ASTRO_METADATA_KEY]: { chat: true, sentAt: '2026-09-05T10:30:00.000Z' } },
      history: [{ messageId: 'm2', role: 'ROLE_USER', parts: [{ text: 'follow up' }] }],
    }),
    task({
      id: 't3',
      contextId: 'c2',
      status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-09-04T10:00:00.000Z' },
      history: [{ messageId: 'm3', role: 'ROLE_USER', parts: [{ text: 'scheduled work' }] }],
    }),
  ];

  it('groups tasks by contextId, newest conversation first', () => {
    const conversations = toConversations(tasks);
    expect(conversations.map((c) => c.contextId)).toEqual(['c1', 'c2']);
    expect(conversations[0].turns.map((t) => t.task.id)).toEqual(['t1', 't2']);
    expect(conversations[0].title).toBe('first question');
    expect(conversations[0].open).toBe(true);
  });

  it('marks a conversation that contains dispatched (non-chat) work', () => {
    const conversations = toConversations(tasks);
    expect(conversations[0].chat).toBe(true);
    expect(conversations[1].chat).toBe(false);
  });

  it('selects a conversation by id and defaults to the newest', () => {
    const conversations = toConversations(tasks);
    expect(findConversation(conversations, 'c2')?.contextId).toBe('c2');
    expect(findConversation(conversations, undefined)?.contextId).toBe('c1');
    expect(findConversation(conversations, 'missing')).toBeUndefined();
  });

  it('picks the latest unsettled turn to subscribe to', () => {
    const conversations = toConversations(tasks);
    expect(liveTurn(conversations[0])?.task.id).toBe('t2');
    expect(liveTurn(conversations[1])).toBeUndefined();
  });
});
