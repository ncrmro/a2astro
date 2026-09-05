import { defineMiddleware } from 'astro:middleware';

import { getScheduler } from './lib/scheduler.ts';

/** Ensure the in-process job scheduler is running before the first request is served. */
export const onRequest = defineMiddleware((_context, next) => {
  getScheduler();
  return next();
});
