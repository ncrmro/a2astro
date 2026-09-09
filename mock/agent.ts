/**
 * Mock resident agent: serves the A2A v1 HTTP+JSON surface the Channels
 * extension exposes (agent card, message:send, tasks, subscribe, cancel) and
 * walks each task through the nodes of an outfitter workflow, emitting
 * `a2astro/v1` node metadata so the UI can draw live progress.
 *
 *   node --experimental-strip-types mock/agent.ts            # port 8788, workflow engineer
 *   MOCK_PORT=8789 MOCK_WORKFLOW=issue-triage node --experimental-strip-types mock/agent.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { parse } from 'yaml';

type State =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED';

interface Message {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: { text?: string }[];
  metadata?: Record<string, unknown>;
}
interface Artifact {
  artifactId: string;
  name?: string;
  parts: { text?: string; data?: Record<string, unknown> }[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}
interface Task {
  id: string;
  contextId: string;
  status: { state: State; message?: Message; timestamp: string };
  artifacts: Artifact[];
  history: Message[];
  metadata: Record<string, unknown>;
}

const PORT = Number(process.env.MOCK_PORT ?? 8788);
const WORKFLOW = process.env.MOCK_WORKFLOW ?? 'engineer';
const CATALOG = process.env.MOCK_CATALOG ?? resolve(import.meta.dirname, '../fixtures/catalog');
const STEP_MS = Number(process.env.MOCK_STEP_MS ?? 4000);
const TOKEN = process.env.MOCK_TOKEN ?? '';
const NAME = process.env.MOCK_NAME ?? `mock-${WORKFLOW}`;
const KEY = 'a2astro/v1';
const OUTFITTER_TASK_EXTENSION_URI = 'https://github.com/ai-outfitter/channels/a2a-extensions/outfitter-task/v1';

const workflow = parse(readFileSync(resolve(CATALOG, 'workflows', WORKFLOW, 'workflow.yaml'), 'utf8')) as {
  id: string;
  title: string;
  nodes: { id: string; needs?: string[]; workflow?: string; action?: string }[];
};
const order = (() => {
  const out: string[] = [];
  const done = new Set<string>();
  let remaining = [...workflow.nodes];
  while (remaining.length > 0) {
    const ready = remaining.filter((n) => (n.needs ?? []).every((d) => done.has(d)));
    const pick = ready.length > 0 ? ready : [remaining[0]];
    for (const n of pick) {
      out.push(n.id);
      done.add(n.id);
    }
    remaining = remaining.filter((n) => !done.has(n.id));
  }
  return out;
})();

const tasks = new Map<string, Task>();
const subscribers = new Map<string, Set<(frame: unknown) => void>>();
/** Continue a task that paused in INPUT_REQUIRED, once a reply arrives. */
const resumers = new Map<string, () => void>();
const dedupe = new Map<string, string>();
const now = () => new Date().toISOString();

const emit = (task: Task, frame: unknown) => {
  for (const fn of subscribers.get(task.id) ?? []) fn(frame);
};
const setStatus = (task: Task, state: State, message?: Message) => {
  task.status = { state, message, timestamp: now() };
  emit(task, { statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } });
};
const addArtifact = (task: Task, artifact: Artifact) => {
  task.artifacts.push(artifact);
  emit(task, { artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact, lastChunk: true } });
};
const isTerminal = (s: State) => s === 'TASK_STATE_COMPLETED' || s === 'TASK_STATE_FAILED' || s === 'TASK_STATE_CANCELED';

