# Loom

Loom runs multi-agent workflows. You define a workflow as a set of named steps with dependencies, kick off a run, and Loom advances the run by starting ready steps and waiting for their results. Some step types execute themselves (webhooks, LLM calls, data transforms). Others wait for an external agent to call back with output. Loom tracks state, retries failed steps, and emits events to Axon as runs progress.

- **Port:** 4700
- **Stack:** Node 22, libsql (SQLite-compatible embedded database)
- **Org:** [Ghost-Frame/loom](https://github.com/Ghost-Frame/loom)

---

## What It Does

- Stores reusable workflow definitions with typed steps and dependency graphs
- Creates runs from workflows, carrying input data through every step
- Advances runs automatically as steps complete or fail
- Auto-executes `action`-with-url (webhook), `llm`, and `transform` step types
- Retries failed steps up to `max_retries`, then fails the run
- Records per-step output, per-run logs, and emits events to Axon

---

## Quick Start

```bash
docker run -d \
  --name loom \
  -p 4700:4700 \
  -e LOOM_API_KEY=your-secret-key \
  -e DB_PATH=/data/loom.db \
  -v loom-data:/data \
  ghcr.io/ghost-frame/loom:latest
```

Without `LOOM_AUTH=disabled`, every endpoint except `/health` requires `Authorization: Bearer <LOOM_API_KEY>`.

---

## Environment Variables

| Variable            | Default     | Description                                                        |
|---------------------|-------------|--------------------------------------------------------------------|
| `PORT`              | `4700`      | Port to listen on                                                  |
| `HOST`              | `0.0.0.0`   | Bind address                                                       |
| `DB_PATH`           | `loom.db`   | Path to the libsql database file                                   |
| `LOOM_API_KEY`      | (none)      | Bearer token required for authenticated requests                   |
| `LOOM_AUTH`         | (required)  | Set to `disabled` to skip auth entirely (development only)         |
| `CORS_ALLOW_ORIGIN` | (none)      | Value for the `Access-Control-Allow-Origin` response header        |
| `BODY_MAX_BYTES`    | `65536`     | Maximum request body size                                          |
| `AXON_URL`          | `http://localhost:4600` | Axon endpoint to publish lifecycle events to             |
| `AXON_API_KEY`      | (none)      | Bearer token for Axon publishes                                    |

---

## Concepts

- **Workflow** -- a named template with an array of steps
- **Step (definition)** -- `{ name, type, config, depends_on, max_retries, timeout_ms }`
- **Run** -- a single execution of a workflow, carrying `input` through to `output`
- **Step (instance)** -- a concrete step record on a specific run, with its own status and output
- **Log** -- a timestamped message attached to a run, optionally scoped to one step

Step types Loom understands:

| Type        | Behavior                                                                 |
|-------------|--------------------------------------------------------------------------|
| `action`    | If `config.url` is set, Loom POSTs to that URL and completes the step with the response. Otherwise the step waits for an external agent to call `/steps/:id/complete`. |
| `webhook`   | Same external-callback semantics as a plain `action` without a URL.      |
| `llm`       | Loom calls `config.url` with the configured prompt template. Supports OpenAI-compatible endpoints and a minimal `{system, prompt, model}` shape. JSON-schema validated output is supported via `config.schema`. |
| `transform` | Reshapes data from prior step outputs into this step's output using `config.mapping`. Supports `{{var}}` interpolation and dot-path resolution. |
| `decision`, `parallel`, `wait` | Reserved types. Wait for an external agent to complete the step. |

Runs advance automatically. When you create a run, Loom starts the first ready step. When a step completes (via `/steps/:id/complete` or via auto-execution), Loom evaluates dependencies, starts every newly ready step, and finishes the run once all steps land in `completed` or `skipped`. When a step exhausts its retries, Loom fails the run and skips remaining pending steps.

---

## API Reference

### Health

#### `GET /health`

Always open. Returns version and live counts.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "workflows": 5,
  "runs": 142,
  "active_runs": 3,
  "steps": 426
}
```

---

### Workflows

#### `POST /workflows`

Create a workflow.

**Request**
```json
{
  "name": "pr-review",
  "description": "Fetch PR diff, review it, post comment",
  "steps": [
    {
      "name": "fetch",
      "type": "action",
      "config": { "url": "https://example.com/github/fetch-diff" }
    },
    {
      "name": "review",
      "type": "llm",
      "config": {
        "url": "http://localhost:4200/llm",
        "model": "claude-sonnet-4-6",
        "prompt": "Review this diff:\n{{fetch.diff}}"
      },
      "depends_on": ["fetch"]
    },
    {
      "name": "post",
      "type": "action",
      "config": { "url": "https://example.com/github/post-comment" },
      "depends_on": ["review"]
    }
  ]
}
```

Step fields: `name`, `type`, `config` are required. `depends_on` defaults to `[]`. `max_retries` defaults to `3`. `timeout_ms` defaults to `30000`.

**Response** `201` -- the stored workflow object.

Returns `409` if the workflow name already exists.

---

#### `GET /workflows`

List every workflow, ordered by name.

#### `GET /workflows/:id`

Get one workflow.

#### `PATCH /workflows/:id`

Update `description` and/or `steps`. Other fields are ignored.

#### `DELETE /workflows/:id`

Delete a workflow. Existing runs and their steps stay intact.

---

### Runs

#### `POST /runs`

Start a run. You can target the workflow by ID or by name.

**Request**
```json
{
  "workflow_id": 1,
  "input": { "pr_number": 42, "repo": "octo-org/octo-repo" }
}
```

Or:
```json
{
  "workflow_name": "pr-review",
  "input": { "pr_number": 42 }
}
```

**Response** `201` -- the run object, already advanced to whatever steps were ready at creation. Self-executing step types may already have results by the time the response returns.

---

#### `GET /runs`

List runs.

**Query params**
- `workflow_id` -- filter by workflow
- `status` -- filter by run status (`pending`, `running`, `paused`, `completed`, `failed`, `cancelled`)
- `limit` -- default `50`, max `500`

---

#### `GET /runs/:id`

Get one run. Returns `input`, `output`, `error`, status timestamps, and the workflow ID.

---

#### `POST /runs/:id/cancel`

Cancel a run. Marks any pending or running steps as `skipped` and sets the run to `cancelled`. Does nothing if the run is already terminal.

---

#### `GET /runs/:id/steps`

List every step instance for a run, ordered by creation.

```json
[
  {
    "id": 17,
    "run_id": 4,
    "name": "fetch",
    "type": "action",
    "config": { "url": "https://example.com/github/fetch-diff" },
    "status": "completed",
    "input": { "pr_number": 42 },
    "output": { "diff": "..." },
    "error": null,
    "depends_on": [],
    "retry_count": 0,
    "max_retries": 3,
    "timeout_ms": 30000,
    "started_at": "2026-03-22T12:00:01Z",
    "completed_at": "2026-03-22T12:00:04Z",
    "created_at": "2026-03-22T12:00:00Z"
  }
]
```

---

#### `GET /runs/:id/logs`

Get logs for a run.

**Query params**
- `step_id` -- restrict to one step
- `level` -- filter by level (`info`, `warn`, `error`, etc.)
- `limit` -- default `100`, max `1000`

---

### Step Callbacks

Use these from your agent when a step's type is `action` (without `config.url`), `webhook`, `decision`, `parallel`, or `wait`.

#### `POST /steps/:id/complete`

Mark a step as completed and supply its output. The body is treated as the output; if the body has a top-level `output` field, that field is used instead. Completing a step automatically advances the run.

**Request**
```json
{
  "output": { "diff": "--- a/server.ts\n+++ b/server.ts\n..." }
}
```

Or, equivalently:
```json
{ "diff": "--- a/server.ts\n+++ b/server.ts\n..." }
```

**Response** `200` -- the updated step.

---

#### `POST /steps/:id/fail`

Report failure. If the step has retries remaining, it goes back to `pending` with `retry_count` incremented and the run re-advances to pick it up. If retries are exhausted, the step is marked `failed`, the run is marked `failed`, and remaining pending steps are skipped.

**Request**
```json
{ "error": "GitHub API returned 404" }
```

---

### Stats

#### `GET /stats`

Aggregate counts plus a status breakdown.

```json
{
  "workflows": 5,
  "runs": 142,
  "active_runs": 3,
  "steps": 426,
  "runs_by_status": [
    { "status": "completed", "count": 130 },
    { "status": "failed", "count": 9 },
    { "status": "running", "count": 3 }
  ]
}
```

---

## Events

Loom publishes lifecycle events to Axon when `AXON_URL` is reachable. All events carry `source: "loom"`.

| Channel  | Type                       | Emitted when                                |
|----------|----------------------------|---------------------------------------------|
| `tasks`  | `workflow.run.created`     | A run is created                            |
| `tasks`  | `workflow.run.completed`   | All steps reach a terminal success state    |
| `tasks`  | `workflow.run.cancelled`   | A run is cancelled                          |
| `alerts` | `workflow.run.failed`      | A step exhausts retries and fails the run   |

Loom never blocks on Axon publishes. If Axon is down, events are dropped and the run continues.

---

## Where Loom Fits

Loom is one piece of a larger agent infrastructure. Sister services:

- [axon](https://github.com/Ghost-Frame/axon) -- pub/sub event bus
- [broca](https://github.com/Ghost-Frame/broca) -- action log and natural language narrator
- [chiasm](https://github.com/Ghost-Frame/chiasm) -- task coordination dashboard
- [soma](https://github.com/Ghost-Frame/soma) -- agent registry and heartbeats
- [thymus](https://github.com/Ghost-Frame/thymus) -- output evaluation and quality scoring

Loom runs standalone. Agents pick up callback-style steps by polling `/runs/:id/steps` and posting back to `/steps/:id/complete`. Wire it into the rest of the stack through Axon for fanout.
