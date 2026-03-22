import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { initDb } from "./db.ts";
import {
  createWorkflow, getWorkflow, getWorkflowByName, listWorkflows, updateWorkflow, deleteWorkflow,
  createRun, getRun, listRuns, cancelRun, advanceRun,
  getSteps, getStep, completeStep, failStep,
  getLogs, addLog, getStats,
} from "./engine.ts";

const DB_PATH = process.env.DB_PATH ?? "./loom.db";
const HOST = process.env.HOST ?? "0.0.0.0";
const AUTH_DISABLED = process.env.LOOM_AUTH === "disabled";
const LOOM_API_KEY = process.env.LOOM_API_KEY;
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN;

function envInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

const PORT = envInt(process.env.PORT, 4700);
const BODY_MAX = envInt(process.env.BODY_MAX_BYTES, 64 * 1024);

if (!LOOM_API_KEY && !AUTH_DISABLED) {
  console.error("FATAL: LOOM_API_KEY is not set.");
  console.error("  Set LOOM_API_KEY to enable auth, or");
  console.error("  set LOOM_AUTH=disabled to run without auth.");
  process.exit(1);
}

const db = initDb(DB_PATH);

// ============================================================================
// HELPERS
// ============================================================================

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function err(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

function applyCors(origin: string | undefined, res: ServerResponse) {
  if (!CORS_ALLOW_ORIGIN) return;
  if (CORS_ALLOW_ORIGIN === "*" || origin === CORS_ALLOW_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN === "*" ? "*" : origin ?? CORS_ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
  }
}

function authenticate(req: IncomingMessage): boolean {
  if (AUTH_DISABLED) return true;
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === LOOM_API_KEY;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > BODY_MAX) { done(() => { req.resume(); reject(new Error("Body too large")); }); return; }
      chunks.push(chunk);
    });
    req.on("end", () => done(() => {
      if (chunks.length === 0) { resolve({}); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString());
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { reject(new Error("Must be JSON object")); return; }
        resolve(parsed);
      } catch { reject(new Error("Invalid JSON")); }
    }));
    req.on("error", (e) => done(() => reject(e)));
  });
}

