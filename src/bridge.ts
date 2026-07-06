/**
 * Build bridge — a generic local build executor behind MCP. Its entire
 * vocabulary is: directory + local agent + mode + prompt + opaque jobId.
 * It knows nothing about whichever tool dispatches the work.
 *
 *   startTask     — async dispatch of a coding-agent CLI in an isolated worktree
 *   getJobStatus  — durable job state + log excerpt for the caller
 *   mergeTask     — gated --no-ff merge to main (or single-job revert)
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
  /** Wall-clock gap treated as a wake from sleep. */
  wakeGapMs: number;
  /** Default execution posture when the caller doesn't specify one. */
  defaultMode?: "auto" | "accept_edits";
  /** User-authorized dependency installs inside allowlisted repos (default true). */
  allowPackageInstalls?: boolean;
  /** Verifies the public tunnel (e.g. ngrok local API); bridge only reports/logs — KeepAlive restarts the tunnel service. */
  tunnelCheck?: () => Promise<{ up: boolean; url?: string }>;
  /** Break-glass switch: when true, merge/revert refuse outright. */
  confirmationGateEnabled: () => boolean;
  isPathAllowed: (p: string) => Promise<boolean>;
}

export interface StartTaskParams {
  /** Opaque caller-supplied id — the idempotency/dedup key. */
  jobId: string;
  repoPath: string;
  /** Natural-language work description. */
  prompt: string;
  agent?: string;
  /** Execution posture (default: DEFAULT_MODE, "auto"). */
  mode?: TaskMode;
  verifyCommand?: string;
  /** Branch to work on (default: job/<jobId>). */
  branch?: string;
}

const ERROR_CAP = 8 * 1024;
const EXCERPT_LINES = 50;
const HEARTBEAT_DB_THROTTLE_MS = 2000;

export type TaskMode = "auto" | "accept_edits";

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

/**
 * Merge-guard variant: only TRACKED modifications count as dirty. Untracked
 * junk (.DS_Store, editor droppings) must not block a merge — the guard
 * protects uncommitted work, and a genuine untracked-file collision is still
 * caught by git itself during the merge (surfaced via the conflict path).
 */
