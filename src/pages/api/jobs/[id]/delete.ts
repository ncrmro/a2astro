import type { APIRoute } from 'astro';

import { getScheduler } from '../../../../lib/scheduler.ts';

/** POST /api/jobs/:id/delete — remove the job; its runs stay in history. */
export const POST: APIRoute = ({ params, redirect }) => {
  const { store, scheduler } = getScheduler();
  const id = params.id!;
  if (!store.deleteJob(id)) return new Response('job not found', { status: 404 });
  scheduler.schedule(undefined, id);
  return redirect(`/jobs?flash=${encodeURIComponent('Job deleted.')}`, 303);
};

export const DELETE = POST;
