/**
 * Build Board bridge — task orchestration on top of the existing MCP server.
 *
 * Three operations drive the whole board lifecycle:
 *   startTask     — async dispatch of a coding-agent CLI in an isolated worktree
 *   getJobStatus  — durable job state + log excerpt for board comments
 *   mergeTask     — gated --no-ff merge to main (or single-task revert)
 *
 * Dependency-injected (isPathAllowed comes from server.ts) so the smoke test
 * can drive it directly without ngrok/express.
 */
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { readFile, stat, rm, readdir, copyFile, truncate as ftruncate } from "fs/promises";
import path from "path";
import os from "os";
import { JobStore, JobRecord, JobState, HoldReason } from "./jobs.js";
import { ProviderRegistry, ProviderEntry, PlanMode, loadProviders, resolveProvider, buildProviderArgs, usableProviders, isStub, planModeOf } from "./providers.js";
import { spawnPty, PtyHandle } from "./pty.js";
import { PowerAssertion } from "./power.js";
import { WakeDetector } from "./wake.js";
import { BoardClient, BoardCard } from "./notion.js";

const execFileP = promisify(execFile);

export interface BridgeConfig {
  dataDir: string;
  registryPath: string;
  worktreeRoot: string;
  defaultProvider: string;
  maxConcurrentJobs: number;
  heartbeatTimeoutMs: number;
  jobMaxRuntimeMs: number;
  revertWindowHours: number;
  /** Max wall-clock for a read-only plan-task run. */
  planTimeoutMs: number;
  /** Delay before a hold(quota) job is auto-retried by the sweep. */
  holdRetryMs: number;
  /** Last-resort planner, used only when a provider's own plan mode can't be driven ("" disables fallback). */
  planFallbackAgent: string;
  /** One-shot plans shorter than this escalate to an interactive session (when the provider supports one). */
  planMinChars: number;
  /** An interactive plan session silent this long is inspected: trailing question → hold(needs_input); otherwise the transcript becomes the plan. */
  planIdleMs: number;
  /** Recovery policy for jobs whose process died: resume (provider session) | rerun (original brief) | rework (fail with note). */
  resumeStrategy: "resume" | "rerun" | "rework";
  /** Board self-scan interval while awake (0/absent boardClient disables). */
  selfScanIntervalMs: number;
  /** Wall-clock gap treated as a wake from sleep. */
  wakeGapMs: number;
  /** Bridge's own board access for self-scan (cloud agent stays the redundant path). */
  boardClient?: BoardClient;
  /** Default execution posture when a card has no Mode set. */
  defaultMode?: "auto" | "accept_edits";
  /** User-authorized dependency installs inside allowlisted repos (default true). */
  allowPackageInstalls?: boolean;
  /** board-map.json content: property/option names the bridge writes — never hard-coded in logic. */
  boardMap?: BoardMap;
  /** Data source id stamped onto each job so writebacks target the right board. */
  boardId?: string;
  /** Verifies the public tunnel (e.g. ngrok local API); bridge only reports/logs — KeepAlive restarts the tunnel service. */
  tunnelCheck?: () => Promise<{ up: boolean; url?: string }>;
  /** Break-glass switch: when true, merge/revert refuse outright. */
  confirmationGateEnabled: () => boolean;
  isPathAllowed: (p: string) => Promise<boolean>;
}

export interface StartTaskParams {
  taskId: string;
  pageId: string;
  repoPath: string;
  brief: string;
  codingAgent?: string;
  verifyCommand?: string;
  /** Execution posture from the card's Mode select (default: DEFAULT_MODE, "auto"). */
  mode?: TaskMode;
}

const ERROR_CAP = 8 * 1024;
const EXCERPT_LINES = 50;
const HEARTBEAT_DB_THROTTLE_MS = 2000;

export type TaskMode = "auto" | "accept_edits";

/** Names the bridge writes to the board — resolved from board-map.json, never hard-coded. */
export interface BoardMap {
  statusOptions: {
    todo: string; planning: string; ready_for_dev: string; in_progress: string;
    in_review: string; rework: string; hold: string; approved: string; merged: string; failed: string;
  };
  modeOptions: { auto: string; accept_edits: string };
}

export const DEFAULT_BOARD_MAP: BoardMap = {
  statusOptions: {
    todo: "Todo", planning: "Planning", ready_for_dev: "Ready for Dev", in_progress: "In Progress",
    in_review: "In Review", rework: "Rework", hold: "Hold", approved: "Approved", merged: "Merged", failed: "Failed",
  },
  modeOptions: { auto: "Auto approve", accept_edits: "Accept edits" },
};

/** User-authorized package installs: the only thing gated is the PATTERN, and only when the user opts out. */
const INSTALL_RE = /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bcargo\s+(install|add)\b|\bbrew\s+install\b|\bgem\s+install\b|\bpoetry\s+add\b|\buv\s+(pip\s+install|add)\b/i;

export function slugifyTaskId(taskId: string): string {
  const slug = taskId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!slug) throw new Error(`taskId '${taskId}' contains no usable characters`);
  return slug;
}

async function git(repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileP("git", args, { cwd: repoDir, timeout: 60000 });
}

