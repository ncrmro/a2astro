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

- **Chat** (`/chat`): opens the configured `defaultAgent`, then lets you switch resident agents without returning to the directory.
- **Agents** (`/agents`): every configured resident agent, online/offline from its agent card, task counts by A2A state. `/` opens the default chat.
- **Agent** (`/agents/:id`): the workflow graph for the task the agent is working on right now, active and settled task tables, the jobs that target it.
- **Chat** (`/agents/:id/chat`): talk to the agent directly. A conversation is one A2A `contextId` and each turn is one Task inside it; the transcript streams while the agent works.
- **Task** (`/agents/:id/tasks/:taskId`): live graph (SSE-driven), status message, history, artifacts, cancel — and, when the task stops in `INPUT_REQUIRED` or `AUTH_REQUIRED`, a reply form that continues *that* task by explicit `taskId`.
- **Workflows** (`/workflows`, `/workflows/:slug`): each `workflow.yaml` from the configured catalogs drawn as a layered DAG; nested workflows link through.
- **Calendar** (`/jobs`): month view of scheduled occurrences and past runs; each fired run links to the task it minted. `/jobs/new` schedules a one-shot or cron job; `/jobs/:id` shows the job's latest run on its workflow graph and the full run history.

## Quick start

```sh
npm install
npm run mock        # a mock resident agent on :8788 (engineer workflow)
npm run dev         # http://localhost:4322
```

Without an `a2astro.config.yaml`, the checked-in `a2astro.config.mock.yaml` is used; it points at two mock agents and the offline fixture catalog. Run the second with
`MOCK_PORT=8789 MOCK_WORKFLOW=issue-triage npm run mock`. Mock tasks walk the workflow's nodes;
a job body containing `pause:<node>` stops in `INPUT_REQUIRED` after that node and `fail:<node>` fails there.

## Configure real agents

Copy `a2astro.config.example.yaml` to `a2astro.config.yaml` (or set `A2ASTRO_CONFIG`):

```yaml
dataDir: ./data                       # jobs.json and the catalog cache live here
defaultAgent: luce                    # /chat opens this agent; otherwise the first agent wins
catalogs:
  - uri: https://github.com/ai-outfitter/community-profiles.git   # pinned, fetched once
    revision: v1.7.0
agents:
  - id: vega
    name: Vega
    workflow: engineer                # default graph for tasks without workflow metadata
    a2a:
      url: https://vega.ncrmro.com:8788
      token: ${A2ASTRO_VEGA_TOKEN}    # bearer token from the agent's A2A_CREDENTIALS_PATH
    deployment: { cluster: ocean, namespace: agent-vega }
```

Each resident agent must run the Channels extension with `A2A_SERVER=1`, a credentials file that includes a2astro's token, and its listener reachable from where a2astro runs. The cluster launcher port-forwards the `agent-runtime` Service when present and falls back to the Deployment for organizations without a forge-gateway Service. The agent card is fetched unauthenticated; everything else carries the bearer token, which never reaches the browser.

For the cluster launcher, `DEFAULT_AGENT` selects what `/chat` opens. An
organization with shared forge routes needs no token option. For a resident
with a dedicated local A2A bearer, pass its existing mode-0600 file explicitly:

```bash
KUBECONFIG=/home/ncrmro/.kube/config.ocean.yml \
  ORG=ncrmro AGENTS=luce DEFAULT_AGENT=ncrmro-luce \
  A2A_TOKEN_FILE=./data/a2astro-ncrmro-luce.token \
  bin/dev-cluster
```

`A2A_TOKEN_FILE` is accepted only for a single requested resident. Its contents
are neither copied nor printed.

## Where workflows come from

a2astro defines no workflows. It reads the catalog the agents themselves
resolve — `ai-outfitter/community-profiles`, or an organization catalog that
pins it — so the graph on screen is the workflow the agent was actually given.

A catalog source is either a local path (development) or a git source pinned to
a revision, the way an `Organization`'s `agentCatalogs` entry pins one:

```yaml
catalogs:
  - uri: https://github.com/ai-outfitter/community-profiles.git
    revision: v1.7.0
  - uri: git+http://host-forgejo.default.svc.cluster.local:3001/ks.systems/.agents.git
    revision: 21aeac421d5d80b7579734001540f261925e3832
    path: .            # subdirectory holding workflows/, default "."
  - ~/repos/ai-outfitter/community-profiles
```

The revision is part of the cache directory name under `<dataDir>/catalogs`, so
a pinned catalog is fetched once and a new pin is a new directory. Earlier
catalogs win a slug. A catalog that cannot be fetched is reported on
`/workflows` rather than failing the page.

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
| `POST /api/agents/:id/chat` | send a chat turn (`text`, `contextId?`, `taskId?`); `taskId` continues an interrupted task |
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
