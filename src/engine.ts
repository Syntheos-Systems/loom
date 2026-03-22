import type { Db } from "./db.ts";
import { emitEvent } from "./axon.ts";

// ============================================================================
// TYPES
// ============================================================================

export interface Workflow {
  id: number;
  name: string;
  description: string | null;
  steps: StepDef[];
  created_at: string;
  updated_at: string;
}

export interface StepDef {
  name: string;
  type: "action" | "decision" | "parallel" | "wait" | "webhook" | "llm" | "transform";
  config: Record<string, unknown>;
  depends_on?: string[];
  max_retries?: number;
  timeout_ms?: number;
}

export interface Run {
  id: number;
  workflow_id: number;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Step {
  id: number;
  run_id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  depends_on: string[];
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface RunLog {
  id: number;
  run_id: number;
  step_id: number | null;
  level: string;
  message: string;
  data: Record<string, unknown>;
  created_at: string;
}

// ============================================================================
// WORKFLOWS
// ============================================================================

export function createWorkflow(db: Db, name: string, description: string | null, steps: StepDef[]): Workflow {
  const row = db.prepare(
    "INSERT INTO workflows (name, description, steps) VALUES (?, ?, ?) RETURNING *"
  ).get(name, description, JSON.stringify(steps)) as any;
  return parseWorkflow(row);
}

export function getWorkflow(db: Db, id: number): Workflow | undefined {
  const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  return parseWorkflow(row);
}

export function getWorkflowByName(db: Db, name: string): Workflow | undefined {
  const row = db.prepare("SELECT * FROM workflows WHERE name = ?").get(name) as any;
  if (!row) return undefined;
  return parseWorkflow(row);
}

export function listWorkflows(db: Db): Workflow[] {
  const rows = db.prepare("SELECT * FROM workflows ORDER BY name").all() as any[];
  return rows.map(parseWorkflow);
}

export function updateWorkflow(db: Db, id: number, updates: { description?: string; steps?: StepDef[] }): Workflow | undefined {
  const existing = getWorkflow(db, id);
  if (!existing) return undefined;
  const row = db.prepare(
    "UPDATE workflows SET description = ?, steps = ?, updated_at = datetime('now') WHERE id = ? RETURNING *"
  ).get(
    updates.description ?? existing.description,
    updates.steps ? JSON.stringify(updates.steps) : JSON.stringify(existing.steps),
    id
  ) as any;
  return parseWorkflow(row);
}

export function deleteWorkflow(db: Db, id: number): boolean {
  return db.prepare("DELETE FROM workflows WHERE id = ?").run(id).changes > 0;
}

function parseWorkflow(row: any): Workflow {
  return { ...row, steps: JSON.parse(row.steps) };
}

// ============================================================================
// RUNS
// ============================================================================

export function createRun(db: Db, workflowId: number, input: Record<string, unknown>): Run {
  const workflow = getWorkflow(db, workflowId);
  if (!workflow) throw new Error("Workflow not found");

  const row = db.prepare(
    "INSERT INTO runs (workflow_id, input) VALUES (?, ?) RETURNING *"
  ).get(workflowId, JSON.stringify(input)) as any;

  const run = parseRun(row);

  // Create step records from workflow definition
  for (const stepDef of workflow.steps) {
    db.prepare(
      `INSERT INTO steps (run_id, name, type, config, depends_on, max_retries, timeout_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.id,
      stepDef.name,
      stepDef.type,
      JSON.stringify(stepDef.config),
      JSON.stringify(stepDef.depends_on ?? []),
      stepDef.max_retries ?? 3,
      stepDef.timeout_ms ?? 30000,
    );
  }

  addLog(db, run.id, null, "info", "Run created", { workflow: workflow.name, input });
  emitEvent("tasks", "workflow.run.created", { run_id: run.id, workflow: workflow.name, input });

  return run;
}

export function getRun(db: Db, id: number): Run | undefined {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  return parseRun(row);
}

export function listRuns(db: Db, opts: { workflow_id?: number; status?: string; limit?: number }): Run[] {
  let query = "SELECT * FROM runs WHERE 1=1";
  const params: Array<string | number> = [];

  if (opts.workflow_id) { query += " AND workflow_id = ?"; params.push(opts.workflow_id); }
  if (opts.status) { query += " AND status = ?"; params.push(opts.status); }

  query += " ORDER BY id DESC LIMIT ?";
  params.push(opts.limit ?? 50);

  return (db.prepare(query).all(...params) as any[]).map(parseRun);
}

export function cancelRun(db: Db, id: number): Run | undefined {
  const run = getRun(db, id);
  if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;

  // Cancel all pending/running steps
  db.prepare(
    "UPDATE steps SET status = 'skipped', completed_at = datetime('now') WHERE run_id = ? AND status IN ('pending', 'running')"
  ).run(id);

  const row = db.prepare(
    "UPDATE runs SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? RETURNING *"
  ).get(id) as any;

  addLog(db, id, null, "info", "Run cancelled");
  emitEvent("tasks", "workflow.run.cancelled", { run_id: id });
  return parseRun(row);
}

function parseRun(row: any): Run {
  return { ...row, input: JSON.parse(row.input), output: JSON.parse(row.output) };
}

// ============================================================================
// STEPS
// ============================================================================

export function getSteps(db: Db, runId: number): Step[] {
  return (db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY id").all(runId) as any[]).map(parseStep);
}

export function getStep(db: Db, id: number): Step | undefined {
  const row = db.prepare("SELECT * FROM steps WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  return parseStep(row);
}

export function completeStep(db: Db, stepId: number, output: Record<string, unknown>): Step | undefined {
  const row = db.prepare(
    "UPDATE steps SET status = 'completed', output = ?, completed_at = datetime('now') WHERE id = ? RETURNING *"
  ).get(JSON.stringify(output), stepId) as any;
  if (!row) return undefined;

  const step = parseStep(row);
  addLog(db, step.run_id, stepId, "info", `Step "${step.name}" completed`, output);

  // Advance the run
  advanceRun(db, step.run_id);
  return step;
}

export function failStep(db: Db, stepId: number, error: string): Step | undefined {
  const step = getStep(db, stepId);
  if (!step) return undefined;

  // Retry logic
  if (step.retry_count < step.max_retries) {
    const row = db.prepare(
      "UPDATE steps SET status = 'pending', retry_count = retry_count + 1, error = ? WHERE id = ? RETURNING *"
    ).get(error, stepId) as any;
    addLog(db, step.run_id, stepId, "warn", `Step "${step.name}" failed, retrying (${step.retry_count + 1}/${step.max_retries})`, { error });
    // Re-advance to pick up the retry
    advanceRun(db, step.run_id);
    return parseStep(row);
  }

  // Exhausted retries
  const row = db.prepare(
    "UPDATE steps SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ? RETURNING *"
  ).get(error, stepId) as any;

  addLog(db, step.run_id, stepId, "error", `Step "${step.name}" failed permanently`, { error, retries: step.retry_count });

  // Fail the run
  db.prepare(
    "UPDATE runs SET status = 'failed', error = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(`Step "${step.name}" failed: ${error}`, step.run_id);

  // Skip remaining pending steps
  db.prepare(
    "UPDATE steps SET status = 'skipped', completed_at = datetime('now') WHERE run_id = ? AND status = 'pending'"
  ).run(step.run_id);

  addLog(db, step.run_id, null, "error", "Run failed", { failed_step: step.name });
  emitEvent("alerts", "workflow.run.failed", { run_id: step.run_id, failed_step: step.name, error });

  return parseStep(row);
}

function parseStep(row: any): Step {
  return {
    ...row,
    config: JSON.parse(row.config),
    input: JSON.parse(row.input),
    output: JSON.parse(row.output),
    depends_on: JSON.parse(row.depends_on),
  };
}

// ============================================================================
// ENGINE: advance run by executing ready steps
// ============================================================================

export function advanceRun(db: Db, runId: number): void {
  const run = getRun(db, runId);
  if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;

  const steps = getSteps(db, runId);

  // If run is pending, start it
  if (run.status === "pending") {
    db.prepare("UPDATE runs SET status = 'running', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(runId);
    addLog(db, runId, null, "info", "Run started");
  }

  // Build name->status map
  const statusMap = new Map<string, string>();
  for (const s of steps) statusMap.set(s.name, s.status);

  // Find ready steps: pending + all dependencies completed
  const ready: Step[] = [];
  for (const step of steps) {
    if (step.status !== "pending") continue;
    const depsReady = step.depends_on.every(dep => statusMap.get(dep) === "completed");
    if (depsReady) ready.push(step);
  }

  // Start ready steps
  for (const step of ready) {
    db.prepare(
      "UPDATE steps SET status = 'running', started_at = datetime('now'), input = ? WHERE id = ?"
    ).run(JSON.stringify(run.input), step.id);
    addLog(db, runId, step.id, "info", `Step "${step.name}" started`);

    // Auto-execute self-running step types
    if (step.type === "action" && step.config.url) {
      executeWebhookStep(db, step);
    } else if (step.type === "llm") {
      executeLLMStep(db, step, run.input);
    } else if (step.type === "transform") {
      executeTransformStep(db, step, run.input, steps);
    }
  }

  // Check if all steps are done
  const allDone = steps.every(s => ["completed", "failed", "skipped"].includes(s.status) ||
    ready.some(r => r.id === s.id)); // just-started steps don't count as done

  // Re-check after starting
  const freshSteps = getSteps(db, runId);
  const allComplete = freshSteps.every(s => s.status === "completed" || s.status === "skipped");
  const anyFailed = freshSteps.some(s => s.status === "failed");

  if (allComplete && !anyFailed) {
    // Gather outputs from all completed steps
    const output: Record<string, unknown> = {};
    for (const s of freshSteps) {
      if (s.status === "completed" && Object.keys(s.output).length > 0) {
        output[s.name] = s.output;
      }
    }
    db.prepare(
      "UPDATE runs SET status = 'completed', output = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(output), runId);
    addLog(db, runId, null, "info", "Run completed", output);
    emitEvent("tasks", "workflow.run.completed", { run_id: runId, output });
  }
}

async function executeWebhookStep(db: Db, step: Step) {
  const url = step.config.url as string;
  const method = (step.config.method as string) || "POST";
  const timeoutMs = step.timeout_ms || 30000;

  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(step.config.headers as Record<string, string> || {}) },
      body: method !== "GET" ? JSON.stringify({ step_id: step.id, run_id: step.run_id, input: step.input, config: step.config }) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      failStep(db, step.id, `HTTP ${response.status}: ${text.slice(0, 500)}`);
      return;
    }

    const output = await response.json().catch(() => ({}));
    completeStep(db, step.id, output as Record<string, unknown>);
  } catch (err: any) {
    failStep(db, step.id, err.message || "Webhook failed");
  }
}

// ============================================================================
// LLM STEP — calls an LLM endpoint (Engram or any OpenAI-compatible API)
// config: {
//   url: string,           // e.g. http://localhost:4200/llm  OR OpenAI-compat endpoint
//   api_key?: string,
//   model?: string,
//   system?: string,       // system prompt template — {{var}} interpolation supported
//   prompt: string,        // user prompt template — {{var}} interpolation supported
//   schema?: object,       // JSON schema for structured output — injected into system prompt
//   input_map?: Record<string, string>,  // map step input keys to template vars
//   temperature?: number,
// }
// ============================================================================

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    if (val === undefined) return `{{${key}}}`;
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  });
}

function buildVars(run_input: Record<string, unknown>, step_input: Record<string, unknown>, input_map?: Record<string, string>): Record<string, unknown> {
  // Start with run input, overlay step input, then apply input_map renames
  const vars: Record<string, unknown> = { ...run_input, ...step_input };
  if (input_map) {
    for (const [alias, source] of Object.entries(input_map)) {
      if (source in vars) vars[alias] = vars[source];
    }
  }
  return vars;
}

async function executeLLMStep(db: Db, step: Step, runInput: Record<string, unknown>) {
  const cfg = step.config;
  const url = cfg.url as string;
  if (!url) { failStep(db, step.id, "llm step requires config.url"); return; }

  const vars = buildVars(runInput, step.input, cfg.input_map as Record<string, string> | undefined);
  const userPrompt = interpolate(cfg.prompt as string || "", vars);

  let systemPrompt = cfg.system ? interpolate(cfg.system as string, vars) : "You are a helpful assistant.";
  if (cfg.schema) {
    systemPrompt += `\n\nYou MUST respond with a valid JSON object matching this schema:\n${JSON.stringify(cfg.schema, null, 2)}\n\nRespond with ONLY the JSON object, no other text.`;
  }

  const timeoutMs = step.timeout_ms || 30000;
  const maxRetries = 3;

  // Try to call the LLM, with JSON parse retries if schema is set
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cfg.api_key) headers["Authorization"] = `Bearer ${cfg.api_key}`;

      // Support both Engram-style (/llm or /context) and OpenAI-compat (/v1/chat/completions)
      const isOpenAICompat = url.includes("/v1/chat") || url.includes("/chat/completions");

      let body: string;
      if (isOpenAICompat) {
        body = JSON.stringify({
          model: cfg.model || "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: cfg.temperature ?? 0.7,
        });
      } else {
        // Engram-style: POST /llm with {system, prompt, model}
        body = JSON.stringify({ system: systemPrompt, prompt: userPrompt, model: cfg.model });
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text();
        if (attempt === maxRetries) { failStep(db, step.id, `LLM HTTP ${response.status}: ${text.slice(0, 500)}`); return; }
        continue;
      }

      const data = await response.json() as any;

      // Extract text from either response format
      let text: string;
      if (isOpenAICompat) {
        text = data.choices?.[0]?.message?.content || "";
      } else {
        text = data.result || data.text || data.content || JSON.stringify(data);
      }

      // If schema defined, parse and validate JSON
      if (cfg.schema) {
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
          completeStep(db, step.id, { result: parsed, raw: text, attempt });
          return;
        } catch {
          if (attempt === maxRetries) { failStep(db, step.id, `LLM returned invalid JSON after ${maxRetries} attempts. Last response: ${text.slice(0, 500)}`); return; }
          // Retry with error feedback
          continue;
        }
      }

      completeStep(db, step.id, { result: text, attempt });
      return;
    } catch (err: any) {
      if (attempt === maxRetries) { failStep(db, step.id, err.message || "LLM step failed"); return; }
    }
  }
}

// ============================================================================
// TRANSFORM STEP — reshapes data between steps using a simple expression
// config: {
//   from?: string,         // source step name to pull output from (default: all previous step outputs)
//   mapping: Record<string, string>,  // output_key: "step_name.field.path" or literal "{{var}}"
// }
// ============================================================================

async function executeTransformStep(db: Db, step: Step, runInput: Record<string, unknown>, allSteps: Step[]) {
  const cfg = step.config;

  // Build a flat context from run input + all completed step outputs
  const ctx: Record<string, unknown> = { ...runInput };
  for (const s of allSteps) {
    if (s.status === "completed" && s.name !== step.name) {
      ctx[s.name] = s.output;
    }
  }

  const mapping = cfg.mapping as Record<string, string> | undefined;
  if (!mapping) {
    // No mapping — pass through everything
    completeStep(db, step.id, ctx);
    return;
  }

  const output: Record<string, unknown> = {};
  for (const [outKey, expr] of Object.entries(mapping)) {
    if (expr.includes("{{")) {
      // Template interpolation
      output[outKey] = interpolate(expr, ctx);
    } else {
      // Dot-path resolution: "step_name.field.nested"
      const parts = expr.split(".");
      let val: unknown = ctx;
      for (const part of parts) {
        if (val && typeof val === "object") {
          val = (val as Record<string, unknown>)[part];
        } else {
          val = undefined;
          break;
        }
      }
      output[outKey] = val;
    }
  }

  completeStep(db, step.id, output);
}

// ============================================================================
// LOGS
// ============================================================================

export function addLog(db: Db, runId: number, stepId: number | null, level: string, message: string, data: Record<string, unknown> = {}) {
  db.prepare(
    "INSERT INTO run_logs (run_id, step_id, level, message, data) VALUES (?, ?, ?, ?, ?)"
  ).run(runId, stepId, level, message, JSON.stringify(data));
}

export function getLogs(db: Db, runId: number, opts: { step_id?: number; level?: string; limit?: number }): RunLog[] {
  let query = "SELECT * FROM run_logs WHERE run_id = ?";
  const params: Array<string | number> = [runId];

  if (opts.step_id) { query += " AND step_id = ?"; params.push(opts.step_id); }
  if (opts.level) { query += " AND level = ?"; params.push(opts.level); }

  query += " ORDER BY id DESC LIMIT ?";
  params.push(opts.limit ?? 100);

  return (db.prepare(query).all(...params) as any[]).map(r => ({ ...r, data: JSON.parse((r as any).data) }));
}

// ============================================================================
// STATS
// ============================================================================

export function getStats(db: Db) {
  const workflowCount = (db.prepare("SELECT COUNT(*) as c FROM workflows").get() as any).c;
  const runCount = (db.prepare("SELECT COUNT(*) as c FROM runs").get() as any).c;
  const activeRuns = (db.prepare("SELECT COUNT(*) as c FROM runs WHERE status = 'running'").get() as any).c;
  const stepCount = (db.prepare("SELECT COUNT(*) as c FROM steps").get() as any).c;
  return { workflows: workflowCount, runs: runCount, active_runs: activeRuns, steps: stepCount };
}
