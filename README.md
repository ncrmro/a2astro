# a2astro

An [Astro](https://astro.build) web server for [Outfitter](https://github.com/ai-outfitter/outfitter) resident agents. It connects to each agent deployed by [agent-operator](https://github.com/ai-outfitter/agent-operator) over the [A2A task plane](https://github.com/ai-outfitter/channels/blob/main/docs/a2a-task-plane.md) that the Channels extension serves, shows every agent's tasks, draws the outfitter workflow each task executes as a graph with the agent's current node highlighted, and schedules jobs on a calendar that dispatch work to those agents.

```
┌────────────┐   A2A HTTP+JSON    ┌──────────────────────┐
│  a2astro   │ ─────────────────▶ │ agent-vega (Deployment)│  /.well-known/agent-card.json
│  (Astro    │ ◀───── SSE ─────── │  pi + Channels ext    │  /tasks, /tasks/{id}:subscribe
│   SSR)     │                    │  A2A_SERVER=1 :8788   │  /message:send
└────────────┘                    └──────────────────────┘
      │ reads workflows/<slug>/workflow.yaml
      ▼
  .agents catalog (community-profiles, your org catalog)
```

## What it shows

- **Agents** (`/`): every configured resident agent, online/offline from its agent card, task counts by A2A state.
- **Agent** (`/agents/:id`): the workflow graph for the task the agent is working on right now, active and settled task tables, the jobs that target it.
- **Task** (`/agents/:id/tasks/:taskId`): live graph (SSE-driven), status message, history, artifacts, cancel.
- **Workflows** (`/workflows`, `/workflows/:slug`): each `workflow.yaml` from the configured catalogs drawn as a layered DAG; nested workflows link through.
- **Calendar** (`/jobs`): month view of scheduled occurrences and past runs; each fired run links to the task it minted. `/jobs/new` schedules a one-shot or cron job; `/jobs/:id` shows the job's latest run on its workflow graph and the full run history.

## Quick start

```sh
npm install
npm run mock        # a mock resident agent on :8788 (engineer workflow)
npm run dev         # http://localhost:4322
```

Without an `a2astro.config.yaml`, the checked-in `a2astro.config.mock.yaml` is used; it points at two mock agents. Run the second with
`MOCK_PORT=8789 MOCK_WORKFLOW=issue-triage npm run mock`. Mock tasks walk the workflow's nodes;
a job body containing `pause:<node>` stops in `INPUT_REQUIRED` after that node and `fail:<node>` fails there.

## Configure real agents

Copy `a2astro.config.example.yaml` to `a2astro.config.yaml` (or set `A2ASTRO_CONFIG`):

```yaml
dataDir: ./data                       # jobs.json lives here
catalogs:
  - ~/repos/ai-outfitter/community-profiles   # any .agents tree with workflows/<slug>/workflow.yaml
agents:
  - id: vega
    name: Vega
    workflow: engineer                # default graph for tasks without workflow metadata
    a2a:
      url: https://vega.ncrmro.com:8788
      token: ${A2ASTRO_VEGA_TOKEN}    # bearer token from the agent's A2A_CREDENTIALS_PATH
    deployment: { cluster: ocean, namespace: agent-vega }
```

Each resident agent must run the Channels extension with `A2A_SERVER=1`, a credentials file that includes a2astro's token, and its listener reachable from where a2astro runs (a NodePort or ingress on the agent namespace, like the relay in the Vega reference deployment). The agent card is fetched unauthenticated; everything else carries the bearer token, which never reaches the browser.

## How tasks map to workflow graphs

The graph for a task is the outfitter workflow named by, in order: the task's `metadata["a2astro/v1"].workflow`, the same key on the first history message, then the agent's `workflow:` in config.

Node status comes from `a2astro/v1` metadata on the task's status message, history messages, and artifacts:

```json
{ "a2astro/v1": { "node": "develop", "nodeState": "working" } }
```

`nodeState` defaults to `working` on messages and `done` on artifacts. Without any node metadata the position is inferred from the A2A state (WORKING → first node, COMPLETED → all done, FAILED → first failed). See [docs/conventions.md](./docs/conventions.md) for what an agent should emit.

When a job fires, a2astro sends one A2A message with `configuration.returnImmediately: true`, the `outfitter-task/v1` extension (`ticketRunId` = run id, idempotent by message id), and `a2astro/v1` metadata naming the job, run, and workflow. The task the agent returns is recorded on the run.

## JSON API

| Route | Purpose |
| --- | --- |
| `GET /api/jobs` | jobs with next run, plus run history |
| `POST /api/jobs` | create a job (JSON body: `title`, `agentId`, `workflow?`, `body`, `schedule`) |
| `POST /api/jobs/:id/run` | fire now |
| `POST /api/jobs/:id/toggle`, `/delete` | enable/disable, delete |
| `GET /api/agents/:id/tasks.json` | agent card and task list |
| `GET /api/agents/:id/tasks/:taskId/events` | SSE proxy of the agent's task subscription |
| `POST /api/agents/:id/tasks/:taskId/cancel` | cancel a task |

Astro's CSRF check is on: non-browser clients must send `content-type: application/json` (or a matching `Origin`) on POSTs.

## Development

```sh
npm run check   # astro check + vitest
npm run build && npm start   # standalone Node server on :4322
```

Scheduling is in-process: one `croner` timer per enabled job, occurrences missed while the server was down are not replayed. Jobs and runs persist to `data/jobs.json`.

## License

MIT
