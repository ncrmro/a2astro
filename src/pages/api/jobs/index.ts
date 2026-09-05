import type { APIRoute } from 'astro';

import { findAgent } from '../../../lib/config.ts';
import type { Schedule } from '../../../lib/jobs.ts';
import { getScheduler } from '../../../lib/scheduler.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });

/** GET /api/jobs — list jobs and their runs as JSON. */
export const GET: APIRoute = () => {
  const { store, scheduler } = getScheduler();
  return json({
    jobs: store.listJobs().map((j) => ({ ...j, nextRun: scheduler.nextRun(j.id)?.toISOString() ?? null })),
    runs: store.listRuns(),
  });
};

interface JobInput {
  title: string;
  agentId: string;
  workflow?: string;
  body: string;
  schedule: Schedule;
  enabled: boolean;
}

const readInput = async (request: Request): Promise<JobInput> => {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const raw = (await request.json()) as Partial<JobInput>;
    return {
      title: String(raw.title ?? ''),
      agentId: String(raw.agentId ?? ''),
      workflow: raw.workflow || undefined,
      body: String(raw.body ?? ''),
      schedule: raw.schedule as Schedule,
      enabled: raw.enabled ?? true,
    };
  }
  const form = await request.formData();
  const str = (key: string): string => String(form.get(key) ?? '').trim();
  const kind = str('kind');
  const schedule: Schedule =
    kind === 'once'
      ? { kind: 'once', at: new Date(str('at')).toISOString() }
      : { kind: 'cron', expression: str('expression'), timezone: str('timezone') || undefined };
  return { title: str('title'), agentId: str('agentId'), workflow: str('workflow') || undefined, body: str('body'), schedule, enabled: true };
};

/** POST /api/jobs — create a job from the HTML form or a JSON body. */
export const POST: APIRoute = async ({ request, redirect }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json') || (request.headers.get('content-type') ?? '').includes('application/json');
  try {
    const input = await readInput(request);
    if (!input.title) throw new Error('title is required');
    if (!input.body) throw new Error('message body is required');
    if (!findAgent(input.agentId)) throw new Error(`agent '${input.agentId}' is not configured`);
    if (input.schedule?.kind === 'once' && Number.isNaN(Date.parse(input.schedule.at))) throw new Error('a valid date and time is required');
    const { store, scheduler } = getScheduler();
    const job = store.createJob(input);
    scheduler.schedule(job);
    return wantsJson ? json({ job }, 201) : redirect(`/jobs/${job.id}?flash=${encodeURIComponent('Job created.')}`, 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return wantsJson ? json({ error: message }, 400) : redirect(`/jobs/new?error=${encodeURIComponent(message)}`, 303);
  }
};
