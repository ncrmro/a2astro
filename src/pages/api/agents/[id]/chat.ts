import type { APIRoute } from 'astro';

import { clientFor } from '../../../../lib/a2a-client.ts';
import { buildChatMessage, chatInputForElicitation } from '../../../../lib/chat.ts';
import { findAgent } from '../../../../lib/config.ts';
import { readElicitation, responseFromForm } from '../../../../lib/elicitation.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });

interface ChatInput {
  text: string;
  contextId?: string;
  taskId?: string;
  workflow?: string;
  elicitationAction?: string;
  form?: FormData;
  returnTo?: 'chat' | 'task';
}

const readInput = async (request: Request): Promise<ChatInput> => {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const raw = (await request.json()) as Partial<ChatInput>;
    return {
      text: String(raw.text ?? '').trim(),
      contextId: raw.contextId || undefined,
      taskId: raw.taskId || undefined,
      workflow: raw.workflow || undefined,
      returnTo: raw.returnTo === 'chat' ? 'chat' : 'task',
    };
  }
  const form = await request.formData();
  const str = (key: string): string => String(form.get(key) ?? '').trim();
  return {
    text: str('text'),
    contextId: str('contextId') || undefined,
    taskId: str('taskId') || undefined,
    workflow: str('workflow') || undefined,
    elicitationAction: str('elicitationAction') || undefined,
    form,
    returnTo: str('returnTo') === 'chat' ? 'chat' : 'task',
  };
};

/**
 * POST /api/agents/:id/chat — send one chat turn, or reply to an interrupted
 * task when `taskId` is set (the review path). The bearer token stays here.
 */
export const POST: APIRoute = async ({ params, request, redirect }) => {
  const agent = findAgent(params.id!);
  if (!agent) return new Response('agent not found', { status: 404 });
  const wantsJson =
    (request.headers.get('accept') ?? '').includes('application/json') || (request.headers.get('content-type') ?? '').includes('application/json');
  let input: ChatInput | undefined;
  try {
    input = await readInput(request);
    const client = clientFor(agent);
    let sendInput = input;
    if (input.elicitationAction) {
      if (!input.taskId || !input.form) throw new Error('typed input requires a task');
      const current = await client.getTask(input.taskId);
      if (current.status.state !== 'TASK_STATE_INPUT_REQUIRED') throw new Error('task is not waiting for typed input');
      const elicitation = readElicitation(current.status.message);
      if (!elicitation) throw new Error('task has no typed input request');
      sendInput = chatInputForElicitation(input, responseFromForm(input.form, elicitation));
    }
    if (!sendInput.text) throw new Error('a message is required');
    const response = await client.sendMessage(buildChatMessage(sendInput));
    const task = 'task' in response ? response.task : undefined;
    const contextId = task?.contextId ?? ('message' in response ? response.message.contextId : undefined) ?? input.contextId;
    if (wantsJson) return json({ task: task ?? null, contextId: contextId ?? null }, 202);
    if (input.taskId && input.returnTo !== 'chat') {
      return redirect(`/agents/${agent.id}/tasks/${encodeURIComponent(input.taskId)}`, 303);
    }
    const target = contextId ? `/agents/${agent.id}/chat?c=${encodeURIComponent(contextId)}` : `/agents/${agent.id}/chat`;
    return redirect(target, 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) return json({ error: message }, 502);
    if (input?.taskId && input.returnTo !== 'chat') {
      return redirect(`/agents/${agent.id}/tasks/${encodeURIComponent(input.taskId)}?error=${encodeURIComponent(message)}`, 303);
    }
    const base = `/agents/${agent.id}/chat`;
    const query = new URLSearchParams({ error: message });
    if (input?.contextId) query.set('c', input.contextId);
    return redirect(`${base}?${query}`, 303);
  }
};
