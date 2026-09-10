import { describe, expect, it } from 'vitest';

import { A2aClient, A2aClientError } from '../src/lib/a2a-client.ts';
import { ELICITATION_EXTENSION_URI, OUTFITTER_TASK_EXTENSION_URI } from '../src/lib/a2a-types.ts';
import type { AgentConfig } from '../src/lib/config.ts';

const agent: AgentConfig = { id: 'x', name: 'X', a2a: { url: 'http://agent.test/', token: 'secret' } };

const fakeFetch = (handler: (url: string, init?: RequestInit) => Response): typeof fetch =>
  (async (input, init) => handler(String(input), init)) as typeof fetch;

describe('A2aClient', () => {
  it('sends bearer auth and the A2A version header, and strips trailing slashes', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const client = new A2aClient(
      { ...agent, a2a: { url: 'http://agent.test/', token: 'secret' } },
      fakeFetch((url, init) => {
        seen = { url, headers: init?.headers as Record<string, string> };
        return new Response(JSON.stringify({ tasks: [{ id: '1', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } }] }), { status: 200 });
      }),
    );
    const tasks = await client.listTasks({ status: 'TASK_STATE_WORKING' });
    expect(tasks).toHaveLength(1);
    expect(seen?.url).toBe('http://agent.test/tasks?status=TASK_STATE_WORKING');
    expect(seen?.headers.authorization).toBe('Bearer secret');
    expect(seen?.headers['a2a-version']).toBe('1.0');
    expect(seen?.headers['a2a-extensions']).toBe(
      [OUTFITTER_TASK_EXTENSION_URI, ELICITATION_EXTENSION_URI].join(','),
    );
  });

  it('asks for artifacts only when includeArtifacts is set', async () => {
    let seen: string | undefined;
    const client = new A2aClient(
      { ...agent, a2a: { url: 'http://agent.test/', token: 'secret' } },
      fakeFetch((url) => {
        seen = url;
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }),
    );
    await client.listTasks({ includeArtifacts: true });
    expect(seen).toBe('http://agent.test/tasks?includeArtifacts=true');
    await client.listTasks({ includeArtifacts: false });
    expect(seen).toBe('http://agent.test/tasks');
  });

  it('surfaces google.rpc.Status errors with their reason', async () => {
    const client = new A2aClient(
      agent,
      fakeFetch(() => new Response(JSON.stringify({ code: 404, message: 'no such task', details: [{ reason: 'TASK_NOT_FOUND' }] }), { status: 404 })),
    );
    await expect(client.getTask('nope')).rejects.toMatchObject({ status: 404, reason: 'TASK_NOT_FOUND' } satisfies Partial<A2aClientError>);
  });

  it('decodes SSE frames from subscribe', async () => {
    const body = ['data: {"task":{"id":"1"}}', '', 'data: {"statusUpdate":{"taskId":"1"}}', ''].join('\n') + '\n';
    const client = new A2aClient(agent, fakeFetch(() => new Response(body, { status: 200 })));
    const frames = [];
    for await (const frame of client.subscribe('1')) frames.push(frame);
    expect(frames).toEqual([{ task: { id: '1' } }, { statusUpdate: { taskId: '1' } }]);
  });
});
