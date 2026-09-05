import type { APIRoute } from 'astro';

import { clientFor } from '../../../../../../lib/a2a-client.ts';
import { findAgent } from '../../../../../../lib/config.ts';

/** POST /api/agents/:id/tasks/:taskId/cancel — forward a cancel to the agent. */
export const POST: APIRoute = async ({ params, redirect }) => {
  const agent = findAgent(params.id!);
  if (!agent) return new Response('agent not found', { status: 404 });
  try {
    await clientFor(agent).cancelTask(params.taskId!);
  } catch (error) {
    return new Response(String(error), { status: 502 });
  }
  return redirect(`/agents/${agent.id}/tasks/${encodeURIComponent(params.taskId!)}`, 303);
};