/** Walk the workflow nodes; fail on a node whose id the body mentions with "fail:". */
const drive = (task: Task, failAt?: string, pauseAt?: string) => {
  let index = 0;
  const step = () => {
    if (isTerminal(task.status.state)) return;
    if (task.status.state === 'TASK_STATE_INPUT_REQUIRED') return;
    const node = order[index];
    if (!node) {
      addArtifact(task, { artifactId: randomUUID(), name: 'result', parts: [{ text: `Finished ${workflow.title}.` }] });
      const value = {
        repository: 'ai-outfitter/example',
        number: 42,
        html_url: 'https://github.com/ai-outfitter/example/pull/42',
      };
      addArtifact(task, {
        artifactId: `output-pull-request-${task.id}`,
        name: 'pull-request',
        parts: [{ data: value }],
        extensions: [OUTFITTER_TASK_EXTENSION_URI],
        metadata: {
          'outfitter-task/v1': { output: 'pull-request', type: 'pull-request', value },
          [KEY]: { node: order[order.length - 1], nodeState: 'done' },
        },
      });
      setStatus(task, 'TASK_STATE_COMPLETED', { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'Done.' }] });
      return;
    }
    setStatus(task, 'TASK_STATE_WORKING', {
      messageId: randomUUID(),
      role: 'ROLE_AGENT',
      parts: [{ text: `Working on ${node}…` }],
      metadata: { [KEY]: { node, nodeState: 'working', workflow: workflow.id } },
    });
    setTimeout(() => {
      if (isTerminal(task.status.state)) return;
      if (failAt === node) {
        addArtifact(task, { artifactId: randomUUID(), name: node, parts: [{ text: `${node} failed.` }], metadata: { [KEY]: { node, nodeState: 'failed' } } });
        setStatus(task, 'TASK_STATE_FAILED', { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: `Failed at ${node}.` }] });
        return;
      }
      addArtifact(task, { artifactId: randomUUID(), name: node, parts: [{ text: `${node} output` }], metadata: { [KEY]: { node, nodeState: 'done' } } });
      index += 1;
      if (pauseAt === node) {
        resumers.set(task.id, () => {
          resumers.delete(task.id);
          step();
        });
        setStatus(task, 'TASK_STATE_INPUT_REQUIRED', {
          messageId: randomUUID(),
          role: 'ROLE_AGENT',
          parts: [{ text: `Need a human decision after ${node}. Reply to continue.` }],
          metadata: { [KEY]: { node: order[index], nodeState: 'working' } },
        });
        return;
      }
      step();
    }, STEP_MS);
  };
  step();
};

/** A chat turn: echo-style reply after one short beat, no workflow walk. */
const chatTurn = (task: Task, prompt: string) => {
  setStatus(task, 'TASK_STATE_WORKING', { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'Thinking…' }] });
  setTimeout(() => {
    if (isTerminal(task.status.state)) return;
    if (/\bpause\b/.test(prompt)) {
      resumers.set(task.id, () => {
        resumers.delete(task.id);
        setStatus(task, 'TASK_STATE_COMPLETED', { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'Thanks — continuing.' }] });
      });
      return setStatus(task, 'TASK_STATE_INPUT_REQUIRED', {
        messageId: randomUUID(),
        role: 'ROLE_AGENT',
        parts: [{ text: 'Which of the two options do you want? Reply to continue.' }],
      });
    }
    addArtifact(task, { artifactId: randomUUID(), name: 'reply', parts: [{ text: `Re: ${prompt.slice(0, 200)}` }] });
    setStatus(task, 'TASK_STATE_COMPLETED', {
      messageId: randomUUID(),
      role: 'ROLE_AGENT',
      parts: [{ text: `${NAME} here. You said: "${prompt.slice(0, 300)}". Nothing to run — this is a chat turn.` }],
    });
  }, Math.min(STEP_MS, 1500));
};

/** Continue an interrupted task with the operator's reply. */
const continueTask = (task: Task, message: Message): Task => {
  task.history.push({ ...message, taskId: task.id, contextId: task.contextId });
  const resume = resumers.get(task.id);
  if (resume) resume();
  else setStatus(task, 'TASK_STATE_WORKING', { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'Resuming.' }] });
  return task;
};

