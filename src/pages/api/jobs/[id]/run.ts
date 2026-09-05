import type { APIRoute } from 'astro';

import { getScheduler } from '../../../../lib/scheduler.ts';

/** POST /api/jobs/:id/run — fire the job now. */
export const POST: APIRoute = async ({ params, request, redirect }) => {
  const { scheduler } = getScheduler();
  const run = await scheduler.fire(params.id!, 'manual');
  if (!run) return new Response('job not found', { status: 404 });
  if ((request.headers.get('accept') ?? '').includes('application/json')) {
    return new Response(JSON.stringify({ run }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const flash = run.status === 'failed' ? `Dispatch failed: ${run.error}` : `Dispatched as task ${run.taskId ?? '(message reply)'}.`;
  return redirect(`/jobs/${params.id}?flash=${encodeURIComponent(flash)}`, 303);
};