function bounded(v: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = createServer(async (req, res) => {
  applyCors(req.headers.origin, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const path = url.pathname;

    // Health -- always open
    if (path === "/health" && req.method === "GET") {
      return json(res, { status: "ok", version: "0.1.0", ...getStats(db) });
    }

    // Auth gate
    if (!authenticate(req)) return err(res, "Unauthorized", 401);

    // ---- WORKFLOWS ----
    if (path === "/workflows" && req.method === "GET") {
      return json(res, listWorkflows(db));
    }

    if (path === "/workflows" && req.method === "POST") {
      const body = await readBody(req);
      const { name, description, steps } = body as {
        name?: string; description?: string; steps?: unknown[];
      };
      if (!name || typeof name !== "string") return err(res, "name required");
      if (!steps || !Array.isArray(steps) || steps.length === 0) return err(res, "steps required (non-empty array)");
      try {
        return json(res, createWorkflow(db, name, description ?? null, steps as any), 201);
      } catch (e: any) {
        if (e.message?.includes("UNIQUE")) return err(res, "Workflow already exists", 409);
        throw e;
      }
    }

    // GET /workflows/:id
    const wfMatch = path.match(/^\/workflows\/(\d+)$/);
    if (wfMatch && req.method === "GET") {
      const wf = getWorkflow(db, parseInt(wfMatch[1], 10));
      if (!wf) return err(res, "Workflow not found", 404);
      return json(res, wf);
    }

    // PATCH /workflows/:id
    if (wfMatch && req.method === "PATCH") {
      const body = await readBody(req);
      const wf = updateWorkflow(db, parseInt(wfMatch[1], 10), body as any);
      if (!wf) return err(res, "Workflow not found", 404);
      return json(res, wf);
    }

    // DELETE /workflows/:id
    if (wfMatch && req.method === "DELETE") {
      const ok = deleteWorkflow(db, parseInt(wfMatch[1], 10));
      if (!ok) return err(res, "Workflow not found", 404);
      return json(res, { ok: true });
    }

    // ---- RUNS ----
    if (path === "/runs" && req.method === "GET") {
      const runs = listRuns(db, {
        workflow_id: url.searchParams.has("workflow_id") ? Number(url.searchParams.get("workflow_id")) : undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit: bounded(url.searchParams.get("limit"), 50, 1, 500),
      });
      return json(res, runs);
    }

    if (path === "/runs" && req.method === "POST") {
      const body = await readBody(req);
      const { workflow_id, workflow_name, input } = body as {
        workflow_id?: number; workflow_name?: string; input?: Record<string, unknown>;
      };

      let wfId = workflow_id;
      if (!wfId && workflow_name) {
        const wf = getWorkflowByName(db, workflow_name);
        if (!wf) return err(res, "Workflow not found", 404);
        wfId = wf.id;
      }
      if (!wfId) return err(res, "workflow_id or workflow_name required");

      try {
        const run = createRun(db, wfId, input ?? {});
        // Kick off execution
        advanceRun(db, run.id);
        return json(res, getRun(db, run.id), 201);
      } catch (e: any) {
        return err(res, e.message, 400);
      }
    }

    // GET /runs/:id
    const runMatch = path.match(/^\/runs\/(\d+)$/);
    if (runMatch && req.method === "GET") {
      const run = getRun(db, parseInt(runMatch[1], 10));
      if (!run) return err(res, "Run not found", 404);
      return json(res, run);
    }

    // POST /runs/:id/cancel
    const cancelMatch = path.match(/^\/runs\/(\d+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      const run = cancelRun(db, parseInt(cancelMatch[1], 10));
      if (!run) return err(res, "Run not found", 404);
      return json(res, run);
    }

    // GET /runs/:id/steps
    const stepsMatch = path.match(/^\/runs\/(\d+)\/steps$/);
    if (stepsMatch && req.method === "GET") {
      return json(res, getSteps(db, parseInt(stepsMatch[1], 10)));
    }

    // GET /runs/:id/logs
    const logsMatch = path.match(/^\/runs\/(\d+)\/logs$/);
    if (logsMatch && req.method === "GET") {
      const logs = getLogs(db, parseInt(logsMatch[1], 10), {
        step_id: url.searchParams.has("step_id") ? Number(url.searchParams.get("step_id")) : undefined,
        level: url.searchParams.get("level") ?? undefined,
        limit: bounded(url.searchParams.get("limit"), 100, 1, 1000),
      });
      return json(res, logs);
    }

    // ---- STEP CALLBACKS ----
    // POST /steps/:id/complete
    const stepCompleteMatch = path.match(/^\/steps\/(\d+)\/complete$/);
    if (stepCompleteMatch && req.method === "POST") {
      const body = await readBody(req);
      const step = completeStep(db, parseInt(stepCompleteMatch[1], 10), (body.output as Record<string, unknown>) ?? body);
      if (!step) return err(res, "Step not found", 404);
      return json(res, step);
    }

    // POST /steps/:id/fail
    const stepFailMatch = path.match(/^\/steps\/(\d+)\/fail$/);
    if (stepFailMatch && req.method === "POST") {
      const body = await readBody(req);
      const error = (body.error as string) ?? "Unknown error";
      const step = failStep(db, parseInt(stepFailMatch[1], 10), error);
      if (!step) return err(res, "Step not found", 404);
      return json(res, step);
    }

    // ---- STATS ----
    if (path === "/stats" && req.method === "GET") {
      const stats = getStats(db);
      const byStatus = db.prepare(
        "SELECT status, COUNT(*) as count FROM runs GROUP BY status ORDER BY count DESC"
      ).all();
      return json(res, { ...stats, runs_by_status: byStatus });
    }

    err(res, "Not found", 404);
  } catch (e) {
    console.error("Unhandled:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Loom running on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Auth: ${AUTH_DISABLED ? "DISABLED" : "enabled"}`);
  console.log(`CORS: ${CORS_ALLOW_ORIGIN ?? "disabled"}`);
});
