# Architecture

```
src/
  lib/
    config.ts       a2astro.config.yaml → AppConfig (env ${VAR} interpolation, path expansion)
    catalog-sources.ts  local path or pinned git catalog → a local directory under <dataDir>/catalogs
    a2a-types.ts    A2A v1 ProtoJSON types + a2astro/v1 metadata helpers
    a2a-client.ts   card / tasks / task / send / cancel / subscribe (SSE decoder) per agent
    agents.ts       snapshot = card + task list, offline-tolerant
    workflows.ts    resolve catalog sources, scan workflows/<slug>/workflow.yaml, validate, closure
    chat.ts         contextId → conversation, task → turn; builds the chat/review message
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
a catalog too. a2astro contributes no workflows of its own — every graph it
draws comes from the catalog the agents resolve, which today is
`ai-outfitter/community-profiles` or an organization catalog that pins it.

Chat and review are the same A2A operation with different arguments: one
`/message:send`, with no ids (new conversation), with a `contextId` (new task in
an existing conversation), or with an explicit `taskId` (continue the
interrupted task). Nothing about a conversation is stored by a2astro; the task
plane is the record.
