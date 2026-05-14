# Loom

Loom is a workflow orchestration engine for multi-agent pipelines. Define workflows as ordered sequences of steps, each assigned to an agent and action. Start runs against those workflows, then advance them step by step as agents complete their work. Loom tracks run state, step outputs, and logs throughout execution.

- **Port:** 4700
- **Stack:** Node 22, libsql (SQLite-compatible embedded database)
- **Org:** [Ghost-Frame/loom](https://github.com/Ghost-Frame/loom)

---

## What It Does

- Stores reusable workflow definitions with ordered, named steps
- Creates run instances from workflow definitions, carrying input data and metadata
- Tracks run and step state (pending, running, completed, failed, cancelled)
- Advances runs step by step as agents signal completion or failure
- Stores per-step outputs and per-run logs for full execution history

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

Without `LOOM_AUTH=disabled`, all write endpoints require `Authorization: Bearer <LOOM_API_KEY>`.

---

## Environment Variables

| Variable            | Default     | Description                                                        |
|---------------------|-------------|--------------------------------------------------------------------|
| `PORT`              | `4700`      | Port to listen on                                                  |
| `DB_PATH`           | `loom.db`   | Path to the libsql database file                                   |
| `LOOM_API_KEY`      | (none)      | Bearer token required for authenticated requests                   |
| `LOOM_AUTH`         | (required)  | Set to `disabled` to skip auth entirely (development only)         |
| `CORS_ALLOW_ORIGIN` | `*`         | Value for the `Access-Control-Allow-Origin` response header        |

---

## Concepts

- **Workflow** - a reusable template defining a sequence of steps
- **Step** (in a workflow) - a named unit of work assigned to an agent and action, with optional config
- **Run** - a single execution instance of a workflow, carrying input data
- **Step** (in a run) - a concrete instance of a workflow step, with its own state and output
- **Log** - a timestamped message attached to a run or step

A typical flow:

1. `POST /workflows` to define the pipeline once
2. `POST /runs` to start a run with input data
3. The first step is set to `running`; the assigned agent picks it up
4. Agent calls `POST /steps/:id/complete` with its output
5. `POST /runs/:id/advance` moves to the next step
6. Repeat until all steps are complete

---

## API Reference

### Health

#### `GET /health`

Returns service status.

```json
{ "status": "ok" }
```

---

### Workflows

#### `POST /workflows`

Create a workflow.

**Request**
```json
{
  "name": "PR Review Pipeline",
  "description": "Fetch PR diff, review it, post comment",
  "steps": [
    {
      "name": "fetch-diff",
      "agent": "github-agent",
      "action": "fetch_pr_diff",
      "config": { "timeout": 30 }
    },
    {
      "name": "review-code",
      "agent": "code-reviewer",
      "action": "review_diff",
      "config": { "model": "claude-sonnet-4-6" }
    },
    {
      "name": "post-comment",
      "agent": "github-agent",
      "action": "post_pr_comment",
      "config": {}
    }
  ]
}
```

**Response** `201`
```json
{
  "id": "wf_01",
  "name": "PR Review Pipeline",
  "description": "Fetch PR diff, review it, post comment",
  "steps": [
    { "id": "wfs_01", "name": "fetch-diff", "agent": "github-agent", "action": "fetch_pr_diff", "order": 0 },
    { "id": "wfs_02", "name": "review-code", "agent": "code-reviewer", "action": "review_diff", "order": 1 },
    { "id": "wfs_03", "name": "post-comment", "agent": "github-agent", "action": "post_pr_comment", "order": 2 }
  ],
  "created_at": "2026-03-22T12:00:00Z"
}
```

---

#### `GET /workflows`

List all workflows.

**Response** `200`
```json
[
  { "id": "wf_01", "name": "PR Review Pipeline", "step_count": 3, "created_at": "2026-03-22T12:00:00Z" }
]
```

---

#### `GET /workflows/:id`

Get a workflow with full step definitions.

**Response** `200` - full workflow object as shown in `POST /workflows`

---

#### `PATCH /workflows/:id`

Update a workflow's name, description, or steps.

**Request** - any subset of workflow fields

**Response** `200` - updated workflow object

---

#### `DELETE /workflows/:id`

Delete a workflow definition. Does not cancel active runs.

**Response** `200`
```json
{ "ok": true }
```

---

### Runs

#### `POST /runs`

Start a run of a workflow.

**Request**
```json
{
  "workflow_id": "wf_01",
  "input": {
    "pr_number": 42,
    "repo": "octo-org/octo-repo"
  },
  "metadata": {
    "triggered_by": "webhook",
    "user": "octocat"
  }
}
```

**Response** `201`
```json
{
  "id": "run_01",
  "workflow_id": "wf_01",
  "status": "running",
  "input": { "pr_number": 42, "repo": "octo-org/octo-repo" },
  "metadata": { "triggered_by": "webhook" },
  "current_step": 0,
  "created_at": "2026-03-22T12:00:00Z"
}
```

The first step is automatically set to `running` status when the run is created.

---

#### `GET /runs`

List runs. Filter by workflow or status.

**Query params**
- `workflow_id` - filter by workflow ID
- `status` - filter by run status (`running`, `completed`, `failed`, `cancelled`)

**Response** `200`
```json
[
  {
    "id": "run_01",
    "workflow_id": "wf_01",
    "status": "running",
    "current_step": 0,
    "created_at": "2026-03-22T12:00:00Z"
  }
]
```

---

#### `GET /runs/:id`

Get a run with all its step instances and current state.

**Response** `200`
```json
{
  "id": "run_01",
  "workflow_id": "wf_01",
  "status": "running",
  "input": { "pr_number": 42 },
  "current_step": 0,
  "steps": [
    {
      "id": "rs_01",
      "name": "fetch-diff",
      "agent": "github-agent",
      "action": "fetch_pr_diff",
      "status": "running",
      "output": null,
      "started_at": "2026-03-22T12:00:01Z",
      "completed_at": null
    },
    {
      "id": "rs_02",
      "name": "review-code",
      "agent": "code-reviewer",
      "action": "review_diff",
      "status": "pending",
      "output": null
    }
  ],
  "created_at": "2026-03-22T12:00:00Z"
}
```

---

#### `POST /runs/:id/cancel`

Cancel an active run. Sets run status to `cancelled` and any non-completed steps to `cancelled`.

**Response** `200`
```json
{ "ok": true }
```

---

#### `POST /runs/:id/advance`

Advance the run to the next step. Sets the next step's status to `running`. If there are no more steps, sets run status to `completed`.

**Response** `200`
```json
{
  "ok": true,
  "run_status": "running",
  "current_step": 1,
  "next_step": {
    "id": "rs_02",
    "name": "review-code",
    "agent": "code-reviewer",
    "action": "review_diff"
  }
}
```

When the last step completes and advance is called:
```json
{ "ok": true, "run_status": "completed", "current_step": null, "next_step": null }
```

---

### Steps

#### `GET /steps`

List step instances for a run. Requires `?run_id=` query param.

**Query params**
- `run_id` (required) - the run to list steps for

**Response** `200` - array of step objects (see `GET /runs/:id`)

---

#### `GET /steps/:id`

Get a single step instance.

**Response** `200` - step object

---

#### `POST /steps/:id/complete`

Mark a step as completed and store its output.

**Request**
```json
{
  "output": {
    "diff": "--- a/server.ts\n+++ b/server.ts\n..."
  },
  "metadata": {
    "duration_ms": 843
  }
}
```

**Response** `200`
```json
{
  "ok": true,
  "step_id": "rs_01",
  "status": "completed",
  "completed_at": "2026-03-22T12:00:05Z"
}
```

---

#### `POST /steps/:id/fail`

Mark a step as failed and store the error.

**Request**
```json
{
  "error": "GitHub API returned 404: PR not found"
}
```

**Response** `200`
```json
{
  "ok": true,
  "step_id": "rs_01",
  "status": "failed"
}
```

When a step fails, the run status is also set to `failed`.

---

### Logs

#### `GET /runs/:id/logs`

Get all logs for a run.

**Response** `200`
```json
[
  {
    "id": "log_01",
    "run_id": "run_01",
    "step_id": "rs_01",
    "level": "info",
    "message": "Fetching diff for PR #42",
    "created_at": "2026-03-22T12:00:02Z"
  }
]
```

---

#### `POST /logs`

Add a log entry to a run.

**Request**
```json
{
  "run_id": "run_01",
  "step_id": "rs_01",
  "level": "info",
  "message": "Fetching diff for PR #42"
}
```

`step_id` is optional. Accepted levels: `debug`, `info`, `warn`, `error`

**Response** `201`
```json
{ "id": "log_01", "ok": true }
```

---

### Stats

#### `GET /stats`

Returns aggregate counts.

**Response** `200`
```json
{
  "workflows": 5,
  "runs_total": 142,
  "runs_active": 3,
  "runs_completed": 130,
  "runs_failed": 9
}
```

---

## Where Loom Fits

Loom is one piece of a larger agent infrastructure. Sister services:

- [axon](https://github.com/Ghost-Frame/axon) -- pub/sub event bus
- [broca](https://github.com/Ghost-Frame/broca) -- action log and natural language narrator
- [chiasm](https://github.com/Ghost-Frame/chiasm) -- task coordination dashboard
- [soma](https://github.com/Ghost-Frame/soma) -- agent registry and heartbeats
- [thymus](https://github.com/Ghost-Frame/thymus) -- output evaluation and quality scoring

Loom runs standalone -- agents poll for steps and report completion -- and integrates with the rest of the stack via Axon events.