async function hasUncommittedTrackedChanges(repoDir: string): Promise<boolean> {
  const { stdout } = await git(repoDir, ["status", "--porcelain", "--untracked-files=no"]);
  return stdout.trim() !== "";
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

/**
 * The bridge must not depend on HOW it was launched: an IDE terminal, launchd,
 * or a bare shell may each have a starved PATH missing the dirs where coding
 * CLIs actually live (~/.local/bin, homebrew, …). Augment PATH once so every
 * child spawn (providers, git, gh, expect, caffeinate) resolves consistently.
 */
function augmentPath(): void {
  const home = os.homedir();
  const wellKnown = [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".codex", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  const current = (process.env.PATH || "").split(":").filter(Boolean);
  const added: string[] = [];
  for (const dir of wellKnown) {
    if (!current.includes(dir) && existsSync(dir)) { current.push(dir); added.push(dir); }
  }
  if (added.length) {
    process.env.PATH = current.join(":");
    console.error(`[BRIDGE] PATH augmented with: ${added.join(", ")}`);
  }
}

/** Where an agent command actually resolves on the (augmented) PATH — null if nowhere. */
function resolveOnPath(command: string): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  for (const dir of (process.env.PATH || "").split(":")) {
    if (dir && existsSync(path.join(dir, command))) return path.join(dir, command);
  }
  return null;
}

export function createBridge(cfg: BridgeConfig) {
  augmentPath();
  const defaultMode: TaskMode = cfg.defaultMode ?? "auto";
  const allowPackageInstalls = cfg.allowPackageInstalls ?? true;
  const logsDir = path.join(cfg.dataDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const store = new JobStore(path.join(cfg.dataDir, "jobs.sqlite"));

  let registry: ProviderRegistry = new Map();
  const registryReady = loadProviders(cfg.registryPath).then(r => { registry = r; });
  // Boot preflight: say plainly which agents are actually launchable, so a
  // missing binary shows up at startup instead of as a failed job later.
  registryReady.then(() => {
    const lines = [...registry.entries()]
      .filter(([, e]) => !isStub(e))
      .map(([name, e]) => {
        const at = resolveOnPath(e.command);
        return `${name} ${at ? `✓ (${at})` : "✗ NOT FOUND on PATH"}`;
      });
    if (lines.length) console.error(`[BRIDGE] agent preflight: ${lines.join(" · ")}`);
  }).catch(() => {});
  // Boot recovery is smart, not blanket-fail: alive orphans reattach, dead
  // ones follow RESUME_STRATEGY (see recoverJobs below).
  registryReady.then(() => recoverJobs("boot")).then(() => dispatchQueued("boot")).catch(e => console.error("[RECOVERY] boot recovery error:", e.message));

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
  async function validateRepo(repoPath: string): Promise<{ ok: boolean; repo?: string; reason?: string; notGit?: boolean }> {
    const repo = path.resolve(repoPath);
    const s = await stat(repo).catch(() => null);
    if (!s) return { ok: false, reason: `path does not exist: ${repo}` };
    if (!s.isDirectory()) return { ok: false, reason: `path is not a directory: ${repo}` };
    if (!(await cfg.isPathAllowed(repo))) return { ok: false, reason: `path is outside ALLOWED_DIRS: ${repo}` };
    const g = await stat(path.join(repo, ".git")).catch(() => null);
    // notGit is recoverable: callers park the job awaiting permission to `git init`.
    if (!g) return { ok: false, repo, reason: `not a git repository (no .git): ${repo}`, notGit: true };
    return { ok: true, repo };
  }

  function killJobProcess(pid: number): void {
    try { process.kill(-pid, "SIGTERM"); } catch {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
  }

  /** DB state → the generic API vocabulary every response speaks. */
  function apiState(job: JobRecord): string {
    if (job.state === "in_progress") return "running";
    if (job.state === "hold") return job.hold_reason === "needs_input" ? "awaiting_input" : "paused";
    return job.state; // planning | planned | queued | in_review | failed | merged | cancelled | reverted
  }

  async function jobStatusPayload(job: JobRecord, withExcerpt: boolean) {
    const state = apiState(job);
    return {
      jobId: job.job_key,
      state,
      agent: job.provider,
      mode: job.mode,
      repoPath: job.repo_path,
      branch: job.branch || null,
      worktree: job.worktree_path || null,
      prUrl: job.pr_url,
      branchUrl: job.branch_url,
      localOnly: job.local_only === 1,
      mergeCommit: job.merge_commit,
      diffStat: job.diff_stat,
      error: job.error,
      question: job.question,
      pausedReason: state === "paused" ? job.hold_reason : null,
      // Plan results ride along on planned jobs; needsInput flags a pending question.
      ...(job.state === "planned" ? { plan: job.plan, needsInput: !!job.question } : {}),
      ...(job.plan_provider ? { planAgent: job.plan_provider } : {}),
      lastHeartbeat: job.last_heartbeat ? new Date(job.last_heartbeat).toISOString() : null,
      createdAt: new Date(job.created_at).toISOString(),
      startedAt: job.started_at ? new Date(job.started_at).toISOString() : null,
      finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
      mergedAt: job.merged_at ? new Date(job.merged_at).toISOString() : null,
      ...(withExcerpt ? { logExcerpt: await readLogExcerpt(job.task_id) } : {}),
    };
  }

  /** Resolve verifyCommand: explicit param > .bridge.json in the worktree > skip. */
  async function resolveVerifyCommand(job: JobRecord): Promise<string | null> {
    if (job.verify_command) return job.verify_command;
    try {
      const raw = await readFile(path.join(job.worktree_path, ".bridge.json"), "utf-8");
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
   * relayed to the caller via awaiting_input and answer feeds the reply
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
        // Higher-risk action paused the CLI — relay the exact prompt to the caller.
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

    // 2. Verify (param > .bridge.json > skip)
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

    // Empty diff after the build → finish in_review with an empty diffStat so
    // the caller can see at a glance that nothing changed.
    const baseBranch = await detectMainBranch(job.worktree_path).catch(() => null);
    let diffStat = "";
    if (baseBranch) {
      const { stdout: aheadOut } = await git(job.worktree_path, ["rev-list", "--count", `${baseBranch}..${job.branch}`]).catch(() => ({ stdout: "" } as any));
      if (aheadOut.trim() === "0") {
        store.update(taskId, {
          state: "in_review", diff_stat: "", error: null,
          hold_reason: null, prev_state: null, question: null, hold_since: null,
          finished_at: Date.now(), pid: null,
        });
        console.error(`[JOB] ${taskId}: build produced an empty diff — in_review with empty diffStat`);
        return;
      }
      const { stdout: statOut } = await git(job.worktree_path, ["diff", "--shortstat", `${baseBranch}...HEAD`]).catch(() => ({ stdout: "" } as any));
      diffStat = statOut.trim();
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
      diff_stat: diffStat,
      error: null,
      hold_reason: null, prev_state: null, question: null, hold_since: null,
      finished_at: Date.now(),
      pid: null,
    });
  }

  function commitMessage(job: JobRecord): string {
    const summary = job.brief.replace(/\s+/g, " ").trim().slice(0, 60);
    return `job/${job.task_id}: ${summary}`;
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

  /** Full new-row skeleton so insert call sites stay small. */
  function newJobRow(fields: Partial<JobRecord> & { task_id: string; job_key: string; repo_path: string; state: JobState; brief: string; provider: string }): JobRecord {
    const now = Date.now();
    return {
      branch: "", worktree_path: "", verify_command: null,
      pr_url: null, branch_url: null, merge_commit: null, error: null, local_only: null,
      plan: null, plan_provider: null, plan_complex: null, session_id: null, mode: null,
      pending_action: null, diff_stat: null,
      hold_reason: null, prev_state: null, question: null, hold_since: null,
      pid: null, last_heartbeat: now, created_at: now, started_at: now, finished_at: null, merged_at: null, cleaned_at: null,
      ...fields,
    } as JobRecord;
  }

  function upsertJob(existing: JobRecord | undefined, row: JobRecord): string {
    if (existing) {
      const { task_id, created_at, ...fields } = row;
      store.update(existing.task_id, fields);
      return existing.task_id;
    }
    store.insert(row);
    return row.task_id;
  }

  /** Park a job awaiting the user's permission to `git init` the target directory. */
  function requestGitInit(existing: JobRecord | undefined, row: JobRecord, target: "in_progress" | "planning"): any {
    const question = `${row.repo_path} is not a git repository. Reply "yes" (via answer) to let the bridge run \`git init\` with an initial commit and continue, or anything else to abort this job.`;
    const id = upsertJob(existing, {
      ...row,
      state: "hold", hold_reason: "needs_input", prev_state: target,
      pending_action: "git_init", question, hold_since: Date.now(),
    });
    console.error(`[JOB] ${id}: target directory has no git repo — awaiting permission to git init`);
    return { started: true, state: "awaiting_input", jobId: row.job_key, question };
  }

  async function startTask(params: StartTaskParams): Promise<any> {
    await registryReady;
    const { jobId, repoPath, prompt } = params;
    if (!jobId?.trim() || !repoPath?.trim() || !prompt?.trim()) {
      throw new Error("jobId, repoPath, and prompt are all required");
    }
    const taskId = slugifyTaskId(jobId);
    const provider = resolveProvider(registry, params.agent, cfg.defaultProvider);

    // Repo validation BEFORE any work — exact reason, never a guessed path.
    const repoCheck = await validateRepo(repoPath);
    if (!repoCheck.ok && !repoCheck.notGit) return { started: false, error: "invalidRepo", invalidRepo: repoCheck.reason };
    const repo = repoCheck.repo!;

    // Idempotency — jobId is the opaque caller-supplied dedup key.
    const existing = store.getByJobKey(jobId) ?? store.getByTaskId(taskId);
    if (existing && existing.job_key !== jobId) {
      throw new Error(`jobId '${jobId}' collides with existing job '${existing.job_key}' (both slug to '${taskId}'). Job ids must be unique.`);
    }
    if (existing && (existing.state === "in_progress" || (existing.state === "queued" && existing.pending_action === "queued_build"))) {
      return { started: false, alreadyRunning: true, ...(await jobStatusPayload(existing, false)) };
    }
    if (existing && existing.state === "planning") {
      return { started: false, error: "planningInProgress", message: `Job '${jobId}' has a plan run in progress — wait for state 'planned' before building.` };
    }
    if (existing && (existing.state === "merged" || existing.state === "reverted")) {
      throw new Error(`Job '${jobId}' is already ${existing.state}. Use a new jobId for follow-up work.`);
    }

    const branch = params.branch && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(params.branch) ? params.branch : `job/${taskId}`;
    const mode: TaskMode = params.mode === "accept_edits" ? "accept_edits" : params.mode === "auto" ? "auto" : defaultMode;
    const row = newJobRow({
      task_id: existing?.task_id ?? taskId, job_key: jobId, repo_path: repo, branch,
      worktree_path: existing?.worktree_path ?? "", provider: provider.name, state: "in_progress",
      brief: prompt, verify_command: params.verifyCommand ?? existing?.verify_command ?? null, mode,
    });

    // Directory exists but has no .git → never guess: ask permission to init.
    if (repoCheck.notGit) return requestGitInit(existing, row, "in_progress");

    // Capacity full → QUEUE (FIFO); the sweep dispatches as slots free up.
    if (store.countRunning() >= cfg.maxConcurrentJobs) {
      const id = upsertJob(existing, { ...row, state: "queued", pending_action: "queued_build" });
      console.error(`[QUEUE] ${id}: queued (capacity ${cfg.maxConcurrentJobs} full, position ${store.countQueued()})`);
      return { started: true, queued: true, state: "queued", jobId, position: store.countQueued() };
    }

    // A row with no worktree yet has no build history — start fresh from the
    // base branch. A row with a worktree is a re-run: reuse it.
    const hadBuild = !!existing && existing.worktree_path !== "";
    const worktree = (hadBuild && existing!.worktree_path) || path.join(cfg.worktreeRoot, taskId);
    const baseBranch = await detectMainBranch(repo);
    await ensureWorktree({ repo_path: repo, branch, worktree_path: worktree }, baseBranch, hadBuild);

    const effectiveTaskId = upsertJob(existing, { ...row, worktree_path: worktree });
    // Fire and forget — the SSE call returns immediately; runJob owns every outcome.
    runJob(effectiveTaskId).catch((e: any) => fail(effectiveTaskId, `Internal bridge error: ${e.message}`));
    updatePower(); // job active → hold the sleep assertion immediately

    return {
      started: true, jobId, state: "running", branch, worktree,
      agent: provider.name, mode, rework: hadBuild, logPath: logPath(effectiveTaskId),
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
  async function answerTask(jobId: string, answer: string): Promise<any> {
    if (!answer?.trim()) throw new Error("answer is required");
    const job = findJob(jobId);
    if (!job) return { accepted: false, resumed: false, error: "notFound", jobId };
    if (job.state !== "hold" || job.hold_reason !== "needs_input") {
      return { accepted: false, resumed: false, error: "invalidState", message: `Job is '${job.state}'${job.hold_reason ? ` (${job.hold_reason})` : ""} — answer only applies to awaiting_input.` };
    }
    const now = Date.now();

    // Pending git init: the user was asked for permission to initialize the directory.
    if (job.pending_action === "git_init") {
      if (!/^\s*(y(es|ep|eah)?|ok(ay)?|sure|go( ahead)?|init|do it|proceed|approved?)\b/i.test(answer)) {
        fail(job.task_id, `user declined git init for ${job.repo_path}`);
        return { accepted: true, resumed: false, declined: true, state: "failed" };
      }
      await git(job.repo_path, ["init", "-b", "main"]);
      await git(job.repo_path, ["commit", "--allow-empty", "-m", `initial commit (git init authorized via job ${job.job_key})`]);
      console.error(`[JOB] ${job.task_id}: git init authorized and completed in ${job.repo_path}`);
      const target: JobState = job.prev_state === "planning" ? "planning" : "in_progress";
      // Respect the concurrency cap: an authorized job joins the queue like any other.
      if (store.countRunning() >= cfg.maxConcurrentJobs) {
        store.update(job.task_id, { state: "queued", pending_action: target === "planning" ? "queued_plan" : "queued_build", hold_reason: null, question: null, hold_since: null, prev_state: null, error: null });
        return { accepted: true, resumed: true, mode: "git_init", jobId: job.job_key, state: "queued" };
      }
      if (target === "in_progress") {
        const worktree = job.worktree_path || path.join(cfg.worktreeRoot, job.task_id);
        await ensureWorktree({ repo_path: job.repo_path, branch: job.branch, worktree_path: worktree }, "main", false);
        store.update(job.task_id, { state: target, worktree_path: worktree, pending_action: null, hold_reason: null, question: null, hold_since: null, prev_state: null, error: null, started_at: now, last_heartbeat: now });
        runJob(job.task_id).catch((e: any) => fail(job.task_id, `Internal bridge error: ${e.message}`));
      } else {
        store.update(job.task_id, { state: target, pending_action: null, hold_reason: null, question: null, hold_since: null, prev_state: null, error: null, started_at: now, last_heartbeat: now });
        runPlanJob(job.task_id).catch((e: any) => fail(job.task_id, `Internal bridge error: ${e.message}`));
      }
      updatePower();
      return { accepted: true, resumed: true, mode: "git_init", jobId: job.job_key, state: target === "in_progress" ? "running" : "planning" };
    }
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
      return { accepted: true, resumed: true, mode: "session", jobId: job.job_key, state: resumeState === "in_progress" ? "running" : "planning" };
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
    return { accepted: true, resumed: true, mode: "rerun", jobId: job.job_key, state: target === "in_progress" ? "running" : "planning" };
  }

  /**
   * Dispatch a READ-ONLY plan job and return IMMEDIATELY — never leaves the
   * caller hanging on a slow plan. Poll get-job-status: `planning` → still
   * running; `planned` → result in the `plan` field (+ optional question).
   * Refuses (never falls back to build mode) when the provider has no plan mode.
   */
  async function planTask(params: { jobId: string; repoPath: string; prompt: string; agent?: string; complex?: boolean }): Promise<any> {
    await registryReady;
    const { jobId } = params;
    if (!jobId?.trim() || !params.repoPath?.trim() || !params.prompt?.trim()) {
      throw new Error("jobId, repoPath, and prompt are required");
    }
    const taskId = slugifyTaskId(jobId);
    // The caller's agent stays the BUILD agent; only the plan run may be
    // delegated to PLAN_FALLBACK_AGENT when that agent can't plan.
    const provider = resolveProvider(registry, params.agent, cfg.defaultProvider);
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
    if (!repoCheck.ok && !repoCheck.notGit) return { started: false, error: "invalidRepo", invalidRepo: repoCheck.reason };

    const existing = store.getByJobKey(jobId) ?? store.getByTaskId(taskId);
    if (existing && existing.job_key !== jobId) {
      throw new Error(`jobId '${jobId}' collides with existing job '${existing.job_key}' (both slug to '${taskId}'). Job ids must be unique.`);
    }
    if (existing && (existing.state === "planning" || (existing.state === "queued" && existing.pending_action === "queued_plan"))) {
      return { started: false, alreadyPlanning: true, ...(await jobStatusPayload(existing, false)) };
    }
    if (existing && (existing.state === "in_progress" || existing.state === "in_review" || existing.state === "merged" || existing.state === "reverted")) {
      return { started: false, error: "invalidState", message: `Job '${jobId}' is already in build state '${existing.state}' — planning happens before building.` };
    }

    const row = newJobRow({
      task_id: existing?.task_id ?? taskId, job_key: jobId, repo_path: repoCheck.repo!,
      branch: existing?.branch ?? "", worktree_path: existing?.worktree_path ?? "", // plan jobs write nothing and create no branch
      provider: provider.name, state: "planning", brief: params.prompt,
      plan: null, plan_provider: planProvider.name, plan_complex: params.complex ? 1 : 0,
    });

    // Directory exists but has no .git → never guess: ask permission to init.
    if (repoCheck.notGit) return requestGitInit(existing, row, "planning");

    // Capacity full → queue the plan too (FIFO with builds).
    if (store.countRunning() >= cfg.maxConcurrentJobs) {
      const id = upsertJob(existing, { ...row, state: "queued", pending_action: "queued_plan" });
      console.error(`[QUEUE] ${id}: plan queued (capacity ${cfg.maxConcurrentJobs} full)`);
      return { started: true, queued: true, state: "queued", jobId };
    }

    const effectiveTaskId = upsertJob(existing, row);
    runPlanJob(effectiveTaskId).catch((e: any) => fail(effectiveTaskId, `Internal bridge error: ${e.message}`));
    updatePower(); // plan job active → hold the sleep assertion immediately
    return {
      started: true, jobId, state: "planning",
      agent: provider.name, planAgent: planProvider.name,
      ...(planProvider.name !== provider.name ? { fallback: true } : {}),
      logPath: planLogPath(effectiveTaskId),
    };
  }

  /** Kill a running/held/planning job, remove its worktree (builds only), KEEP the branch. */
  async function cancelTask(jobId: string): Promise<any> {
    const job = findJob(jobId);
    if (!job) return { cancelled: false, error: "notFound", jobId };
    if (job.state !== "in_progress" && job.state !== "hold" && job.state !== "planning" && job.state !== "queued") {
      return { cancelled: false, error: "invalidState", message: `Cannot cancel a job in state '${job.state}' — only running, planning, queued, or paused jobs can be cancelled.` };
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
    return { cancelled: true, jobId: job.job_key, ...(job.branch ? { branchKept: job.branch } : {}), ...(job.worktree_path ? { worktreeRemoved: job.worktree_path } : {}) };
  }

  function findJob(ref: string): JobRecord | undefined {
    return store.getByJobKey(ref.trim()) ?? store.getByTaskId(slugifyTaskId(ref));
  }

  async function getJobStatus(jobId?: string): Promise<any> {
    if (jobId?.trim()) {
      const job = findJob(jobId);
      if (!job) return { error: "notFound", jobId };
      return jobStatusPayload(job, true);
    }
    const jobs = store.listRecent(50);
    return { jobs: await Promise.all(jobs.map(j => jobStatusPayload(j, false))) };
  }

  async function mergeTask(jobId: string, action: "merge" | "revert" = "merge"): Promise<any> {
    // Break-glass gate: default OFF; the caller's own approval flow is the real gate.
    if (cfg.confirmationGateEnabled()) {
      return { merged: false, error: "confirmationGateActive", message: "Autonomous merges are disabled: ENABLE_CONFIRMATION_GATE is on. Merge manually or unset the gate." };
    }
    const job = findJob(jobId);
    if (!job) return { merged: false, error: "notFound", jobId };

    const repo = job.repo_path;
    if (await hasUncommittedTrackedChanges(repo)) {
      return { merged: false, error: "dirtyWorkingTree", message: `Working tree at ${repo} has uncommitted changes to tracked files — refusing to ${action}. (Untracked files like .DS_Store don't count.)` };
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
        return { merged: false, error: "invalidState", message: `Cannot revert a job in state '${job.state}' — only merged tasks can be reverted.` };
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
      return { reverted: true, jobId: job.job_key, ...(pushFailed ? { pushFailed } : {}) };
    }

    // action === "merge" — machine-side guard: only reviewable work merges.
    if (job.state !== "in_review") {
      return { merged: false, error: "invalidState", message: `Job is '${job.state}' — merge requires 'in_review'. Approval flows live with the caller; the bridge only checks the work actually finished.` };
    }

    await git(repo, ["checkout", mainBranch]);
    try {
      await git(repo, ["merge", "--no-ff", "--no-edit", job.branch]);
    } catch (e: any) {
      const { stdout: conflictsOut } = await git(repo, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ({ stdout: "" } as any));
      const conflictFiles = conflictsOut.trim().split("\n").filter(Boolean);
      await git(repo, ["merge", "--abort"]).catch(() => {});
      await restoreBranch();
      // Worktree and branch stay intact — the caller decides what happens next.
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
    return { merged: true, jobId: job.job_key, mergeCommit, branchKept: job.branch, ...(pushFailed ? { pushFailed } : {}) };
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

  // ── Queue: capacity overflow waits durably in SQLite and is dispatched
  //    FIFO by the sweep / wake routine as slots free up.
  let dispatching = false;
  async function dispatchQueued(trigger: string): Promise<string[]> {
    if (dispatching) return [];
    dispatching = true;
    const dispatched: string[] = [];
    try {
      for (const job of store.listQueued()) {
        if (store.countRunning() >= cfg.maxConcurrentJobs) break;
        const isPlan = job.pending_action === "queued_plan";
        try {
          if (isPlan) {
            store.update(job.task_id, { state: "planning", pending_action: null, started_at: Date.now(), last_heartbeat: Date.now() });
            runPlanJob(job.task_id).catch((e: any) => fail(job.task_id, `queued plan failed to start: ${e.message}`));
          } else {
            const hadBuild = job.worktree_path !== "";
            const worktree = hadBuild ? job.worktree_path : path.join(cfg.worktreeRoot, job.task_id);
            const baseBranch = await detectMainBranch(job.repo_path);
            await ensureWorktree({ repo_path: job.repo_path, branch: job.branch, worktree_path: worktree }, baseBranch, hadBuild);
            store.update(job.task_id, { state: "in_progress", worktree_path: worktree, pending_action: null, started_at: Date.now(), last_heartbeat: Date.now() });
            runJob(job.task_id).catch((e: any) => fail(job.task_id, `queued build failed to start: ${e.message}`));
          }
          dispatched.push(job.task_id);
          console.error(`[QUEUE] (${trigger}) dispatched ${job.task_id} (${isPlan ? "plan" : "build"})`);
        } catch (e: any) {
          fail(job.task_id, `queued dispatch failed: ${e.message}`);
        }
      }
      updatePower();
      return dispatched;
    } finally {
      dispatching = false;
    }
  }

  // ── Wake routine: verify tunnel → reconcile in-flight jobs → drain the queue ──
  let lastWakeAt: number | null = null;
  async function triggerWake(gapMs = 0): Promise<any> {
    lastWakeAt = Date.now();
    console.error(`[WAKE] wake routine${gapMs ? ` (slept ~${Math.round(gapMs / 1000)}s)` : ""}: tunnel → reconcile → dispatch queue`);
    await checkTunnel("wake");
    const recovery = await recoverJobs("wake");
    const dispatched = await dispatchQueued("wake");
    return { lastWakeAt, tunnel, recovery, dispatched };
  }

  /** Copy-truncate rotation for the launchd service logs (launchd keeps the fd open, so rename-rotation won't work). */
  async function rotateServiceLogs(): Promise<void> {
    const dir = path.join(os.homedir(), ".bridge", "logs");
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
    await dispatchQueued("sweep");
    updatePower();
    await rotateServiceLogs();
  }

  let wakeDetector: WakeDetector | null = null;

  function startSweeps(intervalMs = 60000): NodeJS.Timeout {
    const timer = setInterval(() => { sweep().catch(e => console.error("[BRIDGE] sweep error:", e.message)); }, intervalMs);
    timer.unref();
    // Wake detection (monotonic-clock gap): wake → tunnel check → reconcile → drain queue.
    wakeDetector = new WakeDetector(cfg.wakeGapMs, (gap) => { triggerWake(gap).catch(e => console.error("[WAKE] wake routine error:", e.message)); });
    wakeDetector.start();
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
    dispatchQueued,
    recoverNow: (reason = "manual") => recoverJobs(reason),
    ops: () => ({
      tunnel: { up: tunnel.up, url: tunnel.url, lastCheck: tunnel.lastCheck ? new Date(tunnel.lastCheck).toISOString() : null, monitored: !!cfg.tunnelCheck },
      lastWakeAt: lastWakeAt ? new Date(lastWakeAt).toISOString() : null,
      powerAssertionHeld: power.isHeld(),
      activeJobs: store.countRunning(),
      queueDepth: store.countQueued(),
      reattachedJobs: [...reattachWatch.keys()],
      resumeStrategy: cfg.resumeStrategy,
    }),
    powerPid: () => power.pid(),
    summary: () => store.summary(),
    listUsableProviders: () => usableProviders(registry),
    close: () => {
      for (const [tid] of activePlanSessions) closePlanSession(tid);
      wakeDetector?.stop();
      power.release();
      store.close();
    },
  };
}
