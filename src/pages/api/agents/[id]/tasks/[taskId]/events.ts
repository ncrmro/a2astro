import type { APIRoute } from 'astro';

import { clientFor } from '../../../../../../lib/a2a-client.ts';
import { findAgent } from '../../../../../../lib/config.ts';

/**
 * GET /api/agents/:id/tasks/:taskId/events — proxy the agent's A2A subscribe
 * stream to the browser so the bearer token never leaves the server.
 */
export const GET: APIRoute = ({ params, request }) => {
  const agent = findAgent(params.id!);
  if (!agent) return new Response('agent not found', { status: 404 });
  const taskId = params.taskId!;
  const client = clientFor(agent);
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort());
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(sink) {
      sink.enqueue(encoder.encode(': connected\n\n'));
      try {
        for await (const frame of client.subscribe(taskId, controller.signal)) {
          sink.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
      } catch (error) {
        if (!controller.signal.aborted) sink.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(String(error))}\n\n`));
      } finally {
        sink.close();
      }
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
};
