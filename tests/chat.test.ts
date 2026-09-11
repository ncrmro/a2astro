import { describe, expect, it } from 'vitest';

import {
  A2ASTRO_METADATA_KEY,
  ELICITATION_EXTENSION_KEY,
  ELICITATION_EXTENSION_URI,
  OUTFITTER_TASK_EXTENSION_URI,
  OUTFITTER_TASK_METADATA_KEY,
  type A2aTask,
} from '../src/lib/a2a-types.ts';
import { buildChatMessage, chatInputForElicitation, findConversation, liveTurn, toConversations, toTurn } from '../src/lib/chat.ts';
import { readElicitation, responseFromForm } from '../src/lib/elicitation.ts';

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

  it('continues typed elicitation with text fallback and a versioned data part', () => {
    const request = buildChatMessage(chatInputForElicitation(
      { contextId: 'ctx-1', taskId: 'task-1', messageId: 'm4' },
      { action: 'accept', content: { repository: 'other', other: 'a2astro' } },
    ));
    expect(request.message.extensions).toContain(ELICITATION_EXTENSION_URI);
    expect(request.message.parts[0]?.text).toContain('Accepted requested input');
    expect(request.message.parts[1]?.data).toEqual({
      [ELICITATION_EXTENSION_KEY]: { action: 'accept', content: { repository: 'other', other: 'a2astro' } },
    });
  });
});

describe('toTurn', () => {
  it('reads the initial prompt and the reply from the status message', () => {
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
    expect(turn.outputs).toEqual([]);
    expect(turn.awaitingInput).toBe(false);
  });

  it('keeps a structured continuation from replacing or duplicating the initial prompt', () => {
    const turn = toTurn(
      task({
        id: 't-continuation',
        contextId: 'c1',
        history: [
          { messageId: 'a2astro-chat-first', role: 'ROLE_USER', parts: [{ text: 'choose a repository' }] },
          {
            messageId: 'a2astro-chat-second',
            role: 'ROLE_USER',
            parts: [
              { text: 'Accepted requested input: {"repository":"other"}' },
              { data: { [ELICITATION_EXTENSION_KEY]: { action: 'accept', content: { repository: 'other' } } } },
            ],
          },
        ],
      }),
    );
    expect(turn.prompt).toBe('choose a repository');
    const [conversation] = toConversations([turn.task]);
    expect(conversation?.title).toBe('choose a repository');
    expect(conversation?.chat).toBe(true);
  });

  it('falls back to the latest artifact when no status message exists', () => {
    const turn = toTurn(task({ id: 't2', contextId: 'c1', artifacts: [{ artifactId: 'a1', parts: [{ text: 'result' }] }] }));
    expect(turn.reply).toBe('result');
  });

  it('counts recorded outputs per conversation', () => {
    const conversations = toConversations([
      task({
        id: 't-out',
        contextId: 'c-out',
        artifacts: [
          {
            artifactId: 'o',
            name: 'pull-request',
            parts: [{ data: { number: 14 } }],
            metadata: { [OUTFITTER_TASK_METADATA_KEY]: { output: 'pull-request', type: 'pull-request', value: { number: 14 } } },
          },
        ],
      }),
      task({ id: 't-none', contextId: 'c-none' }),
    ]);
    expect(conversations.find((c) => c.contextId === 'c-out')?.outputCount).toBe(1);
    expect(conversations.find((c) => c.contextId === 'c-none')?.outputCount).toBe(0);
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
    expect(turn.outputs).toEqual([{
      name: 'pull_request',
      type: 'pull-request',
      value: { number: 42 },
      identifier: '#42',
    }]);
  });

  it('flags interrupted tasks as awaiting input', () => {
    const waiting = task({ id: 't3', contextId: 'c1', status: { state: 'TASK_STATE_INPUT_REQUIRED', timestamp: '2026-09-05T10:00:00.000Z' } });
    const turn = toTurn(waiting);
    expect(turn.awaitingInput).toBe(true);
    expect(liveTurn(toConversations([waiting])[0])?.task.id).toBe('t3');
  });

  it('keeps non-elicitation data and URL parts in the visible status reply', () => {
    const turn = toTurn(task({
      id: 't-data',
      contextId: 'c1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          messageId: 'status',
          role: 'ROLE_AGENT',
          parts: [{ data: { progress: 2 } }, { url: 'https://example.test/review', filename: 'review' }],
        },
      },
    }));
    expect(turn.reply).toContain('{"progress":2}');
    expect(turn.reply).toContain('[review]');
  });

  it('reads a typed elicitation request from the input-required status', () => {
    const turn = toTurn(task({
      id: 't4',
      contextId: 'c1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          messageId: 'ask',
          role: 'ROLE_AGENT',
          extensions: [ELICITATION_EXTENSION_URI],
          parts: [
            { text: 'Which repository?' },
            { data: { [ELICITATION_EXTENSION_KEY]: {
              message: 'Which repository?',
              requestedSchema: {
                type: 'object',
                properties: {
                  repository: { type: 'string', enum: ['outfitter', 'channels', 'other'], enumNames: ['Outfitter', 'Channels', 'Other'] },
                  other: { type: 'string' },
                },
                required: ['repository'],
              },
            } } },
          ],
        },
      },
    }));
    expect(turn.elicitation?.requestedSchema.properties.repository.enumNames).toEqual(['Outfitter', 'Channels', 'Other']);
  });
});

