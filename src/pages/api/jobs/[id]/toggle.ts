import type { APIRoute } from 'astro';

import { getScheduler } from '../../../../lib/scheduler.ts';

/** POST /api/jobs/:id/toggle — enable or disable the job's schedule. */
export const POST: APIRoute = ({ params, redirect }) => {
  const { store, scheduler } = getScheduler();
  const job = store.getJob(params.id!);
  if (!job) return new Response('job not found', { status: 404 });
  const updated = store.updateJob(job.id, { enabled: !job.enabled });
  scheduler.schedule(updated);
  return redirect(`/jobs/${job.id}`, 303);
};
