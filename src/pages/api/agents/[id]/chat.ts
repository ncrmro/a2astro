import type { APIRoute } from 'astro';

import { clientFor } from '../../../../lib/a2a-client.ts';
import { buildChatMessage } from '../../../../lib/chat.ts';
import { findAgent } from '../../../../lib/config.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });

interface ChatInput {
  text: string;
  contextId?: string;
  taskId?: string;
  workflow?: string;
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
    };
  }
  const form = await request.formData();
  const str = (key: string): string => String(form.get(key) ?? '').trim();
  return { text: str('text'), contextId: str('contextId') || undefined, taskId: str('taskId') || undefined, workflow: str('workflow') || undefined };
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
    if (!input.text) throw new Error('a message is required');
    const response = await clientFor(agent).sendMessage(buildChatMessage(input));
    const task = 'task' in response ? response.task : undefined;
    const contextId = task?.contextId ?? ('message' in response ? response.message.contextId : undefined) ?? input.contextId;
    if (wantsJson) return json({ task: task ?? null, contextId: contextId ?? null }, 202);
    if (input.taskId) return redirect(`/agents/${agent.id}/tasks/${encodeURIComponent(input.taskId)}`, 303);
    const target = contextId ? `/agents/${agent.id}/chat?c=${encodeURIComponent(contextId)}` : `/agents/${agent.id}/chat`;
    return redirect(target, 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) return json({ error: message }, 502);
    if (input?.taskId) return redirect(`/agents/${agent.id}/tasks/${encodeURIComponent(input.taskId)}?error=${encodeURIComponent(message)}`, 303);
    const base = `/agents/${agent.id}/chat`;
    const query = new URLSearchParams({ error: message });
    if (input?.contextId) query.set('c', input.contextId);
    return redirect(`${base}?${query}`, 303);
  }
};
