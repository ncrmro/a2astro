# Architecture

```
src/
  lib/
    config.ts       a2astro.config.yaml → AppConfig (env ${VAR} interpolation, path expansion)
    a2a-types.ts    A2A v1 ProtoJSON types + a2astro/v1 metadata helpers
    a2a-client.ts   card / tasks / task / send / cancel / subscribe (SSE decoder) per agent
    agents.ts       snapshot = card + task list, offline-tolerant
    workflows.ts    scan catalogs for workflows/<slug>/workflow.yaml, validate, closure
    graph.ts        layered DAG layout (needs → layers) and SVG edge paths
    progress.ts     task → per-node status (metadata first, inferred fallback)
    jobs.ts         JobStore (data/jobs.json), schedules, occurrence expansion (croner)
    calendar.ts     month grid with occurrences paired to runs
    scheduler.ts    one Cron per job; fire → record run → A2A message:send → task id
  components/       WorkflowGraph (SVG), StateBadge, TaskRow
  pages/            SSR pages and /api routes (see README)
  middleware.ts     boots the scheduler singleton on first request
mock/agent.ts       stand-in resident agent implementing the A2A surface
fixtures/catalog/   workflow.yaml files copied from community-profiles
```

Rendering is server-side; the only client JavaScript is the task page's
`EventSource` reload and the job form's field toggling. The graph is inline SVG
so it needs no bundle and prints/exports cleanly.

Outfitter is not a runtime dependency: workflow files are read directly with
the same shape `outfitter dump --workflow` validates, so a dumped tree works as
a catalog too.