describe('typed elicitation form', () => {
  const message = {
    messageId: 'ask',
    role: 'ROLE_AGENT' as const,
    extensions: [ELICITATION_EXTENSION_URI],
    parts: [{ data: { [ELICITATION_EXTENSION_KEY]: {
      message: 'Choose',
      requestedSchema: {
        type: 'object',
        properties: {
          choice: { type: 'string', enum: ['one', 'other'] },
          other: { type: 'string' },
          count: { type: 'integer', minimum: 1 },
        },
        required: ['choice', 'count'],
      },
    } } }],
  };

  it('validates and converts accepted form values', () => {
    const request = readElicitation(message);
    expect(request).toBeDefined();
    const form = new FormData();
    form.set('elicitationAction', 'accept');
    form.set('field:choice', 'other');
    form.set('field:other', 'three');
    form.set('field:count', '3');
    expect(responseFromForm(form, request!)).toEqual({
      action: 'accept',
      content: { choice: 'other', other: 'three', count: 3 },
    });
  });

  it('rejects values outside the declared schema', () => {
    const request = readElicitation(message)!;
    const form = new FormData();
    form.set('field:choice', 'surprise');
    form.set('field:count', '0');
    expect(() => responseFromForm(form, request)).toThrow(/allowed choice/);
  });

  it('requires free text when Other is selected', () => {
    const request = readElicitation(message)!;
    const form = new FormData();
    form.set('field:choice', 'other');
    form.set('field:count', '2');
    expect(() => responseFromForm(form, request)).toThrow(/Other is required/);
  });

  it('rejects unsupported schema keywords instead of casting them into controls', () => {
    const unsafe = {
      ...message,
      parts: [{ data: { [ELICITATION_EXTENSION_KEY]: {
        message: 'Unsafe',
        requestedSchema: {
          type: 'object',
          properties: { secret: { type: 'string', format: 'hidden' } },
        },
      } } }],
    };
    expect(readElicitation(unsafe)).toBeUndefined();
  });

  it('preserves exact enum values and prototype-named fields', () => {
    const exactMessage = {
      ...message,
      parts: [{ data: { [ELICITATION_EXTENSION_KEY]: {
        message: 'Exact',
        requestedSchema: {
          type: 'object',
          properties: Object.fromEntries([
            ['choice', { type: 'string', enum: ['  spaced  '] }],
            ['__proto__', { type: 'string' }],
          ]),
          required: ['choice', '__proto__'],
        },
      } } }],
    };
    const request = readElicitation(exactMessage)!;
    const form = new FormData();
    form.set('field:choice', '  spaced  ');
    form.set('field:__proto__', 'kept');
    const response = responseFromForm(form, request);
    expect(response).toEqual({ action: 'accept', content: { choice: '  spaced  ', ['__proto__']: 'kept' } });
    expect(response.action === 'accept' && Object.hasOwn(response.content, '__proto__')).toBe(true);
  });

  it('omits an unanswered optional boolean and requires timezone-bearing date-time values', () => {
    const typedMessage = {
      ...message,
      parts: [{ data: { [ELICITATION_EXTENSION_KEY]: {
        message: 'Typed',
        requestedSchema: {
          type: 'object',
          properties: {
            notify: { type: 'boolean' },
            when: { type: 'string', format: 'date-time' },
          },
          required: ['when'],
        },
      } } }],
    };
    const request = readElicitation(typedMessage)!;
    const local = new FormData();
    local.set('field:when', '2026-09-10T14:30');
    expect(() => responseFromForm(local, request)).toThrow(/timezone/);
    local.set('field:when', '2026-02-30T14:30:00Z');
    expect(() => responseFromForm(local, request)).toThrow(/timezone/);
    local.set('field:when', '2026-09-10T14:30:00-05:00');
    expect(responseFromForm(local, request)).toEqual({
      action: 'accept',
      content: { when: '2026-09-10T14:30:00-05:00' },
    });
  });

  it('accepts an email address with a valid single-label domain', () => {
    const emailMessage = {
      ...message,
      parts: [{ data: { [ELICITATION_EXTENSION_KEY]: {
        message: 'Email',
        requestedSchema: {
          type: 'object',
          properties: { email: { type: 'string', format: 'email' } },
          required: ['email'],
        },
      } } }],
    };
    const request = readElicitation(emailMessage)!;
    const form = new FormData();
    form.set('field:email', 'user@localhost');
    expect(responseFromForm(form, request)).toEqual({
      action: 'accept',
      content: { email: 'user@localhost' },
    });
    for (const malformed of ['.user@example', 'user..name@example', 'user@-host']) {
      form.set('field:email', malformed);
      expect(() => responseFromForm(form, request)).toThrow(/valid email/);
    }
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

  it('prioritizes an awaiting-input turn over a later working turn', () => {
    const waiting = task({
      id: 'waiting',
      contextId: 'c3',
      status: { state: 'TASK_STATE_INPUT_REQUIRED', timestamp: '2026-09-05T10:00:00.000Z' },
    });
    const working = task({
      id: 'working',
      contextId: 'c3',
      status: { state: 'TASK_STATE_WORKING', timestamp: '2026-09-05T11:00:00.000Z' },
    });
    expect(liveTurn(toConversations([waiting, working])[0])?.task.id).toBe('waiting');
  });
});