const createTask = (message: Message): Task => {
  const bodyText = message.parts.map((p) => p.text ?? '').join('\n');
  const task: Task = {
    id: randomUUID(),
    contextId: message.contextId ?? randomUUID(),
    status: { state: 'TASK_STATE_SUBMITTED', timestamp: now() },
    artifacts: [],
    history: [{ ...message, taskId: undefined }],
    metadata: { ...(message.metadata ?? {}), [KEY]: { ...((message.metadata?.[KEY] as object) ?? {}), workflow: workflow.id } },
  };
  task.history[0].taskId = task.id;
  task.history[0].contextId = task.contextId;
  tasks.set(task.id, task);
  const meta = (message.metadata?.[KEY] ?? {}) as { chat?: boolean };
  if (meta.chat) {
    setTimeout(() => chatTurn(task, bodyText), 300);
    return task;
  }
  const failAt = /fail:([a-z0-9._-]+)/.exec(bodyText)?.[1];
  const pauseAt = /pause:([a-z0-9._-]+)/.exec(bodyText)?.[1];
  setTimeout(() => drive(task, failAt, pauseAt), 300);
  return task;
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/a2a+json' });
  res.end(JSON.stringify(body));
};
const error = (res: ServerResponse, status: number, reason: string, message: string) =>
  json(res, status, { code: status, message, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }] });
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolveBody) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolveBody(data));
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;
  if (req.method === 'GET' && path === '/.well-known/agent-card.json') {
    return json(res, 200, {
      name: NAME,
      description: `Mock resident agent running the ${workflow.title} workflow.`,
      version: '0.1.0',
      supportedInterfaces: [{ url: `http://127.0.0.1:${PORT}`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
      capabilities: { streaming: true, pushNotifications: false, extensions: [{ uri: OUTFITTER_TASK_EXTENSION_URI, required: false }] },
      skills: [],
    });
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return error(res, 401, 'UNAUTHENTICATED', 'bad token');
  const version = req.headers['a2a-version'];
  if (version && version !== '1.0') return error(res, 400, 'VERSION_NOT_SUPPORTED', `unsupported A2A version ${String(version)}`);

  if (req.method === 'POST' && path === '/message:send') {
    const body = JSON.parse((await readBody(req)) || '{}') as { message: Message; configuration?: { returnImmediately?: boolean } };
    if (!body.message?.messageId) return error(res, 400, 'INVALID_ARGUMENT', 'message.messageId is required');
    const known = dedupe.get(body.message.messageId);
    if (known) return json(res, 200, { task: tasks.get(known) });
    if (body.message.taskId) {
      const target = tasks.get(body.message.taskId);
      if (!target) return error(res, 404, 'TASK_NOT_FOUND', 'no such task');
      if (target.status.state !== 'TASK_STATE_INPUT_REQUIRED') {
        return error(res, 400, 'INVALID_ARGUMENT', 'task is not interruptible');
      }
      dedupe.set(body.message.messageId, target.id);
      return json(res, 200, { task: continueTask(target, body.message) });
    }
    const task = createTask(body.message);
    dedupe.set(body.message.messageId, task.id);
    if (body.configuration?.returnImmediately) return json(res, 200, { task });
    await new Promise<void>((done) => {
      const check = () => (isTerminal(task.status.state) || task.status.state === 'TASK_STATE_INPUT_REQUIRED' ? done() : setTimeout(check, 200));
      check();
    });
    return json(res, 200, { task });
  }
  if (req.method === 'GET' && path === '/tasks') {
    const status = url.searchParams.get('status');
    const contextId = url.searchParams.get('contextId');
    const includeArtifacts = url.searchParams.get('includeArtifacts') === 'true';
    const list = [...tasks.values()]
      .filter((t) => (!status || t.status.state === status) && (!contextId || t.contextId === contextId))
      .map((t) => (includeArtifacts ? t : { ...t, artifacts: [] }));
    return json(res, 200, { tasks: list, nextPageToken: '' });
  }
  const sub = /^\/tasks\/([^/:]+):subscribe$/.exec(path);
  if (req.method === 'GET' && sub) {
    const task = tasks.get(decodeURIComponent(sub[1]));
    if (!task) return error(res, 404, 'TASK_NOT_FOUND', 'no such task');
    if (isTerminal(task.status.state)) return error(res, 400, 'TASK_NOT_CANCELABLE', 'task is terminal');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ task })}\n\n`);
    const fn = (frame: unknown) => {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
      const state = (frame as { statusUpdate?: { status: { state: State } } }).statusUpdate?.status.state;
      if (state && isTerminal(state)) res.end();
    };
    const set = subscribers.get(task.id) ?? new Set();
    set.add(fn);
    subscribers.set(task.id, set);
    req.on('close', () => set.delete(fn));
    return;
  }
  const cancel = /^\/tasks\/([^/:]+):cancel$/.exec(path);
  if (req.method === 'POST' && cancel) {
    const task = tasks.get(decodeURIComponent(cancel[1]));
    if (!task) return error(res, 404, 'TASK_NOT_FOUND', 'no such task');
    if (isTerminal(task.status.state)) return error(res, 400, 'TASK_NOT_CANCELABLE', 'task is terminal');
    setStatus(task, 'TASK_STATE_CANCELED');
    return json(res, 200, task);
  }
  const one = /^\/tasks\/([^/:]+)$/.exec(path);
  if (req.method === 'GET' && one) {
    const task = tasks.get(decodeURIComponent(one[1]));
    return task ? json(res, 200, task) : error(res, 404, 'TASK_NOT_FOUND', 'no such task');
  }
  return error(res, 404, 'NOT_FOUND', `no route for ${req.method} ${path}`);
});

// Seed a few tasks so the UI has something to show immediately.
const seed = (text: string, metadata?: Record<string, unknown>) =>
  createTask({ messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], metadata });
if (process.env.MOCK_SEED !== '0') {
  seed(`Fix the flaky login test reported in issue #42.`);
  seed(`Add retry to the webhook client. pause:${order[1] ?? order[0]}`);
  seed(`Upgrade the container base image. fail:${order[Math.min(2, order.length - 1)]}`);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock agent '${NAME}' on http://127.0.0.1:${PORT} running workflow '${workflow.id}' [${order.join(' → ')}], step ${STEP_MS}ms`);
});
