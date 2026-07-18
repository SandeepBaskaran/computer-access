/**
 * Durable job store for the build bridge.
 *
 * SQLite (better-sqlite3, same lib as db-manage) so job state survives
 * process restarts — the in-memory task map is fine for ad-hoc shell jobs
 * but bridge jobs must be recoverable across bridge/machine reboots.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import path from "path";

export type JobState = "in_progress" | "in_review" | "merged" | "failed" | "reverted" | "hold" | "cancelled" | "planning" | "planned" | "queued";

export type HoldReason = "needs_input" | "quota" | "session" | "blocked";

export interface JobRecord {
  task_id: string;
  /** Caller-supplied opaque jobId — the idempotency/dedup key. */
  job_key: string;
  repo_path: string;
  branch: string;
  worktree_path: string;
  provider: string;
  state: JobState;
  brief: string;
  verify_command: string | null;
  pr_url: string | null;
  branch_url: string | null;
  merge_commit: string | null;
  error: string | null;
  local_only: number | null;
  hold_reason: HoldReason | null;
  prev_state: string | null;
  question: string | null;
  hold_since: number | null;
  plan: string | null;
  /** Agent that produced the plan (may differ from `provider` when PLAN_FALLBACK_AGENT was used). */
  plan_provider: string | null;
  /** 1 = task marked complex: go straight to an interactive plan session when drivable. */
  plan_complex: number | null;
  /** Provider session id captured from output (enables {sessionId} resume). */
  session_id: string | null;
  /** Execution posture: "auto" (full autonomy) | "accept_edits" (supervised, questions relayed). */
  mode: string | null;
  /** Deferred work marker: "git_init" (awaiting permission) | "queued_build" | "queued_plan". */
  pending_action: string | null;
  /** Shortstat of the job branch vs the base branch, captured at review time. */
  diff_stat: string | null;
  /** How the work leaves the machine, resolved at merge time: "merge" (owned repo) | "pr" (someone else's). */
  delivery_mode: string | null;
  pid: number | null;
  last_heartbeat: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  merged_at: number | null;
  cleaned_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  task_id        TEXT PRIMARY KEY,
  job_key        TEXT UNIQUE NOT NULL,
  repo_path      TEXT NOT NULL,
  branch         TEXT NOT NULL,
  worktree_path  TEXT NOT NULL,
  provider       TEXT NOT NULL,
  state          TEXT NOT NULL,
  brief          TEXT NOT NULL,
  verify_command TEXT,
  pr_url         TEXT,
  branch_url     TEXT,
  merge_commit   TEXT,
  error          TEXT,
  local_only     INTEGER,
  hold_reason    TEXT,
  prev_state     TEXT,
  question       TEXT,
  hold_since     INTEGER,
  plan           TEXT,
  plan_provider  TEXT,
  plan_complex   INTEGER,
  session_id     TEXT,
  mode           TEXT,
  pending_action TEXT,
  diff_stat      TEXT,
  delivery_mode  TEXT,
  pid            INTEGER,
  last_heartbeat INTEGER,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER,
  merged_at      INTEGER,
  cleaned_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
