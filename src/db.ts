import Database from "libsql";

export function initDb(path: string): InstanceType<typeof Database> {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    -- Workflow definitions: reusable templates
    CREATE TABLE IF NOT EXISTS workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      steps TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Runs: instances of workflow execution
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL REFERENCES workflows(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','completed','failed','cancelled')),
      input TEXT NOT NULL DEFAULT '{}',
      output TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);

    -- Steps: individual units of work within a run
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('action','decision','parallel','wait','webhook','llm','transform')),
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
      input TEXT NOT NULL DEFAULT '{}',
      output TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      depends_on TEXT NOT NULL DEFAULT '[]',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      timeout_ms INTEGER NOT NULL DEFAULT 30000,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
    CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);

    -- Run logs: audit trail for everything that happens
    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      step_id INTEGER REFERENCES steps(id),
      level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug','info','warn','error')),
      message TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_logs_run ON run_logs(run_id, created_at);
  `);

  return db;
}

export type Db = InstanceType<typeof Database>;
