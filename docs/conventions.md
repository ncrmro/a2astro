# Conventions between a2astro and resident agents

a2astro reads only what the A2A task plane already exposes. Two small metadata
conventions turn a task into a position on a workflow graph.

## `a2astro/v1` metadata

Carried under the key `a2astro/v1` in A2A `metadata` maps.

| Field | Where | Meaning |
| --- | --- | --- |
| `workflow` | task, or first user message | Workflow slug (`workflows/<slug>/workflow.yaml`) this task executes |
| `node` | status message, history message, artifact | Workflow node id the entry is about |
| `nodeState` | same | `working`, `done`, `failed`, `skipped`; defaults to `working` on messages, `done` on artifacts |
| `jobId`, `runId` | first user message | Set by a2astro when a scheduled job dispatched the task |

Later entries win. When the task is terminal any node still `working` becomes
`done` (COMPLETED) or `failed` (anything else).

Agent side, using the Channels task tools, the cheapest faithful signal is:

1. Copy `a2astro/v1.workflow` from the inbound message onto the task metadata (the mock does this automatically; a resident Pi agent can do it with `a2a_complete_task`'s artifact metadata or by echoing it in status messages).
2. On starting a node, emit a status message with `{ node, nodeState: "working" }`.
3. On finishing a node, record an artifact with `{ node }` (defaults to `done`) or `{ node, nodeState: "failed" }`.

No metadata at all still renders: position is inferred from the A2A state.

## `outfitter-task/v1` extension

a2astro declares the [outfitter-task/v1](https://github.com/ai-outfitter/channels/blob/main/docs/extensions/outfitter-task.v1.schema.json) extension on every message it sends and fills `ticketRunId` with the a2astro run id, so one calendar run can be correlated with tasks across several agents or servers. Idempotency uses the message id `a2astro-<runId>` in scope `a2astro`, so a retried dispatch returns the same task.

## Deployment shape

The agent-operator `Agent` resource does not model an A2A listener. Expose it the same way the Vega reference deployment exposes its relay: set `A2A_SERVER=1`, `A2A_HOST=0.0.0.0`, `A2A_PORT`, `A2A_PUBLIC_URL`, and `A2A_CREDENTIALS_PATH` through the agent's projected Secret/ConfigMap, then add a Service (NodePort or ingress) in the agent's namespace. a2astro needs one credential per agent with a principal of its own (e.g. `a2astro`).