async function detectMainBranch(repoDir: string): Promise<string> {
  try {
    const { stdout } = await git(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const m = stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch { /* no origin HEAD */ }
  for (const candidate of ["main", "master"]) {
    try { await git(repoDir, ["rev-parse", "--verify", candidate]); return candidate; } catch { /* try next */ }
  }
  throw new Error("Could not find a 'main' or 'master' branch in the repository");
}

async function hasOrigin(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoDir, ["remote", "get-url", "origin"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** git@github.com:o/r.git | https://github.com/o/r(.git) → https://github.com/o/r */
export function originToWebUrl(originUrl: string): string | null {
  let m = originUrl.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = originUrl.match(/^https?:\/\/(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}`;
  return null;
}

async function isWorkingTreeClean(repoDir: string): Promise<boolean> {
  const { stdout } = await git(repoDir, ["status", "--porcelain"]);
  return stdout.trim() === "";
}

function truncate(s: string, cap = ERROR_CAP): string {
  return s.length > cap ? `…(truncated)…\n${s.slice(-cap)}` : s;
}

/**
 * Classify provider output into a hold reason. Heuristic by design — CLIs
 * don't emit structured errors — so patterns are deliberately conservative.
 */
export function classifyHold(output: string): { reason: HoldReason; question: string | null } | null {
  if (/rate[ -]?limit|quota|usage limit|too many requests|\b429\b|overloaded/i.test(output)) {
    return { reason: "quota", question: null };
  }
  if (/session expired|not logged in|please (log|sign) in|log in again|unauthorized|\b401\b|authentication (failed|required)|invalid api key|credentials/i.test(output)) {
    return { reason: "session", question: null };
  }
  const lines = output.trim().split("\n").map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  if (lastLine.endsWith("?") || /\b(input required|awaiting (your )?(response|input)|need (more|additional) (information|input|details))\b/i.test(output)) {
    const question = lines.filter(l => l.endsWith("?")).pop() ?? lastLine;
    return { reason: "needs_input", question: truncate(question, 500) };
  }
  return null;
}

export function createBridge(cfg: BridgeConfig) {
  const boardMap = cfg.boardMap ?? DEFAULT_BOARD_MAP;
  const defaultMode: TaskMode = cfg.defaultMode ?? "auto";
  const allowPackageInstalls = cfg.allowPackageInstalls ?? true;
  const logsDir = path.join(cfg.dataDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const store = new JobStore(path.join(cfg.dataDir, "jobs.sqlite"));

  let registry: ProviderRegistry = new Map();
  const registryReady = loadProviders(cfg.registryPath).then(r => { registry = r; });
  // Boot recovery is smart, not blanket-fail: alive orphans reattach, dead
  // ones follow RESUME_STRATEGY (see recoverJobs below).
  registryReady.then(() => recoverJobs("boot")).catch(e => console.error("[RECOVERY] boot recovery error:", e.message));

  const logPath = (taskId: string) => path.join(logsDir, `${taskId}.log`);

  async function readLogExcerpt(taskId: string): Promise<string> {
    try {
      const raw = await readFile(logPath(taskId), "utf-8");
      const lines = raw.split("\n");
      return truncate(lines.slice(-EXCERPT_LINES).join("\n"), 4000);
    } catch {
      return "(no log output)";
    }
  }

  function isCancelled(taskId: string): boolean {
    return store.getByTaskId(taskId)?.state === "cancelled";
  }

  function fail(taskId: string, reason: string, outputTail?: string): void {
    if (isCancelled(taskId)) return; // a cancel mid-run wins over any late failure
    store.update(taskId, {
      state: "failed",
      error: truncate(outputTail ? `${reason}\n---\n${outputTail}` : reason),
      finished_at: Date.now(),
      pid: null,
    });
  }

  /** Park a job in hold with the reason surfaced; prev_state enables resume. */
  function hold(taskId: string, reason: HoldReason, prevState: string, error: string, question: string | null = null, extra: Partial<JobRecord> = {}): void {
    if (isCancelled(taskId)) return;
    store.update(taskId, {
      state: "hold",
      hold_reason: reason,
      prev_state: prevState,
      question,
      hold_since: Date.now(),
      error: truncate(error),
      pid: null,
      ...extra,
    });
  }

  /**
   * Validate a repo path BEFORE any work: must exist, be a directory, be a
   * git repository, and sit inside ALLOWED_DIRS. Returns the exact reason on
   * failure — never guesses a path.
   */
  async function validateRepo(repoPath: string): Promise<{ ok: true; repo: string } | { ok: false; reason: string }> {
    const repo = path.resolve(repoPath);
    const s = await stat(repo).catch(() => null);
    if (!s) return { ok: false, reason: `path does not exist: ${repo}` };
    if (!s.isDirectory()) return { ok: false, reason: `path is not a directory: ${repo}` };
    if (!(await cfg.isPathAllowed(repo))) return { ok: false, reason: `path is outside ALLOWED_DIRS: ${repo}` };
    const g = await stat(path.join(repo, ".git")).catch(() => null);
    if (!g) return { ok: false, reason: `not a git repository (no .git): ${repo}` };
    return { ok: true, repo };
  }

  function killJobProcess(pid: number): void {
    try { process.kill(-pid, "SIGTERM"); } catch {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
  }

  async function jobStatusPayload(job: JobRecord, withExcerpt: boolean) {
    return {
      taskId: job.task_id,
      pageId: job.page_id,
      state: job.state,
      provider: job.provider,
      mode: job.mode,
      repoPath: job.repo_path,
      branch: job.branch,
      worktree: job.worktree_path,
      prUrl: job.pr_url,
      branchUrl: job.branch_url,
      localOnly: job.local_only === 1,
      mergeCommit: job.merge_commit,
      error: job.error,
      holdReason: job.hold_reason,
      prevState: job.prev_state,
      question: job.question,
      holdSince: job.hold_since ? new Date(job.hold_since).toISOString() : null,
      // Plan results ride along on planned jobs; needsInput flags a pending question.
      ...(job.state === "planned" ? { plan: job.plan, needsInput: !!job.question } : {}),
      ...(job.plan_provider ? { planProvider: job.plan_provider } : {}),
      lastHeartbeat: job.last_heartbeat ? new Date(job.last_heartbeat).toISOString() : null,
      createdAt: new Date(job.created_at).toISOString(),
      startedAt: job.started_at ? new Date(job.started_at).toISOString() : null,
      finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
      mergedAt: job.merged_at ? new Date(job.merged_at).toISOString() : null,
      ...(withExcerpt ? { logExcerpt: await readLogExcerpt(job.task_id) } : {}),
    };
  }

  /** Resolve verifyCommand: explicit param > .buildboard.json in the worktree > skip. */
  async function resolveVerifyCommand(job: JobRecord): Promise<string | null> {
    if (job.verify_command) return job.verify_command;
    try {
      const raw = await readFile(path.join(job.worktree_path, ".buildboard.json"), "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.verifyCommand === "string" && parsed.verifyCommand.trim()) return parsed.verifyCommand;
    } catch { /* no per-repo config */ }
    return null;
  }

  /** Run a child process, streaming both stdout and stderr to the job log and bumping the heartbeat on every chunk. */
  function runLogged(job: JobRecord, command: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; stdinData?: string; logFile?: string; freshLog?: boolean }): Promise<{ code: number | null }> {
    return new Promise((resolve, reject) => {
      const logStream = createWriteStream(opts.logFile ?? logPath(job.task_id), { flags: opts.freshLog ? "w" : "a" });
      const proc = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true });
      store.update(job.task_id, { pid: proc.pid ?? null, last_heartbeat: Date.now() });

      let lastDbBump = Date.now();
      const onChunk = (chunk: Buffer) => {
        logStream.write(chunk);
        const now = Date.now();
        // Heartbeat on BOTH streams — many coding CLIs report progress on stderr only.
        if (now - lastDbBump > HEARTBEAT_DB_THROTTLE_MS) {
          lastDbBump = now;
          store.update(job.task_id, { last_heartbeat: now });
        }
      };
      proc.stdout.on("data", onChunk);
      proc.stderr.on("data", onChunk);

      if (opts.stdinData !== undefined) proc.stdin.write(opts.stdinData);
      proc.stdin.end();

      proc.on("error", (e) => {
        logStream.end();
        reject(new Error(`spawn failed: ${e.message}`));
      });
      proc.on("close", (code) => {
        store.update(job.task_id, { last_heartbeat: Date.now() });
        logStream.end();
        resolve({ code });
      });
    });
  }

  /** Jobs whose child process THIS bridge instance owns (used to skip recovery for sleep-frozen jobs). */
  const activeRuns = new Set<string>();

  /** Capture the provider's session id from its output when the registry declares a regex. */
  async function captureSessionId(taskId: string, entry: ProviderEntry): Promise<void> {
    if (!entry.sessionIdRegex) return;
    try {
      const raw = await readFile(logPath(taskId), "utf-8");
      const m = raw.match(new RegExp(entry.sessionIdRegex));
      if (m?.[1]) store.update(taskId, { session_id: m[1] });
    } catch { /* no log yet */ }
  }

  function resumeNudge(job: JobRecord): string {
    return `The previous run was interrupted before completing. Continue where you left off on this task: ${job.brief}`;
  }

  /** Background continuation after startTask returns — every outcome maps to a terminal state.
   *  opts.resume relaunches the provider's prior session (dead-job recovery). */
  async function runJob(taskId: string, opts: { resume?: boolean } = {}): Promise<void> {
    const job = store.getByTaskId(taskId);
    if (!job) return;
    const provider = resolveProvider(registry, job.provider, cfg.defaultProvider);
    // Mode routing: Accept edits → supervised pty session with question relay.
    if (!opts.resume && job.mode === "accept_edits") {
      if (provider.entry.acceptEditsArgs?.length) {
        await runSupervisedBuild(taskId, provider);
        return;
      }
      console.error(`[MODE] ${taskId}: provider '${provider.name}' declares no acceptEditsArgs — falling back to auto posture`);
    }
    activeRuns.add(taskId);
    try {
      // 1. Provider CLI. The brief travels VERBATIM as one argv element (or raw
      // stdin) — never through a shell, never expanded with repo/external
      // content: builds run permission-skipped, so the brief and everything in
      // the repo are treated as untrusted input.
      const args = opts.resume && provider.entry.resumeArgsTemplate?.length
        ? provider.entry.resumeArgsTemplate.map(a => a
            .replaceAll("{nudge}", resumeNudge(job))
            .replaceAll("{brief}", job.brief)
            .replaceAll("{workspace}", job.worktree_path)
            .replaceAll("{sessionId}", job.session_id ?? ""))
        : buildProviderArgs(provider.entry, "build", job.brief, job.worktree_path);
      const cwd = provider.entry.cwd ? path.resolve(job.worktree_path, provider.entry.cwd) : job.worktree_path;
      const env = { ...process.env, ...provider.entry.env };
      let result: { code: number | null };
      try {
        result = await runLogged(job, provider.entry.command, args, {
          cwd, env,
          stdinData: provider.entry.promptVia === "stdin" ? (opts.resume ? resumeNudge(job) : job.brief) : undefined,
        });
      } catch (e: any) {
        // ENOENT / bad command — fails immediately, never strands in in_progress
        fail(taskId, `Provider '${provider.name}' could not be started: ${e.message}`);
        return;
      }
      await captureSessionId(taskId, provider.entry);
      if (result.code !== 0) {
        const excerpt = await readLogExcerpt(taskId);
        // Transient/interactive failures park in hold instead of failed:
        // quota holds auto-retry via the sweep; session/needs_input wait for a human.
        const classified = classifyHold(excerpt);
        if (classified) {
          hold(taskId, classified.reason, "in_progress", `Provider '${provider.name}' exited with code ${result.code} (${classified.reason})\n---\n${excerpt}`, classified.question);
          return;
        }
        fail(taskId, `Provider '${provider.name}' exited with code ${result.code}`, excerpt);
        return;
      }
      await finishBuild(taskId);
    } finally {
      activeRuns.delete(taskId);
      updatePower();
    }
  }

  /**
   * SUPERVISED build (Mode: Accept edits): the provider runs in its
   * accept-edits posture under a pty. Edits auto-apply; when the CLI pauses on
   * a higher-risk action (shell/install/delete/network) its question is
   * relayed to the board via hold(needs_input) and answer-task feeds the reply
   * back into the live session. Builds finish ONLY on process exit — idle
   * without a question just keeps waiting (the stale sweep is the backstop).
   */
  async function runSupervisedBuild(taskId: string, provider: { name: string; entry: ProviderEntry }): Promise<void> {
    const job = store.getByTaskId(taskId)!;
    const args = (provider.entry.acceptEditsArgs ?? []).map(a =>
      a.replaceAll("{brief}", job.brief).replaceAll("{workspace}", job.worktree_path));
    let ptyH: PtyHandle;
    try {
      ptyH = await spawnPty(provider.entry.command, args, {
        cwd: job.worktree_path, env: { ...process.env, ...provider.entry.env },
      });
    } catch (e: any) {
      fail(taskId, `Supervised (accept_edits) session for '${provider.name}' could not be started: ${e.message}`);
      return;
    }
    const logStream = createWriteStream(logPath(taskId), { flags: "a" });
    const session: PlanSession = { kind: "build", pty: ptyH, transcript: "", idleTimer: null, finished: false, arm: () => {} };
    session.arm = () => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(onIdle, cfg.planIdleMs);
    };
    activePlanSessions.set(taskId, session);
    store.update(taskId, { pid: ptyH.pid ?? null, last_heartbeat: Date.now() });

    const onIdle = () => {
      if (session.finished) return;
      const j = store.getByTaskId(taskId);
      if (!j || j.state !== "in_progress") return; // held or cancelled — answer-task re-arms
      const lines = stripAnsi(session.transcript).split("\n").map(l => l.trim()).filter(Boolean);
      const q = [...lines.slice(-6)].reverse().find(l => l.endsWith("?"));
      if (q) {
        // Higher-risk action paused the CLI — relay the exact prompt to the board.
        hold(taskId, "needs_input", "in_progress", "Supervised build is waiting for approval/input", truncate(q, 500));
      } else {
        session.arm(); // builds complete on EXIT, never on idle
      }
    };

    let lastDbBump = Date.now();
    ptyH.onData((chunk) => {
      session.transcript += chunk;
      if (session.transcript.length > 128 * 1024) session.transcript = session.transcript.slice(-128 * 1024);
      logStream.write(chunk);
      const now = Date.now();
      if (now - lastDbBump > HEARTBEAT_DB_THROTTLE_MS) { lastDbBump = now; store.update(taskId, { last_heartbeat: now }); }
      if (store.getByTaskId(taskId)?.state === "in_progress") session.arm();
    });
    ptyH.onExit((code) => {
      if (session.finished) return;
      session.finished = true;
      if (session.idleTimer) clearTimeout(session.idleTimer);
      logStream.end();
      activePlanSessions.delete(taskId);
      const j = store.getByTaskId(taskId);
      if (!j || isCancelled(taskId)) return;
      if (j.state === "hold") return; // died while waiting — answer-task re-runs cleanly
      const text = stripAnsi(session.transcript);
      if (code !== 0) {
        const classified = classifyHold(text);
        if (classified) { hold(taskId, classified.reason, "in_progress", `Supervised build exited with code ${code} (${classified.reason})`, classified.question); return; }
        fail(taskId, `Supervised build exited with code ${code}`, truncate(text, 4000));
        return;
      }
      captureSessionId(taskId, provider.entry)
        .then(() => finishBuild(taskId))
        .catch((e: any) => fail(taskId, `finish after supervised build failed: ${e.message}`));
    });
    session.arm();
  }

  /** Post-provider pipeline: verify → commit → empty-diff guard → push/PR → in_review.
   *  Separate from runJob so a REATTACHED job (provider survived a bridge restart)
   *  can finish the same way once its process exits. */
  async function finishBuild(taskId: string): Promise<void> {
    const job = store.getByTaskId(taskId);
    if (!job || isCancelled(taskId)) return;

    // 2. Verify (param > .buildboard.json > skip)
    const verifyCmd = await resolveVerifyCommand(job);
    // User-authorized installs: permitted by design inside allowlisted repos.
    // Only when the user opts OUT (ALLOW_PACKAGE_INSTALLS=false) are install
    // commands refused — and only here, on a validated repo path.
    if (verifyCmd && INSTALL_RE.test(verifyCmd) && !allowPackageInstalls) {
      fail(taskId, `verifyCommand refused: package installs are disabled (ALLOW_PACKAGE_INSTALLS=false): ${verifyCmd}`);
      return;
    }
    if (verifyCmd) {
      const vres = await runLogged(job, "bash", ["-c", verifyCmd], { cwd: job.worktree_path }).catch((e: any) => {
        fail(taskId, `Verify command could not be started: ${e.message}`);
        return null;
      });
      if (!vres) return;
      if (vres.code !== 0) {
        // Preserve the work locally (committed, not pushed) so Rework can continue from it.
        try {
          await git(job.worktree_path, ["add", "-A"]);
          if (!(await isWorkingTreeClean(job.worktree_path))) {
            await git(job.worktree_path, ["commit", "-m", commitMessage(job)]);
          }
        } catch { /* commit is best-effort on the failure path */ }
        fail(taskId, `Verify command failed (exit ${vres.code}): ${verifyCmd}`, await readLogExcerpt(taskId));
        return;
      }
    }

    // 3. Commit — but only when there is a real diff.
    try {
      await git(job.worktree_path, ["add", "-A"]);
      if (!(await isWorkingTreeClean(job.worktree_path))) {
        await git(job.worktree_path, ["commit", "-m", commitMessage(job)]);
      }
    } catch (e: any) {
      fail(taskId, `Commit failed: ${e.stderr || e.message}`);
      return;
    }

    // Empty diff after the build → nothing to review; flag it, don't push.
    const baseBranch = await detectMainBranch(job.worktree_path).catch(() => null);
    if (baseBranch) {
      const { stdout: aheadOut } = await git(job.worktree_path, ["rev-list", "--count", `${baseBranch}..${job.branch}`]).catch(() => ({ stdout: "" } as any));
      if (aheadOut.trim() === "0") {
        fail(taskId, `no changes: the build produced an empty diff (no commits ahead of ${baseBranch}). The agent should flag this on the board.`);
        return;
      }
    }

    // 4. Push + PR (graceful when the repo has no origin)
    let prUrl: string | null = null;
    let branchUrl: string | null = null;
    let localOnly = false;
    const origin = await hasOrigin(job.worktree_path);
    if (origin) {
      try {
        await git(job.worktree_path, ["push", "-u", "origin", job.branch]);
      } catch (e: any) {
        // Never a silent success: park in hold with the exact push error;
        // the commit stays local and the job is flagged localOnly.
        hold(taskId, "blocked", "in_progress",
          `Push of ${job.branch} failed (protected branch / non-fast-forward / auth?): ${truncate(e.stderr || e.message, 2000)}`,
          null, { local_only: 1, finished_at: Date.now() });
        return;
      }
      // PR creation must never fail the task.
      try {
        const { stdout } = await execFileP("gh", ["pr", "create", "--head", job.branch, "--title", commitMessage(job), "--body", job.brief], { cwd: job.worktree_path, timeout: 30000 });
        prUrl = stdout.trim().split("\n").pop() || null;
      } catch {
        const webUrl = originToWebUrl(origin);
        if (webUrl) {
          const base = await detectMainBranch(job.worktree_path).catch(() => "main");
          branchUrl = `${webUrl}/compare/${base}...${job.branch}`;
        }
      }
      if (prUrl) branchUrl = prUrl;
    } else {
      localOnly = true;
    }

    if (isCancelled(taskId)) return; // cancel arrived while pushing — don't resurrect
    store.update(taskId, {
      state: "in_review",
      pr_url: prUrl,
      branch_url: branchUrl,
      local_only: localOnly ? 1 : 0,
      error: null,
      hold_reason: null, prev_state: null, question: null, hold_since: null,
      finished_at: Date.now(),
      pid: null,
    });
  }

  function commitMessage(job: JobRecord): string {
    const summary = job.brief.replace(/\s+/g, " ").trim().slice(0, 60);
    return `task/${job.task_id}: ${summary}`;
  }

  async function ensureWorktree(job: { repo_path: string; branch: string; worktree_path: string }, baseBranch: string, reuseExistingBranch: boolean): Promise<void> {
    mkdirSync(path.dirname(job.worktree_path), { recursive: true });
    if (existsSync(job.worktree_path)) return;
    await git(job.repo_path, ["worktree", "prune"]).catch(() => {});
    const branchExists = await git(job.repo_path, ["rev-parse", "--verify", job.branch]).then(() => true).catch(() => false);
    if (branchExists) {
      if (!reuseExistingBranch) {
        throw new Error(`Branch '${job.branch}' already exists in ${job.repo_path} but no bridge job owns it. Delete or rename it, or use a different taskId.`);
      }
      await git(job.repo_path, ["worktree", "add", job.worktree_path, job.branch]);
    } else {
      // Always branch off the repo's main branch, not whatever happens to be checked out.
      await git(job.repo_path, ["worktree", "add", job.worktree_path, "-b", job.branch, baseBranch]);
    }
  }

  async function startTask(params: StartTaskParams): Promise<any> {
    await registryReady;
    const { pageId, repoPath, brief } = params;
    if (!params.taskId?.trim() || !pageId?.trim() || !repoPath?.trim() || !brief?.trim()) {
      throw new Error("taskId, pageId, repoPath, and brief are all required");
    }
    const taskId = slugifyTaskId(params.taskId);
    const provider = resolveProvider(registry, params.codingAgent, cfg.defaultProvider);

    // Repo validation BEFORE any work — exact reason, never a guessed path.
    const repoCheck = await validateRepo(repoPath);
    if (!repoCheck.ok) return { error: "invalidRepo", reason: repoCheck.reason };
    const repo = repoCheck.repo;

    // Idempotency — page_id is the dedup key. A plan-only row created without a
    // pageId carries the placeholder `plan-<taskId>`; the build adopts it.
    let existing = store.getByPageId(pageId);
    const byTaskId = store.getByTaskId(taskId);
    if (!existing && byTaskId) {
      if (byTaskId.page_id === `plan-${taskId}`) existing = byTaskId;
      else throw new Error(`taskId '${taskId}' is already used by a different board page (${byTaskId.page_id}). Task IDs must be unique.`);
    } else if (existing && byTaskId && byTaskId.page_id !== pageId) {
      throw new Error(`taskId '${taskId}' is already used by a different board page (${byTaskId.page_id}). Task IDs must be unique.`);
    }
    if (existing && existing.state === "in_progress") {
      return { alreadyRunning: true, ...(await jobStatusPayload(existing, false)) };
    }
    if (existing && existing.state === "planning") {
      return { error: "planningInProgress", message: `Task '${existing.task_id}' has a plan run in progress — wait for state 'planned' before building.` };
    }
    if (existing && (existing.state === "merged" || existing.state === "reverted")) {
      throw new Error(`Task '${existing.task_id}' is already ${existing.state}. Create a new board task for follow-up work.`);
    }

    // Concurrency cap — the agent retries on its next wake.
    if (store.countRunning() >= cfg.maxConcurrentJobs) {
      return { error: "capacityExceeded", running: store.countRunning(), maxConcurrentJobs: cfg.maxConcurrentJobs, message: "Concurrency cap reached — retry on the next agent wake." };
    }

    const branch = `task/${taskId}`;
    // A row with no worktree yet is plan-only history — the build starts fresh
    // from the base branch. A row with a worktree is build Rework: reuse it.
    const hadBuild = !!existing && existing.worktree_path !== "";
    const worktree = (hadBuild && existing!.worktree_path) || path.join(cfg.worktreeRoot, taskId);
    const baseBranch = await detectMainBranch(repo);
    await ensureWorktree({ repo_path: repo, branch, worktree_path: worktree }, baseBranch, hadBuild);

    const mode: TaskMode = params.mode === "accept_edits" ? "accept_edits" : params.mode === "auto" ? "auto" : defaultMode;
    const now = Date.now();
    if (existing) {
      store.update(existing.task_id, {
        state: "in_progress", brief, provider: provider.name,
        page_id: pageId, repo_path: repo, branch, worktree_path: worktree,
        verify_command: params.verifyCommand ?? existing.verify_command,
        mode, board_id: existing.board_id ?? cfg.boardId ?? null,
        error: null, hold_reason: null, prev_state: null, question: null, hold_since: null,
        started_at: now, finished_at: null, last_heartbeat: now,
      });
    } else {
      store.insert({
        task_id: taskId, page_id: pageId, repo_path: repo, branch, worktree_path: worktree,
        provider: provider.name, state: "in_progress", brief,
        verify_command: params.verifyCommand ?? null,
        mode, board_id: cfg.boardId ?? null,
        pr_url: null, branch_url: null, merge_commit: null, error: null, local_only: null, plan: null, plan_provider: null, plan_complex: null, session_id: null,
        hold_reason: null, prev_state: null, question: null, hold_since: null,
        pid: null, last_heartbeat: now, started_at: now, finished_at: null, merged_at: null, cleaned_at: null,
      });
    }

    const effectiveTaskId = existing?.task_id ?? taskId;
    // Fire and forget — the SSE call returns immediately; runJob owns every outcome.
    runJob(effectiveTaskId).catch((e: any) => fail(effectiveTaskId, `Internal bridge error: ${e.message}`));
    updatePower(); // job active → hold the sleep assertion immediately

    return {
      taskId: effectiveTaskId, state: "in_progress", branch, worktree,
      provider: provider.name, mode, rework: hadBuild, logPath: logPath(effectiveTaskId),
    };
  }

  const planLogPath = (taskId: string) => path.join(logsDir, `plan-${taskId}.log`);

  // ── Plan pipeline: headless where possible, pty-driven interactive where
  //    not, PLAN_FALLBACK_AGENT only when a plan mode can't be driven at all.
  const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;
  const stripAnsi = (s: string) => s.replace(ANSI_RE, "");
  const UNDRIVABLE_RE = /unknown (?:flag|option)|flag provided but not defined|unrecognized (?:option|argument)|no such (?:option|flag)|invalid option|unexpected argument|command not found|no such file or directory/i;

  interface PlanSession {
    kind: "plan" | "build"; // build = supervised (accept_edits) session
    pty: PtyHandle;
    transcript: string;
    idleTimer: NodeJS.Timeout | null;
    finished: boolean;
    arm: () => void;
  }
  const activePlanSessions = new Map<string, PlanSession>();

  function closePlanSession(taskId: string): void {
    const s = activePlanSessions.get(taskId);
    if (!s) return;
    s.finished = true;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.pty.kill();
    activePlanSessions.delete(taskId);
  }

  /** Finalize a plan: fallback attribution prefix, needsInput question, state=planned. */
  function completePlan(taskId: string, rawText: string): void {
    const job = store.getByTaskId(taskId);
    if (!job || isCancelled(taskId)) return;
    const classified = classifyHold(rawText);
    const usedFallback = !!job.plan_provider && job.plan_provider !== job.provider;
    const planText = usedFallback
      ? `Planned by ${job.plan_provider} (fallback for '${job.provider}' — its plan mode could not be used; the build will still run '${job.provider}')\n\n${rawText}`
      : rawText;
    store.update(taskId, {
      state: "planned",
      plan: truncate(planText, 16 * 1024),
      question: classified?.reason === "needs_input" ? classified.question : null,
      error: null,
      hold_reason: null, prev_state: null, hold_since: null,
      finished_at: Date.now(),
      pid: null,
    });
  }

  /** Last resort: re-run the plan with PLAN_FALLBACK_AGENT. Bounded — a second hop is refused. */
  async function planWithFallback(taskId: string, reason: string): Promise<void> {
    const job = store.getByTaskId(taskId);
    if (!job || isCancelled(taskId)) return;
    const current = job.plan_provider || job.provider;
    const fbName = cfg.planFallbackAgent?.trim();
    const fb = fbName ? registry.get(fbName) : undefined;
    if (!fbName || !fb || isStub(fb) || !planModeOf(fb) || fbName === current) {
      fail(taskId, `Plan mode for '${current}' could not be driven (${reason}) and no usable PLAN_FALLBACK_AGENT is configured.`);
      return;
    }
    store.update(taskId, { plan_provider: fbName, error: null });
    await runPlanJob(taskId);
  }

  /** Dispatcher: pick the cheapest viable plan mode for the job's plan provider. */
  async function runPlanJob(taskId: string): Promise<void> {
    const job = store.getByTaskId(taskId);
    if (!job) return;
    const providerName = job.plan_provider || job.provider;
    const entry = registry.get(providerName);
    if (!entry || isStub(entry)) { await planWithFallback(taskId, `provider '${providerName}' is unknown or a stub`); return; }
    const mode = planModeOf(entry);
    if (!mode) { await planWithFallback(taskId, `provider '${providerName}' has no plan mode`); return; }
    activeRuns.add(taskId);
    try {
      // Complex tasks skip the cheap pass and go straight to interactive when drivable.
      if (mode === "interactive" || (job.plan_complex === 1 && entry.planSend?.length)) {
        const err = await runInteractivePlan(taskId, entry);
        if (err) await planWithFallback(taskId, err);
        return;
      }
      await runNonInteractivePlan(taskId, providerName, entry, mode);
    } finally {
      activeRuns.delete(taskId); // interactive sessions stay tracked via activePlanSessions
      updatePower();
    }
  }

  /** headless/oneshot: run non-interactively, capture stdout or the generated plan file. */
  async function runNonInteractivePlan(taskId: string, providerName: string, entry: ProviderEntry, mode: PlanMode): Promise<void> {
    const job = store.getByTaskId(taskId)!;
    // Brief passes verbatim (argv/stdin), never shell-expanded — untrusted input.
    const args = buildProviderArgs(entry, "plan", job.brief, job.repo_path);
    let result: { code: number | null };
    try {
      result = await runLogged(job, entry.command, args, {
        cwd: job.repo_path, env: { ...process.env, ...entry.env },
        stdinData: entry.promptVia === "stdin" ? job.brief : undefined,
        logFile: planLogPath(taskId), freshLog: true,
      });
    } catch (e: any) {
      await planWithFallback(taskId, `could not be started: ${e.message}`);
      return;
    }
    if (isCancelled(taskId)) return;

    let output = "";
    try { output = await readFile(planLogPath(taskId), "utf-8"); } catch { /* empty plan log */ }

    if (result.code !== 0) {
      // Config/binary drift (unknown flag, missing subcommand) = undrivable → fallback.
      if (UNDRIVABLE_RE.test(output)) { await planWithFallback(taskId, `plan flags rejected (exit ${result.code})`); return; }
      const classified = classifyHold(output);
      if (classified) {
        hold(taskId, classified.reason, "planning", `Plan run exited with code ${result.code} (${classified.reason})\n---\n${truncate(output, 2000)}`, classified.question);
        return;
      }
      fail(taskId, `Plan run exited with code ${result.code}`, truncate(output, 4000));
      return;
    }

    let planText = stripAnsi(output);
    if (mode === "oneshot" && entry.planOutputFile) {
      const rel = entry.planOutputFile;
      const filePath = path.join(job.repo_path, rel);
      let fileText = "";
      try { fileText = await readFile(filePath, "utf-8"); } catch { /* CLI produced no file */ }
      // Keep the repo pristine: delete an untracked artifact, restore a tracked one.
      const { stdout: st } = await git(job.repo_path, ["status", "--porcelain", "--", rel]).catch(() => ({ stdout: "" } as any));
      if (st.startsWith("??")) await rm(filePath, { force: true }).catch(() => {});
      else if (st.trim()) await git(job.repo_path, ["checkout", "--", rel]).catch(() => {});
      if (fileText.trim()) planText = fileText;
    }

    // Escalation: a thin/empty one-shot plan escalates to an interactive
    // session for the SAME provider (when it declares one). If the interactive
    // attempt can't be driven, keep the thin plan rather than discard work.
    if (planText.trim().length < cfg.planMinChars && entry.planSend?.length) {
      const err = await runInteractivePlan(taskId, entry);
      if (!err) return; // escalated — session events own the job now
    }
    completePlan(taskId, planText);
  }

  /** interactive: drive the CLI's TUI through a pty; relay questions via hold(needs_input). */
  async function runInteractivePlan(taskId: string, entry: ProviderEntry): Promise<string | null> {
    const job = store.getByTaskId(taskId)!;
    let ptyH: PtyHandle;
    try {
      ptyH = await spawnPty(entry.command, entry.planInteractiveArgs ?? [], {
        cwd: job.repo_path, env: { ...process.env, ...entry.env },
      });
    } catch (e: any) {
      return `interactive plan session could not be started: ${e.message}`;
    }
    const logStream = createWriteStream(planLogPath(taskId), { flags: "w" });
    const session: PlanSession = { kind: "plan", pty: ptyH, transcript: "", idleTimer: null, finished: false, arm: () => {} };
    session.arm = () => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(onIdle, cfg.planIdleMs);
    };
    activePlanSessions.set(taskId, session);
    store.update(taskId, { pid: ptyH.pid ?? null, last_heartbeat: Date.now() });

    const finalize = (text: string) => {
      session.finished = true;
      if (session.idleTimer) clearTimeout(session.idleTimer);
      logStream.end();
      ptyH.kill();
      activePlanSessions.delete(taskId);
      completePlan(taskId, text);
    };

    const onIdle = () => {
      if (session.finished) return;
      const j = store.getByTaskId(taskId);
      if (!j || j.state !== "planning") return; // held/cancelled — answer-task re-arms
      const lines = stripAnsi(session.transcript).split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) { session.arm(); return; } // still booting; stale sweep is the backstop
      const q = [...lines.slice(-6)].reverse().find(l => l.endsWith("?"));
      if (q) {
        // The CLI is waiting on a human. Session stays ALIVE; answer-task resumes it.
        hold(taskId, "needs_input", "planning", "Interactive plan session is waiting for input", truncate(q, 500));
      } else {
        finalize(stripAnsi(session.transcript));
      }
    };

    let lastDbBump = Date.now();
    ptyH.onData((chunk) => {
      session.transcript += chunk;
      if (session.transcript.length > 128 * 1024) session.transcript = session.transcript.slice(-128 * 1024);
      logStream.write(chunk);
      const now = Date.now();
      if (now - lastDbBump > HEARTBEAT_DB_THROTTLE_MS) { lastDbBump = now; store.update(taskId, { last_heartbeat: now }); }
      if (store.getByTaskId(taskId)?.state === "planning") session.arm();
    });
    ptyH.onExit((code) => {
      if (session.finished) return;
      session.finished = true;
      if (session.idleTimer) clearTimeout(session.idleTimer);
      logStream.end();
      activePlanSessions.delete(taskId);
      const j = store.getByTaskId(taskId);
      if (!j || isCancelled(taskId)) return;
      if (j.state === "hold") return; // died while waiting on a human — answer-task will re-plan cleanly
      const text = stripAnsi(session.transcript);
      if (code !== 0 && (UNDRIVABLE_RE.test(text) || !text.trim())) {
        planWithFallback(taskId, `interactive session failed (exit ${code})`).catch((e: any) => fail(taskId, e.message));
        return;
      }
      if (code !== 0) {
        const classified = classifyHold(text);
        if (classified) { hold(taskId, classified.reason, "planning", `Interactive plan session exited with code ${code} (${classified.reason})`, classified.question); return; }
        fail(taskId, `Interactive plan session exited with code ${code}`, truncate(text, 4000));
        return;
      }
      completePlan(taskId, text);
    });

    // Give the TUI a beat to boot, then drive it: mode toggle (e.g. Shift+Tab),
    // slash-command (/plan), the brief — whatever the registry declares.
    setTimeout(() => {
      if (session.finished) return;
      const sends = entry.planSend ?? [];
      sends.forEach((seq, i) => {
        setTimeout(() => { if (!session.finished) ptyH.write(seq.replaceAll("{brief}", job.brief)); }, i * 400);
      });
      session.arm();
    }, 800);
    return null;
  }

  /**
   * Relay a human's answer into a paused plan/build. If the interactive pty
   * session is still alive, the answer goes straight to its stdin; if the
   * session died (or the bridge restarted), the answer is folded into the
   * brief and the job cleanly re-runs.
   */
  async function answerTask(taskId: string, answer: string): Promise<any> {
    if (!answer?.trim()) throw new Error("answer is required");
    const job = store.getByTaskId(slugifyTaskId(taskId));
    if (!job) return { resumed: false, error: "notFound", taskId };
    if (job.state !== "hold" || job.hold_reason !== "needs_input") {
      return { resumed: false, error: "invalidState", message: `Task is '${job.state}'${job.hold_reason ? ` (${job.hold_reason})` : ""} — answer-task only applies to hold(needs_input).` };
    }
    const now = Date.now();
    const session = activePlanSessions.get(job.task_id);
    if (session && !session.finished) {
      const resumeState: JobState = session.kind === "build" ? "in_progress" : "planning";
      store.update(job.task_id, {
        state: resumeState, hold_reason: null, question: null, hold_since: null, prev_state: null,
        error: null, last_heartbeat: now,
      });
      session.pty.write(answer + "\r");
      session.arm();
      updatePower();
      return { resumed: true, mode: "session", taskId: job.task_id, state: resumeState };
    }
    // No live session (bridge restarted / headless question / session died):
    // fold the answer into the brief and re-run from scratch.
    const newBrief = `${job.brief}\n\n[Answer to: ${job.question ?? "the previous question"}] ${answer}`;
    const target: JobState = job.prev_state === "in_progress" ? "in_progress" : "planning";
    store.update(job.task_id, {
      state: target, brief: newBrief,
      hold_reason: null, question: null, hold_since: null, prev_state: null,
      error: null, started_at: now, finished_at: null, last_heartbeat: now,
    });
    if (target === "in_progress") runJob(job.task_id).catch((e: any) => fail(job.task_id, `Internal bridge error: ${e.message}`));
    else runPlanJob(job.task_id).catch((e: any) => fail(job.task_id, `Internal bridge error: ${e.message}`));
    updatePower();
    return { resumed: true, mode: "replanned", taskId: job.task_id, state: target };
  }

  /**
   * Dispatch a READ-ONLY plan job and return IMMEDIATELY — never leaves the
   * caller hanging on a slow plan. Poll get-job-status: `planning` → still
   * running; `planned` → result in the `plan` field (+ optional question).
   * Refuses (never falls back to build mode) when the provider has no plan mode.
   */
  async function planTask(params: { taskId: string; pageId?: string; repoPath: string; brief: string; codingAgent?: string; complex?: boolean }): Promise<any> {
    await registryReady;
    if (!params.taskId?.trim() || !params.repoPath?.trim() || !params.brief?.trim()) {
      throw new Error("taskId, repoPath, and brief are required");
    }
    const taskId = slugifyTaskId(params.taskId);
    const pageId = params.pageId?.trim() || `plan-${taskId}`;
    // The card's agent stays the BUILD provider; only the plan run may be
    // delegated to PLAN_FALLBACK_AGENT when the card's agent can't plan.
    const provider = resolveProvider(registry, params.codingAgent, cfg.defaultProvider);
    let planProvider = provider;
    if (!provider.entry.planSupported) {
      const fbName = cfg.planFallbackAgent?.trim();
      const fbEntry = fbName ? registry.get(fbName) : undefined;
      if (fbName && fbEntry && !isStub(fbEntry) && fbEntry.planSupported) {
        planProvider = { name: fbName, entry: fbEntry };
      } else {
        const planners = [...registry.entries()].filter(([, e]) => e.planSupported && !isStub(e)).map(([n]) => n);
        const fbNote = fbName ? `PLAN_FALLBACK_AGENT '${fbName}' can't plan either (missing, stub, or planSupported:false)` : "no PLAN_FALLBACK_AGENT is configured";
        return { error: "planUnsupported", planSupported: false, message: `Provider '${provider.name}' has no read-only plan mode and ${fbNote} — refusing rather than falling back to a writing mode. Plan-capable providers: ${planners.join(", ") || "(none)"}.` };
      }
    }
    const repoCheck = await validateRepo(params.repoPath);
    if (!repoCheck.ok) return { error: "invalidRepo", reason: repoCheck.reason };

    const existing = store.getByTaskId(taskId) ?? store.getByPageId(pageId);
    if (existing && existing.state === "planning") {
      return { started: false, alreadyPlanning: true, ...(await jobStatusPayload(existing, false)) };
    }
    if (existing && (existing.state === "in_progress" || existing.state === "in_review" || existing.state === "merged" || existing.state === "reverted")) {
      return { started: false, error: "invalidState", message: `Task '${existing.task_id}' is already in build state '${existing.state}' — planning happens before Ready for Dev.` };
    }
    if (store.countRunning() >= cfg.maxConcurrentJobs) {
      return { started: false, error: "capacityExceeded", running: store.countRunning(), maxConcurrentJobs: cfg.maxConcurrentJobs, message: "Concurrency cap reached — retry on the next agent wake." };
    }

    const now = Date.now();
    if (existing) {
      // Re-plan (new brief) or resume after failed/hold/cancelled/planned.
      store.update(existing.task_id, {
        state: "planning", brief: params.brief, provider: provider.name, plan_provider: planProvider.name, repo_path: repoCheck.repo,
        plan_complex: params.complex ? 1 : 0,
        plan: null, error: null, hold_reason: null, prev_state: null, question: null, hold_since: null,
        started_at: now, finished_at: null, last_heartbeat: now,
      });
    } else {
      store.insert({
        task_id: taskId, page_id: pageId, repo_path: repoCheck.repo,
        branch: "", worktree_path: "", // plan jobs write nothing and create no branch
        provider: provider.name, state: "planning", brief: params.brief,
        verify_command: null, pr_url: null, branch_url: null, merge_commit: null,
        error: null, local_only: null, plan: null, plan_provider: planProvider.name,
        plan_complex: params.complex ? 1 : 0, session_id: null,
        mode: null, board_id: cfg.boardId ?? null,
        hold_reason: null, prev_state: null, question: null, hold_since: null,
        pid: null, last_heartbeat: now, started_at: now, finished_at: null, merged_at: null, cleaned_at: null,
      });
    }
    const effectiveTaskId = existing?.task_id ?? taskId;
    runPlanJob(effectiveTaskId).catch((e: any) => fail(effectiveTaskId, `Internal bridge error: ${e.message}`));
    updatePower(); // plan job active → hold the sleep assertion immediately
    return {
      started: true, taskId: effectiveTaskId, state: "planning",
      provider: provider.name, planProvider: planProvider.name,
      ...(planProvider.name !== provider.name ? { fallback: true } : {}),
      logPath: planLogPath(effectiveTaskId),
    };
  }

  /** Kill a running/held/planning job, remove its worktree (builds only), KEEP the branch. */
  async function cancelTask(taskId: string): Promise<any> {
    const job = store.getByTaskId(slugifyTaskId(taskId));
    if (!job) return { cancelled: false, error: "notFound", taskId };
    if (job.state !== "in_progress" && job.state !== "hold" && job.state !== "planning") {
      return { cancelled: false, error: "invalidState", message: `Cannot cancel a job in state '${job.state}' — only in_progress, planning, or hold jobs can be cancelled.` };
    }
    // Mark cancelled FIRST so the in-flight run continuation can't overwrite it.
    store.update(job.task_id, {
      state: "cancelled", finished_at: Date.now(),
      hold_reason: null, prev_state: null, question: null, hold_since: null,
    });
    closePlanSession(job.task_id); // kill any live interactive plan session
    if (job.pid) killJobProcess(job.pid);
    if (job.worktree_path) { // plan jobs have no worktree
      await git(job.repo_path, ["worktree", "remove", "--force", job.worktree_path]).catch(() => {});
      await git(job.repo_path, ["worktree", "prune"]).catch(() => {});
    }
    store.update(job.task_id, { pid: null });
    return { cancelled: true, taskId: job.task_id, ...(job.branch ? { branchKept: job.branch } : {}), ...(job.worktree_path ? { worktreeRemoved: job.worktree_path } : {}) };
  }

  async function getJobStatus(taskId?: string): Promise<any> {
    if (taskId?.trim()) {
      const job = store.getByTaskId(slugifyTaskId(taskId)) ?? store.getByPageId(taskId.trim());
      if (!job) return { error: "notFound", taskId };
      return jobStatusPayload(job, true);
    }
    const jobs = store.listRecent(50);
    return { jobs: await Promise.all(jobs.map(j => jobStatusPayload(j, false))) };
  }

  async function mergeTask(taskId: string, action: "merge" | "revert" = "merge"): Promise<any> {
    // Break-glass gate: default OFF; the board (human moves card to Approved) is the real gate.
    if (cfg.confirmationGateEnabled()) {
      return { merged: false, error: "confirmationGateActive", message: "Autonomous merges are disabled: ENABLE_CONFIRMATION_GATE is on. Merge manually or unset the gate." };
    }
    const job = store.getByTaskId(slugifyTaskId(taskId));
    if (!job) return { merged: false, error: "notFound", taskId };

    const repo = job.repo_path;
    if (!(await isWorkingTreeClean(repo))) {
      return { merged: false, error: "dirtyWorkingTree", message: `Working tree at ${repo} has uncommitted changes — refusing to ${action}.` };
    }
    const mainBranch = await detectMainBranch(repo);
    const { stdout: headOut } = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const originalBranch = headOut.trim();
    const origin = await hasOrigin(repo);

    const restoreBranch = async () => {
      if (originalBranch !== mainBranch && originalBranch !== "HEAD") {
        await git(repo, ["checkout", originalBranch]).catch(() => {});
      }
    };

    if (action === "revert") {
      if (job.state !== "merged" || !job.merge_commit) {
        return { merged: false, error: "invalidState", message: `Cannot revert task in state '${job.state}' — only merged tasks can be reverted.` };
      }
      const windowMs = cfg.revertWindowHours * 3600 * 1000;
      if (!job.merged_at || Date.now() - job.merged_at > windowMs) {
        return { merged: false, error: "revertWindowExpired", message: `Merge is older than the ${cfg.revertWindowHours}h revert window.` };
      }
      await git(repo, ["checkout", mainBranch]);
      try {
        await git(repo, ["revert", "-m", "1", "--no-edit", job.merge_commit]);
      } catch (e: any) {
        await git(repo, ["revert", "--abort"]).catch(() => {});
        await restoreBranch();
        return { merged: false, error: "revertConflict", message: truncate(e.stderr || e.message) };
      }
      let pushFailed = false;
      if (origin) await git(repo, ["push", "origin", mainBranch]).catch(() => { pushFailed = true; });
      await restoreBranch();
      store.update(job.task_id, { state: "reverted", error: pushFailed ? `revert committed locally but push of ${mainBranch} failed` : null });
      return { reverted: true, taskId: job.task_id, ...(pushFailed ? { pushFailed } : {}) };
    }

    // action === "merge" — machine-side guard: only reviewable work merges.
    if (job.state !== "in_review") {
      return { merged: false, error: "invalidState", message: `Task is '${job.state}' — merge requires 'in_review'. The board's Approved column is the gate; the bridge only checks the work actually finished.` };
    }

    await git(repo, ["checkout", mainBranch]);
    try {
      await git(repo, ["merge", "--no-ff", "--no-edit", job.branch]);
    } catch (e: any) {
      const { stdout: conflictsOut } = await git(repo, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ({ stdout: "" } as any));
      const conflictFiles = conflictsOut.trim().split("\n").filter(Boolean);
      await git(repo, ["merge", "--abort"]).catch(() => {});
      await restoreBranch();
      // Worktree and branch stay intact — the agent moves the card to Rework.
      store.update(job.task_id, { error: `merge conflict with ${mainBranch}: ${conflictFiles.join(", ") || truncate(e.stderr || e.message, 500)}` });
      return { merged: false, conflict: true, conflictFiles };
    }

    const { stdout: shaOut } = await git(repo, ["rev-parse", "HEAD"]);
    const mergeCommit = shaOut.trim();
    let pushFailed = false;
    if (origin) await git(repo, ["push", "origin", mainBranch]).catch(() => { pushFailed = true; });
    await restoreBranch();

    // Worktree removed at merge; branch KEPT for the revert window.
    await git(repo, ["worktree", "remove", job.worktree_path]).catch(async () => {
      await git(repo, ["worktree", "remove", "--force", job.worktree_path]).catch(() => {});
    });

    store.update(job.task_id, {
      state: "merged", merge_commit: mergeCommit, merged_at: Date.now(),
      error: pushFailed ? `merged locally but push of ${mainBranch} failed — push manually` : null,
    });
    return { merged: true, taskId: job.task_id, mergeCommit, branchKept: job.branch, ...(pushFailed ? { pushFailed } : {}) };
  }

  // ── Always-on service machinery ────────────────────────────
  const power = new PowerAssertion();
  function updatePower(): void { power.ensure(store.countRunning()); }

  let tunnel: { up: boolean; url: string | null; lastCheck: number | null } = { up: false, url: null, lastCheck: null };
  async function checkTunnel(trigger: string): Promise<void> {
    if (!cfg.tunnelCheck) return;
    const was = tunnel.up;
    try {
      const r = await cfg.tunnelCheck();
      tunnel = { up: r.up, url: r.url ?? null, lastCheck: Date.now() };
    } catch {
      tunnel = { up: false, url: null, lastCheck: Date.now() };
    }
    if (tunnel.up && !was) console.error(`[TUNNEL] up${tunnel.url ? ` → ${tunnel.url}` : ""} (${trigger})`);
    if (!tunnel.up && was) console.error(`[TUNNEL] DOWN (${trigger}) — the tunnel service's KeepAlive should restart it; will re-verify`);
  }

  /** pid liveness — the recovery discriminator between frozen-then-resumed and dead. */
  function isPidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  /** Jobs from a PREVIOUS bridge process whose provider is still alive: reattached, watched by the sweep. */
  const reattachWatch = new Map<string, number>();
  // Every board name below resolves through board-map.json — never hard-coded.
  const S = boardMap.statusOptions;
  const ACTIVE_BOARD_STATUSES = [S.ready_for_dev, S.in_progress, S.planning, S.hold, S.rework];

  /**
   * Crash/reboot recovery over every persisted non-terminal job. Jobs owned by
   * THIS process (sleep-frozen then resumed) are skipped — they just continue.
   * Alive orphans reattach (no relaunch); dead ones follow RESUME_STRATEGY.
   */
  let recoveryInFlight: Promise<{ reattached: string[]; recovered: string[] }> | null = null;
  function recoverJobs(reason: string): Promise<{ reattached: string[]; recovered: string[] }> {
    // Serialized: boot recovery, wake recovery, and manual recoverNow can
    // overlap — the second caller awaits the first pass instead of double-firing.
    if (recoveryInFlight) return recoveryInFlight;
    recoveryInFlight = recoverJobsInner(reason).finally(() => { recoveryInFlight = null; });
    return recoveryInFlight;
  }

  async function recoverJobsInner(reason: string): Promise<{ reattached: string[]; recovered: string[] }> {
    await registryReady;
    const reattached: string[] = [];
    const recovered: string[] = [];
    for (const job of store.listRunning()) {
      if (activeRuns.has(job.task_id) || activePlanSessions.has(job.task_id) || reattachWatch.has(job.task_id)) continue;
      if (job.pid && isPidAlive(job.pid)) {
        reattachWatch.set(job.task_id, job.pid);
        store.update(job.task_id, { last_heartbeat: Date.now() });
        console.error(`[RECOVERY] (${reason}) ${job.task_id}: provider pid ${job.pid} still alive — reattached, no relaunch`);
        reattached.push(job.task_id);
        continue;
      }
      await recoverDeadJob(job, reason);
      recovered.push(job.task_id);
    }
    updatePower();
    return { reattached, recovered };
  }

  async function recoverDeadJob(job: JobRecord, reason: string): Promise<void> {
    // Never resume a job the board has since moved out of an active state.
    if (cfg.boardClient && job.page_id && !job.page_id.startsWith("plan-")) {
      const boardStatus = await cfg.boardClient.getStatus(job.page_id).catch(() => null);
      if (boardStatus && !ACTIVE_BOARD_STATUSES.includes(boardStatus)) {
        fail(job.task_id, `interrupted job not resumed: the board card has moved to '${boardStatus}'`);
        return;
      }
    }
    if (job.state === "planning") { // plans are cheap and read-only — just re-plan
      console.error(`[RECOVERY] (${reason}) ${job.task_id}: dead plan job — re-planning`);
      store.update(job.task_id, { started_at: Date.now(), last_heartbeat: Date.now(), error: null });
      runPlanJob(job.task_id).catch((e: any) => fail(job.task_id, `recovery re-plan failed: ${e.message}`));
      return;
    }
    if (cfg.resumeStrategy === "rework") {
      fail(job.task_id, "interrupted (bridge/machine restart) — moved to Rework per RESUME_STRATEGY=rework");
      return;
    }
    const entry = registry.get(job.provider);
    const rt = entry?.resumeArgsTemplate;
    const canResume = !!rt?.length && (!rt.join(" ").includes("{sessionId}") || !!job.session_id);
    const resume = cfg.resumeStrategy === "resume" && canResume;
    console.error(`[RECOVERY] (${reason}) ${job.task_id}: dead build job — ${resume ? "resuming provider session" : "re-running the brief"} in ${job.worktree_path}`);
    store.update(job.task_id, { started_at: Date.now(), last_heartbeat: Date.now(), error: null, finished_at: null });
    runJob(job.task_id, { resume }).catch((e: any) => fail(job.task_id, `recovery relaunch failed: ${e.message}`));
  }

  // ── Board self-scan: the board IS the durable queue; pick cards up within
  //    seconds of being awake instead of waiting for the cloud agent's pulse.
  const scanInflight = new Set<string>();
  let scanning = false;
  let lastSelfScanAt: number | null = null;
  const SCAN_STATUSES = [S.ready_for_dev, S.in_progress, S.hold, S.approved];

  /**
   * The SINGLE write path: MCP tools (cloud-agent-triggered) and the self-scan
   * both act through startTask/mergeTask + the SQLite store, so the two
   * triggers can never double-dispatch or fight over a status. Machine-side
   * transitions only — the bridge NEVER flips a human gate
   * (todo / ready_for_dev / approved).
   */
  async function reconcileCard(client: BoardClient, card: BoardCard): Promise<string | null> {
    const job = store.getByPageId(card.pageId) ?? store.getByTaskId(slugifyTaskId(card.taskId));
    switch (card.status) {
      case S.ready_for_dev: {
        if (!card.repoPath || !card.brief) return null; // incomplete card — a human's problem, never guessed
        const cardMode: TaskMode = card.mode === boardMap.modeOptions.accept_edits ? "accept_edits"
          : card.mode === boardMap.modeOptions.auto ? "auto" : defaultMode;
        const r = await startTask({ taskId: card.taskId, pageId: card.pageId, repoPath: card.repoPath, brief: card.brief, codingAgent: card.codingAgent || undefined, verifyCommand: card.verifyCommand, mode: cardMode });
        if (r.alreadyRunning) { await client.setStatus(card.pageId, S.in_progress); return "dedup: already dispatched (card flipped)"; }
        if (r.state === "in_progress") {
          await client.setStatus(card.pageId, S.in_progress);
          await client.comment(card.pageId, `Bridge self-scan dispatched to ${r.provider} (${cardMode}) on branch ${r.branch}.`);
          return "dispatched";
        }
        if (r.error === "capacityExceeded") return "capacity full — left in place";
        if (r.error === "invalidRepo") { await client.comment(card.pageId, `Bridge: invalid repo — ${r.reason}`); return "invalidRepo commented"; }
        return r.error ?? null;
      }
      case S.approved: {
        if (!job) return "approved card has no job — left for the cloud agent";
        const m = await mergeTask(job.task_id, "merge");
        if (m.merged) {
          await client.setStatus(card.pageId, S.merged);
          await client.comment(card.pageId, `Merged as ${m.mergeCommit} (branch ${m.branchKept} kept for the revert window).`);
          return "merged";
        }
        if (m.conflict) {
          await client.setStatus(card.pageId, S.rework);
          await client.comment(card.pageId, `Merge conflict with the base branch: ${(m.conflictFiles ?? []).join(", ")}`);
          return "conflict → rework";
        }
        return `merge refused: ${m.error ?? ""}`;
      }
      case S.in_progress:
      case S.hold: {
        if (!job) return null;
        if (job.state === "in_review") {
          await client.setStatus(card.pageId, S.in_review);
          const where = job.pr_url ?? job.branch_url ?? `branch ${job.branch}${job.local_only ? " (built locally, not pushed — repo has no origin remote)" : ""}`;
          await client.comment(card.pageId, `Ready for review: ${where}`);
          return "→ in_review";
        }
        if (job.state === "failed") { await client.setStatus(card.pageId, S.failed); await client.comment(card.pageId, `Failed: ${truncate(job.error ?? "unknown error", 1200)}`); return "→ failed"; }
        if (job.state === "hold" && card.status !== S.hold) {
          await client.setStatus(card.pageId, S.hold);
          await client.comment(card.pageId, job.hold_reason === "needs_input" ? `Needs input: ${job.question}` : `On hold (${job.hold_reason}): ${truncate(job.error ?? "", 800)}`);
          return "→ hold";
        }
        if ((job.state === "in_progress" || job.state === "planning") && card.status === S.hold) { await client.setStatus(card.pageId, S.in_progress); return "resumed → in_progress"; }
        return null;
      }
      default:
        return null;
    }
  }

  async function scanBoardOnce(trigger: string): Promise<{ scanned: number; actions: string[] }> {
    const client = cfg.boardClient;
    if (!client) return { scanned: 0, actions: [] };
    if (scanning) return { scanned: 0, actions: ["skipped: previous scan still running"] };
    scanning = true;
    const actions: string[] = [];
    try {
      const cards = await client.fetchCards(SCAN_STATUSES);
      lastSelfScanAt = Date.now();
      for (const card of cards) {
        if (scanInflight.has(card.pageId)) continue; // per-task lock — cloud agent + self-scan can't double-act
        scanInflight.add(card.pageId);
        try {
          const act = await reconcileCard(client, card);
          if (act) { actions.push(`${card.taskId}: ${act}`); console.error(`[SCAN] (${trigger}) ${card.taskId}: ${act}`); }
        } catch (e: any) {
          console.error(`[SCAN] (${trigger}) ${card.taskId}: ${e.message}`);
        } finally {
          scanInflight.delete(card.pageId);
        }
      }
      updatePower();
      return { scanned: cards.length, actions };
    } catch (e: any) {
      console.error(`[SCAN] (${trigger}) board query failed: ${e.message}`);
      return { scanned: 0, actions: [`error: ${e.message}`] };
    } finally {
      scanning = false;
    }
  }

  // ── Wake routine: reconnect tunnel → reconcile in-flight jobs → self-scan ──
  let lastWakeAt: number | null = null;
  async function triggerWake(gapMs = 0): Promise<any> {
    lastWakeAt = Date.now();
    console.error(`[WAKE] wake routine${gapMs ? ` (slept ~${Math.round(gapMs / 1000)}s)` : ""}: tunnel → reconcile → self-scan`);
    await checkTunnel("wake");
    const recovery = await recoverJobs("wake");
    const scan = await scanBoardOnce("wake");
    return { lastWakeAt, tunnel, recovery, scan };
  }

  /** Copy-truncate rotation for the launchd service logs (launchd keeps the fd open, so rename-rotation won't work). */
  async function rotateServiceLogs(): Promise<void> {
    const dir = path.join(os.homedir(), ".build-board", "logs");
    if (!existsSync(dir)) return;
    try {
      for (const f of await readdir(dir)) {
        if (!f.endsWith(".log")) continue;
        const full = path.join(dir, f);
        const s = await stat(full).catch(() => null);
        if (s && s.size > 10 * 1024 * 1024) {
          await copyFile(full, `${full}.1`).catch(() => {});
          await ftruncate(full, 0).catch(() => {});
          console.error(`[LOGS] rotated ${f} (${Math.round(s.size / 1024 / 1024)} MB)`);
        }
      }
    } catch { /* rotation is best-effort */ }
  }

  /** One sweep pass: reattached-pid watch, stale heartbeats, max runtime, revert-window branch cleanup. */
  async function sweep(): Promise<void> {
    const now = Date.now();
    // Reattached jobs: pid-alive IS the heartbeat (their stdout pipes died with
    // the old bridge process). When the pid exits, finish the pipeline.
    for (const [tid, pid] of reattachWatch) {
      const j = store.getByTaskId(tid);
      if (!j || (j.state !== "in_progress" && j.state !== "planning")) { reattachWatch.delete(tid); continue; }
      if (isPidAlive(pid)) { store.update(tid, { last_heartbeat: now }); continue; }
      reattachWatch.delete(tid);
      console.error(`[RECOVERY] ${tid}: reattached provider pid ${pid} exited — finishing the pipeline`);
      if (j.state === "planning") {
        readFile(planLogPath(tid), "utf-8")
          .then(txt => completePlan(tid, stripAnsi(txt)))
          .catch(() => completePlan(tid, ""));
      } else {
        finishBuild(tid).catch((e: any) => fail(tid, `finish after reattach failed: ${e.message}`));
      }
    }
    // Reap interactive plan sessions whose job is gone/terminal, and abandoned
    // needs_input sessions (>24h unanswered) — the pty dies, the hold state
    // stays, and answer-task later re-plans cleanly.
    for (const [tid, sess] of activePlanSessions) {
      const j = store.getByTaskId(tid);
      const activeState = sess.kind === "build" ? "in_progress" : "planning";
      const waiting = j && (j.state === activeState || (j.state === "hold" && j.hold_reason === "needs_input"));
      const abandoned = j?.state === "hold" && j.hold_since && now - j.hold_since > 24 * 3600 * 1000;
      if (!waiting || abandoned) closePlanSession(tid);
    }
    for (const job of store.listRunning()) {
      const heartbeatAge = now - (job.last_heartbeat ?? job.started_at ?? job.created_at);
      const runtime = now - (job.started_at ?? job.created_at);
      // Plans get their own (shorter) hard ceiling; builds get the full runtime.
      const runtimeCap = job.state === "planning" ? cfg.planTimeoutMs : cfg.jobMaxRuntimeMs;
      if (heartbeatAge > cfg.heartbeatTimeoutMs) {
        if (job.pid) killJobProcess(job.pid);
        fail(job.task_id, `Job stale — no output for ${Math.round(heartbeatAge / 60000)} min (limit ${Math.round(cfg.heartbeatTimeoutMs / 60000)} min)`);
      } else if (runtime > runtimeCap) {
        if (job.pid) killJobProcess(job.pid);
        fail(job.task_id, `${job.state === "planning" ? "Plan" : "Job"} exceeded max runtime of ${Math.round(runtimeCap / 60000)} min`);
      }
    }
    // Auto-retry transient holds: quota windows clear on their own, so restore
    // prevState and re-run once the retry delay has passed (capacity permitting).
    // session / needs_input / blocked holds wait for a human — never auto-retried.
    for (const job of store.listHeldForRetry(now - cfg.holdRetryMs)) {
      if (store.countRunning() >= cfg.maxConcurrentJobs) break;
      const prev = (job.prev_state as JobState) || "in_progress";
      store.update(job.task_id, {
        state: prev, hold_reason: null, prev_state: null, question: null, hold_since: null,
        error: null, started_at: now, finished_at: null, last_heartbeat: now,
      });
      if (prev === "in_progress") {
        runJob(job.task_id).catch((e: any) => fail(job.task_id, `Internal bridge error on hold retry: ${e.message}`));
      } else if (prev === "planning") {
        runPlanJob(job.task_id).catch((e: any) => fail(job.task_id, `Internal bridge error on hold retry: ${e.message}`));
      }
    }
    const cutoff = now - cfg.revertWindowHours * 3600 * 1000;
    for (const job of store.listMergedForCleanup(cutoff)) {
      await git(job.repo_path, ["branch", "-D", job.branch]).catch(() => {});
      if (await hasOrigin(job.repo_path)) {
        await git(job.repo_path, ["push", "origin", "--delete", job.branch]).catch(() => {});
      }
      await git(job.repo_path, ["worktree", "prune"]).catch(() => {});
      store.update(job.task_id, { cleaned_at: now });
    }
    updatePower();
    await rotateServiceLogs();
  }

  let wakeDetector: WakeDetector | null = null;
  let selfScanTimer: NodeJS.Timeout | null = null;

  function startSweeps(intervalMs = 60000): NodeJS.Timeout {
    const timer = setInterval(() => { sweep().catch(e => console.error("[BRIDGE] sweep error:", e.message)); }, intervalMs);
    timer.unref();
    // Wake detection (monotonic-clock gap): wake → tunnel check → reconcile → self-scan.
    wakeDetector = new WakeDetector(cfg.wakeGapMs, (gap) => { triggerWake(gap).catch(e => console.error("[WAKE] wake routine error:", e.message)); });
    wakeDetector.start();
    // Board self-scan: startup + short interval while awake.
    if (cfg.boardClient && cfg.selfScanIntervalMs > 0) {
      selfScanTimer = setInterval(() => { scanBoardOnce("interval").catch(() => {}); }, cfg.selfScanIntervalMs);
      selfScanTimer.unref();
      scanBoardOnce("startup").catch(() => {});
    }
    checkTunnel("startup").catch(() => {});
    return timer;
  }

  return {
    startTask,
    planTask,
    answerTask,
    cancelTask,
    getJobStatus,
    mergeTask,
    sweep,
    startSweeps,
    // Always-on service surface
    triggerWake,
    scanBoardOnce,
    recoverNow: (reason = "manual") => recoverJobs(reason),
    ops: () => ({
      tunnel: { up: tunnel.up, url: tunnel.url, lastCheck: tunnel.lastCheck ? new Date(tunnel.lastCheck).toISOString() : null, monitored: !!cfg.tunnelCheck },
      lastWakeAt: lastWakeAt ? new Date(lastWakeAt).toISOString() : null,
      lastSelfScanAt: lastSelfScanAt ? new Date(lastSelfScanAt).toISOString() : null,
      selfScanEnabled: !!cfg.boardClient,
      powerAssertionHeld: power.isHeld(),
      activeJobs: store.countRunning(),
      reattachedJobs: [...reattachWatch.keys()],
      resumeStrategy: cfg.resumeStrategy,
    }),
    powerPid: () => power.pid(),
    summary: () => store.summary(),
    listUsableProviders: () => usableProviders(registry),
    close: () => {
      for (const [tid] of activePlanSessions) closePlanSession(tid);
      wakeDetector?.stop();
      if (selfScanTimer) clearInterval(selfScanTimer);
      power.release();
      store.close();
    },
  };
}
