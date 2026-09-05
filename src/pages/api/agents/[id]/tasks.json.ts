import type { APIRoute } from 'astro';

import { snapshotAgent } from '../../../../lib/agents.ts';
import { findAgent } from '../../../../lib/config.ts';

/** GET /api/agents/:id/tasks.json — the agent's card and task list as a2astro sees them. */
export const GET: APIRoute = async ({ params }) => {
  const agent = findAgent(params.id!);
  if (!agent) return new Response('agent not found', { status: 404 });
  const snapshot = await snapshotAgent(agent);
  const { a2a: _a2a, ...safeAgent } = agent;
  return new Response(JSON.stringify({ ...snapshot, agent: { ...safeAgent, url: agent.a2a.url } }, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
};