`;

export class JobStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    // Pre-release schema guard: a jobs table without the job_key column
    // predates the current vocabulary and has no migration — archive it and
    // start fresh instead of failing every query with "no such column".
    const cols = this.db.prepare("SELECT name FROM pragma_table_info('jobs')").all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(c => c.name === "job_key")) {
      const archive = `jobs_legacy_${Date.now()}`;
      this.db.exec(`ALTER TABLE jobs RENAME TO ${archive}`);
      console.error(`[BRIDGE] jobs table predates the current schema — archived as ${archive}, starting fresh.`);
    }
    this.db.exec(SCHEMA);
    // Migrate columns added AFTER the job_key rename. Anything older is
    // caught by the schema guard above, so pre-rename columns need no ALTERs.
    for (const col of ["hold_reason TEXT", "prev_state TEXT", "question TEXT", "hold_since INTEGER", "plan TEXT", "plan_provider TEXT", "plan_complex INTEGER", "session_id TEXT", "mode TEXT", "pending_action TEXT", "diff_stat TEXT", "delivery_mode TEXT"]) {
      try { this.db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch { /* column already exists */ }
    }
  }

  /** On boot: anything still marked running (build OR plan) died with the previous process. */
  recoverInterrupted(): number {
    const info = this.db.prepare(
      "UPDATE jobs SET state = 'failed', error = 'bridge restarted while job was running', finished_at = ? WHERE state IN ('in_progress', 'planning')"
    ).run(Date.now());
    return info.changes;
  }

  insert(job: Omit<JobRecord, "created_at"> & { created_at?: number }): void {
    this.db.prepare(`
      INSERT INTO jobs (task_id, job_key, repo_path, branch, worktree_path, provider, state, brief,
                        verify_command, pr_url, branch_url, merge_commit, error, local_only,
                        hold_reason, prev_state, question, hold_since, plan, plan_provider, plan_complex, session_id, mode, pending_action, diff_stat, delivery_mode, pid, last_heartbeat,
                        created_at, started_at, finished_at, merged_at, cleaned_at)
      VALUES (@task_id, @job_key, @repo_path, @branch, @worktree_path, @provider, @state, @brief,
              @verify_command, @pr_url, @branch_url, @merge_commit, @error, @local_only,
              @hold_reason, @prev_state, @question, @hold_since, @plan, @plan_provider, @plan_complex, @session_id, @mode, @pending_action, @diff_stat, @delivery_mode, @pid, @last_heartbeat,
              @created_at, @started_at, @finished_at, @merged_at, @cleaned_at)
    `).run({ created_at: Date.now(), ...job });
  }

  /** After close(), stray async callbacks (child-exit handlers, sweeps) may still
   *  fire — their writes are discardable, so every method no-ops instead of throwing. */
  private get isOpen(): boolean { return this.db.open; }

  update(taskId: string, fields: Partial<JobRecord>): void {
    if (!this.isOpen) return;
    const keys = Object.keys(fields).filter(k => k !== "task_id");
    if (keys.length === 0) return;
    const setClause = keys.map(k => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE jobs SET ${setClause} WHERE task_id = @task_id`).run({ ...fields, task_id: taskId });
  }

  getByTaskId(taskId: string): JobRecord | undefined {
    if (!this.isOpen) return undefined;
    return this.db.prepare("SELECT * FROM jobs WHERE task_id = ?").get(taskId) as JobRecord | undefined;
  }

  getByJobKey(jobKey: string): JobRecord | undefined {
    if (!this.isOpen) return undefined;
    return this.db.prepare("SELECT * FROM jobs WHERE job_key = ?").get(jobKey) as JobRecord | undefined;
  }

  /** Queued jobs in FIFO order — dispatched by the sweep as capacity frees up. */
  listQueued(): JobRecord[] {
    if (!this.isOpen) return [];
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC").all() as JobRecord[];
  }

  countQueued(): number {
    if (!this.isOpen) return 0;
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'").get() as { n: number }).n;
  }

  listRecent(limit = 50): JobRecord[] {
    if (!this.isOpen) return [];
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as JobRecord[];
  }

  /** Builds and plans share the concurrency pool. */
  countRunning(): number {
    if (!this.isOpen) return 0;
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('in_progress', 'planning')").get() as { n: number }).n;
  }

  listRunning(): JobRecord[] {
    if (!this.isOpen) return [];
    return this.db.prepare("SELECT * FROM jobs WHERE state IN ('in_progress', 'planning')").all() as JobRecord[];
  }

  /** PR-delivered jobs whose branch + worktree back a still-open PR; the sweep polls the PR state and cleans on MERGED/CLOSED. */
  listPrDeliveredForCleanup(): JobRecord[] {
    if (!this.isOpen) return [];
    return this.db.prepare(
      "SELECT * FROM jobs WHERE state = 'merged' AND delivery_mode = 'pr' AND pr_url IS NOT NULL AND cleaned_at IS NULL"
    ).all() as JobRecord[];
  }

  /** Held jobs eligible for auto-retry (only transient reasons; held longer than the retry delay). */
  listHeldForRetry(heldBefore: number): JobRecord[] {
    if (!this.isOpen) return [];
    return this.db.prepare(
      "SELECT * FROM jobs WHERE state = 'hold' AND hold_reason = 'quota' AND hold_since IS NOT NULL AND hold_since < ?"
    ).all(heldBefore) as JobRecord[];
  }

  summary(): { total: number; byState: Record<string, number> } {
    if (!this.isOpen) return { total: 0, byState: {} };
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all() as Array<{ state: string; n: number }>;
    const byState: Record<string, number> = {};
    let total = 0;
    for (const r of rows) { byState[r.state] = r.n; total += r.n; }
    return { total, byState };
  }

  close(): void {
    this.db.close();
  }
}
