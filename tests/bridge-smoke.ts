/**
 * Build Board bridge smoke test.
 *
 * Drives src/bridge.ts directly — no ngrok, no express, no real coding CLI.
 * Fixtures: temp git repos with local bare repos as `origin`, and shell-script
 * "providers" registered in a test providers.json.
 *
 * Run: SMOKE_TMP=<scratch-dir> npx tsx tests/bridge-smoke.ts
 */
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import os from "os";
import path from "path";
import { createBridge, originToWebUrl, slugifyTaskId } from "../src/bridge.js";
import { JobStore } from "../src/jobs.js";
import { WakeDetector } from "../src/wake.js";

const TMP = process.env.SMOKE_TMP
  ? path.join(process.env.SMOKE_TMP, `bridge-smoke-${process.pid}`)
  : path.join(os.tmpdir(), `bridge-smoke-${process.pid}`);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(name: string) { console.log(`\n── ${name}`); }

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}
function gitOut(repo: string, args: string[]): string { return sh(repo, "git", args).trim(); }

function makeRepo(name: string, withOrigin = true): string {
  const repo = path.join(TMP, "repos", name);
  mkdirSync(repo, { recursive: true });
  sh(repo, "git", ["init", "-b", "main"]);
  sh(repo, "git", ["config", "user.email", "smoke@test.local"]);
  sh(repo, "git", ["config", "user.name", "Bridge Smoke"]);
  writeFileSync(path.join(repo, "README.md"), `# ${name}\n`);
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-m", "initial"]);
  if (withOrigin) {
    const bare = path.join(TMP, "origins", `${name}.git`);
    mkdirSync(path.dirname(bare), { recursive: true });
    sh(TMP, "git", ["init", "--bare", bare]);
    sh(repo, "git", ["remote", "add", "origin", bare]);
    sh(repo, "git", ["push", "-u", "origin", "main"]);
  }
  return repo;
}

// ── Fake providers: shell scripts standing in for coding CLIs ──
const bin = path.join(TMP, "bin");
mkdirSync(bin, { recursive: true });
function script(name: string, body: string): string {
  const p = path.join(bin, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const okSh = script("ok.sh", `date +%s%N >> provider-output.txt\necho "work done"`);
const failSh = script("fail.sh", `echo "compile error: boom" >&2\nexit 1`);
const silentSh = script("silent.sh", `sleep 30`);
const stderrSh = script("stderr.sh", `for i in $(seq 1 14); do echo "progress $i" >&2; sleep 0.3; done\ndate +%s%N >> provider-output.txt`);
const planSh = script("plan.sh", `echo "PLAN:"\necho "1. refactor the module"\necho "2. add tests"`);
const planqSh = script("planq.sh", `echo "I looked at the schema."\necho "Which database should I use?"`);
const oneshotSh = script("oneshot.sh", `printf '# The Plan\\n1. inspect the code\\n2. implement the fix\\n3. add regression tests\\n' > plan.md\necho "plan file written"`);
const interactiveSh = script("interactive.sh", `read brief\necho "Planning: $brief"\necho "What framework should I use?"\nread ans\necho "FINAL PLAN: use $ans for the task with components and routing"`);
const escalatorSh = script("escalator.sh", `if [ "$1" = "--oneshot" ]; then printf 'meh' > plan.md; exit 0; fi\nread brief\necho "Escalated session for: $brief"\necho "Which approach should we take?"\nread a\necho "ESCALATED PLAN: approach $a with full detail and steps"`);
const badflagSh = script("badflag.sh", `echo "flag provided but not defined: --plan" >&2\nexit 2`);
const askfailSh = script("askfail.sh", `brief=$(cat)\nif echo "$brief" | grep -q "Answer to"; then echo "PLAN incorporating the answer: $brief"; exit 0; fi\necho "What DB should I use?"\nexit 3`);
const reattachSh = script("reattach.sh", `date +%s%N >> provider-output.txt\nsleep 30`);
// Supervised (accept_edits) fixture: applies an edit, then pauses on a higher-risk step
const supervisedSh = script("supervised.sh", `echo "applying edits..."\necho "edited content" > supervised-edit.txt\necho "May I run npm install to add the new dependency?"\nread ans\necho "approval received: $ans"\ndate +%s%N >> provider-output.txt`);
const resumableSh = script("resumable.sh", `if [ "$1" = "--resumed" ]; then echo "resumed work" >> provider-output.txt; exit 0; fi\nsleep 30`);
const rerunSh = script("rerun.sh", `if [ -f .ran-once ]; then date +%s%N >> provider-output.txt; exit 0; fi\ntouch .ran-once\nsleep 30`);
const noopSh = script("noop.sh", `echo "analyzed the repo, nothing to change"`);
// Fails with a rate-limit message on the first run, succeeds once .quota-marker exists.
const quotaSh = script("quota.sh", `if [ ! -f .quota-marker ]; then touch .quota-marker; echo "error: 429 rate limit exceeded, try again later" >&2; exit 1; fi\ndate +%s%N >> provider-output.txt\necho "work done after retry"`);
// Build edits a file; the plan-mode one-shot fills a PR template (delivery-mode pr-body plumbing).
const prbodySh = script("prbody.sh", `if [ "$1" = "--pr-body" ]; then echo "FILLED TEMPLATE: all sections answered"; exit 0; fi\ndate +%s%N >> provider-output.txt`);

// ── Stub `gh` on PATH: delivery-mode resolution, PR creation, PR-state polls ──
// Behavior is driven by a mode file: ADMIN | WRITE | READ | UNAUTH | MISSING.
const ghModeFile = path.join(TMP, "gh-mode");
const ghCallsLog = path.join(TMP, "gh-calls.log");
const ghPrStateFile = path.join(TMP, "gh-pr-state");
const setGhMode = (m: string) => writeFileSync(ghModeFile, m);
setGhMode("ADMIN");
process.env.GH_STUB_MODE_FILE = ghModeFile;
process.env.GH_STUB_LOG = ghCallsLog;
process.env.GH_STUB_PR_STATE_FILE = ghPrStateFile;
process.env.GH_STUB_DIR = TMP;
script("gh", `mode=$(cat "$GH_STUB_MODE_FILE" 2>/dev/null || echo ADMIN)
echo "$*" >> "$GH_STUB_LOG"
if [ "$mode" = "MISSING" ]; then echo "gh: command not found" >&2; exit 127; fi
case "$1 $2" in
  "auth status") if [ "$mode" = "UNAUTH" ]; then echo "You are not logged into any GitHub hosts." >&2; exit 1; fi ;;
  "repo view") if [ "$mode" = "UNAUTH" ]; then echo "not logged in" >&2; exit 1; fi; printf '{"viewerPermission":"%s","owner":{"login":"upstream-owner"}}\\n' "$mode" ;;
  "api user") echo "stub-user" ;;
  "repo fork") echo "created fork stub-user/repo" ;;
  "pr create") prev=""; for a in "$@"; do if [ "$prev" = "--body-file" ]; then cp "$a" "$GH_STUB_DIR/last-pr-body.md"; fi; prev="$a"; done; echo "https://github.com/upstream-owner/repo/pull/42" ;;
  "pr view") printf '{"state":"%s"}\\n' "$(cat "$GH_STUB_PR_STATE_FILE" 2>/dev/null || echo OPEN)" ;;
esac
exit 0`);
process.env.PATH = `${bin}:${process.env.PATH || ""}`;

const registryPath = path.join(TMP, "providers.json");
writeFileSync(registryPath, JSON.stringify({
  "ok":      { command: okSh,     buildArgs: [], promptVia: "stdin" }, // no planArgs → planSupported:false
  "fail":    { command: failSh,   buildArgs: [], promptVia: "stdin" },
  "silent":  { command: silentSh, buildArgs: [], promptVia: "stdin" },
  "stderr":  { command: stderrSh, buildArgs: [], promptVia: "stdin" },
  "noop":    { command: noopSh,   buildArgs: [], promptVia: "stdin" },
  "quota":   { command: quotaSh,  buildArgs: [], promptVia: "stdin" },
  "prbody":  { command: prbodySh, buildArgs: [], planArgs: ["--pr-body"], planSupported: true, promptVia: "stdin" },
  "planner": { command: planSh,   buildArgs: [], planArgs: ["--plan-mode"], planSupported: true, promptVia: "stdin" },
  "planq":   { command: planqSh,  buildArgs: [], planArgs: ["--plan-mode"], planSupported: true, promptVia: "stdin" },
  "planSlow": { command: silentSh, buildArgs: [], planArgs: ["--plan-mode"], planSupported: true, promptVia: "stdin" },
  "oneshot":  { command: oneshotSh, buildArgs: [], planMode: "oneshot", planArgs: ["--oneshot"], planOutputFile: "plan.md", promptVia: "stdin" },
  "interactive": { command: interactiveSh, buildArgs: [], planMode: "interactive", planSend: ["{brief}\r"], planInteractiveArgs: [], promptVia: "arg" },
  "escalator": { command: escalatorSh, buildArgs: [], planMode: "oneshot", planArgs: ["--oneshot"], planOutputFile: "plan.md", planSend: ["{brief}\r"], planInteractiveArgs: [], promptVia: "stdin" },
  "badflag":  { command: badflagSh, buildArgs: [], planMode: "headless", planArgs: ["--plan"], promptVia: "stdin" },
  "askfail":  { command: askfailSh, buildArgs: [], planMode: "headless", planArgs: ["run"], promptVia: "stdin" },
  "undrivable-pty": { command: path.join(bin, "missing-tui"), buildArgs: [], planMode: "interactive", planSend: ["x"], planInteractiveArgs: [], promptVia: "arg" },
  "reattach": { command: reattachSh, buildArgs: [], promptVia: "stdin" },
  "supervised": { command: supervisedSh, buildArgs: ["--auto-mode"], acceptEditsArgs: ["--supervised", "{brief}"], promptVia: "arg" },
  "resumable": { command: resumableSh, buildArgs: [], promptVia: "stdin", resumeArgsTemplate: ["--resumed", "{nudge}"] },
  "rerun": { command: rerunSh, buildArgs: [], promptVia: "stdin" },
  "enoent":  { command: path.join(bin, "does-not-exist"), buildArgs: [], promptVia: "arg" },
  "stub":    { command: "", buildArgs: [], promptVia: "arg" },
}, null, 2));

function makeBridge(name: string, overrides: Partial<Parameters<typeof createBridge>[0]> = {}) {
  return createBridge({
    dataDir: path.join(TMP, "data", name),
    registryPath,
    worktreeRoot: path.join(TMP, "worktrees", name),
    defaultProvider: "ok",
    maxConcurrentJobs: 10,
    heartbeatTimeoutMs: 15 * 60 * 1000,
    jobMaxRuntimeMs: 2 * 60 * 60 * 1000,
    revertWindowHours: 168,
    planTimeoutMs: 60000,
    holdRetryMs: 200,
    planFallbackAgent: "", // no fallback unless a test opts in
    planMinChars: 10,
    planIdleMs: 700,
    resumeStrategy: "resume" as const,
    wakeGapMs: 120000,
    confirmationGateEnabled: () => false,
    isPathAllowed: async () => true,
    ...overrides,
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForTerminal(bridge: any, jobId: string, timeoutMs = 30000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await bridge.getJobStatus(jobId);
    if (s.state && s.state !== "running" && s.state !== "planning") return s;
    await sleep(250);
  }
  return bridge.getJobStatus(jobId);
}

async function waitForState(bridge: any, jobId: string, want: string, timeoutMs = 20000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await bridge.getJobStatus(jobId);
    if (s.state === want) return s;
    await sleep(200);
  }
  return bridge.getJobStatus(jobId);
}

async function main() {
  // ═══ 1. Happy path: async start → LOCAL-ONLY in_review → owned-repo merge → revert ═══
  section("1. Happy path (local-only build, ownership → merge mode, branch deleted, revert)");
  const bridge = makeBridge("main");
  const repo1 = makeRepo("repo1");
  const t0 = Date.now();
  const r1 = await bridge.startTask({ jobId: "101", repoPath: repo1, prompt: "add the feature" });
  assert(Date.now() - t0 < 5000 && r1.state === "running", "start returns immediately with state=running", JSON.stringify(r1));
  assert(r1.branch === "job/101", "branch is task/<id>", r1.branch);
  assert(!r1.worktree.startsWith(repo1), "worktree is OUTSIDE the repo tree", r1.worktree);

  const s1 = await waitForTerminal(bridge, "101");
  assert(s1.state === "in_review", "job reaches in_review", JSON.stringify(s1.error));
  assert(gitOut(repo1, ["log", "job/101", "--oneline"]).includes("job/101: add the feature"), "commit exists on job/101 with job/<id>: <summary> message");
  const bare1 = path.join(TMP, "origins", "repo1.git");
  assert(!gitOut(bare1, ["branch", "--list", "job/101"]).includes("job/101"), "NO push at build time — origin has no job branch");
  assert(s1.prUrl === null && s1.branchUrl === null && s1.localOnly === true, "NO PR at build time — in_review is local-only", JSON.stringify({ prUrl: s1.prUrl, branchUrl: s1.branchUrl, localOnly: s1.localOnly }));
  assert(typeof s1.diffStat === "string" && s1.diffStat.includes("1 file"), "diffStat captured for review from the local diff", s1.diffStat);
  assert(typeof s1.logExcerpt === "string" && s1.logExcerpt.includes("work done"), "getJobStatus returns log excerpt");

  // merge refusal on dirty tree — TRACKED modifications block…
  writeFileSync(path.join(repo1, "README.md"), "# repo1 — locally modified\n");
  const mDirty = await bridge.mergeTask("101");
  assert(mDirty.merged === false && mDirty.error === "dirtyWorkingTree", "merge refused when a TRACKED file is modified", JSON.stringify(mDirty));
  sh(repo1, "git", ["checkout", "--", "README.md"]);
  // …but untracked junk (.DS_Store & friends) must NOT block the merge below
  writeFileSync(path.join(repo1, ".DS_Store"), "macos junk");
  writeFileSync(path.join(repo1, "scratch-note.txt"), "untracked");

  // merge refusal on wrong state (fresh unknown task)
  const mUnknown = await bridge.mergeTask("999");
  assert(mUnknown.merged === false && mUnknown.error === "notFound", "merge of unknown task refused");

  const m1 = await bridge.mergeTask("101");
  assert(m1.merged === true && !!m1.mergeCommit, "merge succeeds despite untracked .DS_Store present", JSON.stringify(m1));
  assert(m1.deliveredVia === "merge", "stub gh reports ADMIN → owned repo → merge mode", JSON.stringify(m1));
  const parents = gitOut(repo1, ["rev-list", "--parents", "-n", "1", m1.mergeCommit]).split(" ");
  assert(parents.length === 3, "--no-ff produced a real merge commit (2 parents)");
  assert(gitOut(bare1, ["rev-parse", "main"]) === m1.mergeCommit, "main pushed to origin");
  assert(!gitOut(bare1, ["branch", "--list", "job/101"]).includes("job/101"), "ONLY main pushed — origin never sees the job branch");
  assert(!gitOut(repo1, ["branch", "--list", "job/101"]).includes("job/101"), "branch DELETED immediately at merge — no retention window");
  assert(!existsSync(r1.worktree), "worktree removed at merge");
  const s1Merged = await bridge.getJobStatus("101");
  assert(s1Merged.deliveryMode === "merge", "resolved deliveryMode exposed in get_status", s1Merged.deliveryMode);

  // double-merge refused
  const m1b = await bridge.mergeTask("101");
  assert(m1b.merged === false && m1b.error === "invalidState", "second merge refused (state=merged)");

  // revert within window — works from the stored merge_commit AFTER branch deletion
  const rv = await bridge.mergeTask("101", "revert");
  assert(rv.reverted === true, "revert succeeds within window despite the branch being gone (operates on merge_commit)", JSON.stringify(rv));
  assert(gitOut(repo1, ["log", "-1", "--format=%s", "main"]).startsWith("Revert"), "main HEAD is the revert commit");
  const rvAgain = await bridge.mergeTask("101", "revert");
  assert(rvAgain.merged === false && rvAgain.error === "invalidState", "second revert refused (state=reverted)");

  // ═══ 2. Verify precedence + verify-fail keeps work local ═══
  section("2. verifyCommand (param fail → failed, committed locally, NOT pushed)");
  const repo2 = makeRepo("repo2");
  await bridge.startTask({ jobId: "102", repoPath: repo2, prompt: "verify fails", verifyCommand: "echo 'tests failed'; exit 1" });
  const s2 = await waitForTerminal(bridge, "102");
  assert(s2.state === "failed", "verify failure → state=failed", s2.state);
  assert((s2.error ?? "").includes("Verify command failed"), "error names the verify failure", s2.error);
  assert(gitOut(repo2, ["log", "job/102", "--oneline"]).length > 0, "work committed locally on task branch");
  const bare2 = path.join(TMP, "origins", "repo2.git");
  assert(!gitOut(bare2, ["branch", "--list", "job/102"]).includes("job/102"), "nothing pushed on verify failure");

  // .buildboard.json fallback
  const repo3 = makeRepo("repo3");
  writeFileSync(path.join(repo3, ".bridge.json"), JSON.stringify({ verifyCommand: "exit 1" }));
  sh(repo3, "git", ["add", "-A"]); sh(repo3, "git", ["commit", "-m", "add buildboard config"]); sh(repo3, "git", ["push", "origin", "main"]);
  await bridge.startTask({ jobId: "103", repoPath: repo3, prompt: "buildboard verify" });
  const s3 = await waitForTerminal(bridge, "103");
  assert(s3.state === "failed" && (s3.error ?? "").includes("exit 1"), ".bridge.json verifyCommand is picked up and enforced", s3.error);

  // ═══ 3. Fast non-zero exit + ENOENT never strand in_progress ═══
  section("3. Provider failure modes (fast exit 1, ENOENT, unknown/stub provider)");
  const repo4 = makeRepo("repo4");
  await bridge.startTask({ jobId: "104", repoPath: repo4, prompt: "crash fast", agent: "fail" });
  const s4 = await waitForTerminal(bridge, "104");
  assert(s4.state === "failed", "provider exit 1 → failed (not stranded in_progress)", s4.state);
  assert((s4.error ?? "").includes("exited with code 1") && (s4.error ?? "").includes("compile error: boom"), "exit code and stderr output captured in error", s4.error);

  await bridge.startTask({ jobId: "105", repoPath: repo4, prompt: "bad binary", agent: "enoent" });
  const s5 = await waitForTerminal(bridge, "105");
  assert(s5.state === "failed" && (s5.error ?? "").includes("could not be started"), "ENOENT command → failed with spawn error", s5.error);

  const unknownErr = await bridge.startTask({ jobId: "106", repoPath: repo4, prompt: "x", agent: "nope" }).catch((e: any) => e.message);
  assert(typeof unknownErr === "string" && unknownErr.includes("Unknown coding agent") && unknownErr.includes("ok"), "unknown provider fails fast, lists usable providers", unknownErr);
  const stubErr = await bridge.startTask({ jobId: "107", repoPath: repo4, prompt: "x", agent: "stub" }).catch((e: any) => e.message);
  assert(typeof stubErr === "string" && stubErr.includes("stub"), "stub provider fails fast with clear message", stubErr);

  // ═══ 4. Idempotency + stale kill + stderr-only liveness (3s heartbeat bridge) ═══
  section("4. alreadyRunning dedup, stale-heartbeat kill, stderr-only NOT falsely killed");
  const fastBridge = makeBridge("fast", { heartbeatTimeoutMs: 3000 });
  const repo5 = makeRepo("repo5");
  const rSilent = await fastBridge.startTask({ jobId: "201", repoPath: repo5, prompt: "sleep", agent: "silent" });
  assert(rSilent.state === "running", "silent job dispatched");
  const dup = await fastBridge.startTask({ jobId: "201", repoPath: repo5, prompt: "sleep again", agent: "silent" });
  assert(dup.alreadyRunning === true, "duplicate dispatch (same pageId) → alreadyRunning, no second process", JSON.stringify(dup));

  const repo6 = makeRepo("repo6");
  await fastBridge.startTask({ jobId: "202", repoPath: repo6, prompt: "stderr progress", agent: "stderr" });
  await sleep(3500); // silent job is now stale; stderr job has been chattering on stderr only
  await fastBridge.sweep();
  const sSilent = await fastBridge.getJobStatus("201");
  assert(sSilent.state === "failed" && (sSilent.error ?? "").includes("stale"), "truly-silent job killed by stale sweep", JSON.stringify({ state: sSilent.state, error: sSilent.error }));
  const sStderr = await fastBridge.getJobStatus("202");
  assert(sStderr.state === "running" || sStderr.state === "in_review", "stderr-only job NOT falsely killed (heartbeat bumps on stderr)", sStderr.state);
  const sStderrFinal = await waitForTerminal(fastBridge, "202");
  assert(sStderrFinal.state === "in_review", "stderr-only job completes normally", sStderrFinal.error ?? sStderrFinal.state);

  // ═══ 5. Concurrency cap ═══
  section("5. Concurrency cap");
  const capBridge = makeBridge("cap", { maxConcurrentJobs: 1, heartbeatTimeoutMs: 2500 });
  const repo7 = makeRepo("repo7");
  await capBridge.startTask({ jobId: "301", repoPath: repo7, prompt: "hog the slot", agent: "silent" });
  const capHit = await capBridge.startTask({ jobId: "302", repoPath: repo7, prompt: "wait my turn" });
  assert(capHit.queued === true && capHit.state === "queued", "second dispatch at cap → QUEUED (FIFO), not rejected", JSON.stringify(capHit));
  const capStatus = await capBridge.getJobStatus("302");
  assert(capStatus.state === "queued", "queued job visible in get_status", capStatus.state);
  assert((await capBridge.startTask({ jobId: "302", repoPath: repo7, prompt: "wait my turn" })).alreadyRunning === true, "re-start of a queued job dedups (alreadyRunning)");
  await capBridge.cancelTask("302"); // drain the queue before the stale sweep below
  await sleep(3000);
  await capBridge.sweep(); // clean up the hog

  // ═══ 6. Rework: reuse branch + worktree, never recreate from main ═══
  section("6. Rework re-dispatch");
  const repo8 = makeRepo("repo8");
  const rw1 = await bridge.startTask({ jobId: "401", repoPath: repo8, prompt: "first attempt", verifyCommand: "exit 1" });
  const rwFail = await waitForTerminal(bridge, "401");
  assert(rwFail.state === "failed", "first attempt fails (verify)", rwFail.state);
  const commitBefore = gitOut(repo8, ["rev-parse", "job/401"]);
  const rw2 = await bridge.startTask({ jobId: "401", repoPath: repo8, prompt: "second attempt, fix it", verifyCommand: "true" });
  assert(rw2.rework === true && rw2.worktree === rw1.worktree, "rework reuses the SAME worktree path", `${rw1.worktree} vs ${rw2.worktree}`);
  const rwOk = await waitForTerminal(bridge, "401");
  assert(rwOk.state === "in_review", "rework attempt reaches in_review", rwOk.error ?? rwOk.state);
  const log401 = gitOut(repo8, ["log", "job/401", "--format=%H"]).split("\n");
  assert(log401.includes(commitBefore), "prior attempt's commit still present — branch NOT recreated from main");
  assert(log401.length >= 2, "rework appended a new commit on top");

  // ═══ 7. No-origin repo → graceful local-only ═══
  section("7. No-origin repo");
  const repo9 = makeRepo("repo9", false);
  await bridge.startTask({ jobId: "501", repoPath: repo9, prompt: "local only work" });
  const s9 = await waitForTerminal(bridge, "501");
  assert(s9.state === "in_review" && s9.localOnly === true && s9.error === null, "no origin → in_review with localOnly:true, no push error", JSON.stringify({ state: s9.state, localOnly: s9.localOnly, error: s9.error }));

  // ═══ 8. Rebase conflict against a moved origin/main ═══
  section("8. Rebase conflict (origin/main moved, branch conflicts)");
  const repo10 = makeRepo("repo10");
  const rc = await bridge.startTask({ jobId: "601", repoPath: repo10, prompt: "conflicting work" });
  const sc = await waitForTerminal(bridge, "601");
  assert(sc.state === "in_review", "conflict fixture reaches in_review first", sc.error ?? sc.state);
  // Move origin/main with content that conflicts with the branch (same file, different content)
  writeFileSync(path.join(repo10, "provider-output.txt"), "conflicting main content\n");
  sh(repo10, "git", ["add", "-A"]); sh(repo10, "git", ["commit", "-m", "diverge main"]);
  sh(repo10, "git", ["push", "origin", "main"]);
  sh(repo10, "git", ["reset", "--hard", "HEAD~1"]); // local main behind; origin/main moved ahead
  const mc = await bridge.mergeTask("601");
  assert(mc.merged === false && mc.conflict === true, "rebase onto the synced main conflicts — not merged", JSON.stringify(mc));
  assert(Array.isArray(mc.conflictFiles) && mc.conflictFiles.includes("provider-output.txt"), "conflict files reported", JSON.stringify(mc.conflictFiles));
  const bare10 = path.join(TMP, "origins", "repo10.git");
  assert(gitOut(repo10, ["rev-parse", "main"]) === gitOut(bare10, ["rev-parse", "main"]), "local main was --ff-only synced to the moved origin/main before the rebase");
  assert(existsSync(rc.worktree), "worktree kept intact on conflict (the dispatcher re-dispatches the agent to reconcile)");
  assert(gitOut(repo10, ["status", "--porcelain"]) === "", "repo left clean after aborted rebase");
  const scAfter = await bridge.getJobStatus("601");
  assert(scAfter.state === "in_review" && (scAfter.error ?? "").includes("conflict"), "job stays in_review with conflict noted", JSON.stringify({ state: scAfter.state, error: scAfter.error }));

  // ═══ 8b. Diverged local main → mainDiverged, never guess, never force ═══
  section("8b. Diverged local main");
  const repoDiv = makeRepo("repoDiv");
  await bridge.startTask({ jobId: "602", repoPath: repoDiv, prompt: "diverge fixture" });
  const sDiv = await waitForTerminal(bridge, "602");
  assert(sDiv.state === "in_review", "diverge fixture builds", sDiv.error ?? sDiv.state);
  // origin/main moves via a second clone…
  const divClone = path.join(TMP, "repos", "repoDiv-clone");
  sh(TMP, "git", ["clone", path.join(TMP, "origins", "repoDiv.git"), divClone]);
  sh(divClone, "git", ["config", "user.email", "smoke@test.local"]);
  sh(divClone, "git", ["config", "user.name", "Bridge Smoke"]);
  writeFileSync(path.join(divClone, "upstream.txt"), "upstream change\n");
  sh(divClone, "git", ["add", "-A"]); sh(divClone, "git", ["commit", "-m", "upstream moves"]); sh(divClone, "git", ["push", "origin", "main"]);
  // …while local main commits something different
  writeFileSync(path.join(repoDiv, "local.txt"), "local change\n");
  sh(repoDiv, "git", ["add", "-A"]); sh(repoDiv, "git", ["commit", "-m", "local diverges"]);
  const mDiv = await bridge.mergeTask("602");
  assert(mDiv.merged === false && mDiv.error === "mainDiverged", "diverged local main → { error: mainDiverged }", JSON.stringify(mDiv));
  assert(typeof mDiv.message === "string" && mDiv.message.length > 0, "exact git error surfaced in message", mDiv.message);
  assert((await bridge.getJobStatus("602")).state === "in_review", "job untouched by mainDiverged — still in_review");

  // ═══ 9. Confirmation gate (break-glass) ═══
  section("9. Break-glass confirmation gate");
  const gatedBridge = makeBridge("gated", { confirmationGateEnabled: () => true });
  const gRes = await gatedBridge.mergeTask("601");
  assert(gRes.merged === false && gRes.error === "confirmationGateActive", "gate ON → merge-task refuses outright", JSON.stringify(gRes));

  // ═══ 10. Restart recovery ═══
  section("10. Restart recovery (durable store)");
  const restartDb = path.join(TMP, "data", "restart", "jobs.sqlite");
  const storeA = new JobStore(restartDb);
  const baseRow = {
    repo_path: repo1, provider: "ok", brief: "interrupted", verify_command: null,
    pr_url: null, branch_url: null, merge_commit: null, error: null, local_only: null, plan: null, plan_provider: null, plan_complex: null, session_id: null, mode: null, pending_action: null, diff_stat: null, delivery_mode: null,
    hold_reason: null, prev_state: null, question: null, hold_since: null,
    pid: null, last_heartbeat: Date.now(), started_at: Date.now(), finished_at: null, merged_at: null, cleaned_at: null,
  };
  storeA.insert({ ...baseRow, task_id: "701", job_key: "701", branch: "job/701", worktree_path: "/nowhere", state: "in_progress" });
  storeA.insert({ ...baseRow, task_id: "702", job_key: "702", branch: "", worktree_path: "", state: "planning" });
  storeA.close();
  const storeB = new JobStore(restartDb);
  const recovered = storeB.recoverInterrupted();
  const j701 = storeB.getByTaskId("701");
  const j702 = storeB.getByTaskId("702");
  assert(recovered === 2 && j701?.state === "failed" && (j701?.error ?? "").includes("bridge restarted"), "in_progress job marked failed on boot", JSON.stringify({ recovered, state: j701?.state }));
  assert(j702?.state === "failed", "orphaned PLANNING job also marked failed on boot", j702?.state);
  storeB.close();

  // ═══ 11. Delivery mode "pr": non-owned repo → branch push + real PR ═══
  section("11. pr mode (WRITE collaborator — ownership decides, not push capability)");
  const repo11 = makeRepo("repo11");
  sh(repo11, "git", ["checkout", "-b", "parked"]); // prove pr mode never touches local main/HEAD
  const mainShaBefore = gitOut(repo11, ["rev-parse", "main"]);
  await bridge.startTask({ jobId: "801", repoPath: repo11, prompt: "work for a PR" });
  const s801 = await waitForTerminal(bridge, "801");
  assert(s801.state === "in_review", "pr fixture builds to in_review", s801.error ?? s801.state);
  setGhMode("WRITE");
  const m801 = await bridge.mergeTask("801");
  setGhMode("ADMIN");
  assert(m801.merged === true && m801.deliveredVia === "pr", "WRITE collaborator → pr mode even though a push would succeed", JSON.stringify(m801));
  assert((m801.prUrl ?? "").includes("/pull/42"), "real PR URL returned", m801.prUrl);
  const bare11 = path.join(TMP, "origins", "repo11.git");
  assert(gitOut(bare11, ["branch", "--list", "job/801"]).includes("job/801"), "job BRANCH pushed to origin");
  assert(gitOut(bare11, ["rev-parse", "main"]) === mainShaBefore, "origin main untouched by pr delivery — never pushed");
  assert(gitOut(repo11, ["rev-parse", "main"]) === mainShaBefore && gitOut(repo11, ["rev-parse", "--abbrev-ref", "HEAD"]) === "parked", "local main never written, HEAD never moved (pr mode)");
  assert(readFileSync(ghCallsLog, "utf-8").includes("pr create"), "gh pr create was called");
  assert(readFileSync(path.join(TMP, "last-pr-body.md"), "utf-8").includes("## Summary"), "no template → structured fallback body (## Summary/Changes/Testing)");
  const s801Merged = await bridge.getJobStatus("801");
  assert(s801Merged.state === "merged" && s801Merged.deliveryMode === "pr" && (s801Merged.prUrl ?? "").includes("/pull/42"), "job merged with deliveryMode=pr and pr_url stored", JSON.stringify({ state: s801Merged.state, deliveryMode: s801Merged.deliveryMode, prUrl: s801Merged.prUrl }));
  assert(gitOut(repo11, ["branch", "--list", "job/801"]).includes("job/801") && existsSync(s801Merged.worktree), "branch AND worktree KEPT while the PR is open");
  // revert on a pr-mode delivery → clear error
  const rv801 = await bridge.mergeTask("801", "revert");
  assert(rv801.merged === false && rv801.error === "prDelivery" && (rv801.message ?? "").includes("upstream"), "revert on a pr-mode job → clear 'revert the PR upstream' error", JSON.stringify(rv801));
  // sweep poll: PR reports MERGED upstream → local branch + worktree cleaned; remote branch untouched
  writeFileSync(ghPrStateFile, "MERGED");
  await bridge.sweep();
  writeFileSync(ghPrStateFile, "OPEN");
  assert(!existsSync(s801Merged.worktree) && !gitOut(repo11, ["branch", "--list", "job/801"]).includes("job/801"), "PR closed upstream → sweep cleaned local branch + worktree");
  assert(gitOut(bare11, ["branch", "--list", "job/801"]).includes("job/801"), "sweep NEVER deletes branches on origin (no push origin --delete)");

  // ═══ 11b. PR template → body filled by the job's own provider one-shot ═══
  section("11b. PR template filled by the provider");
  const repo11b = makeRepo("repo11b");
  mkdirSync(path.join(repo11b, ".github"), { recursive: true });
  writeFileSync(path.join(repo11b, ".github", "PULL_REQUEST_TEMPLATE.md"), "## Why\n\n## Checklist\n- [ ] tests\n");
  sh(repo11b, "git", ["add", "-A"]); sh(repo11b, "git", ["commit", "-m", "add PR template"]); sh(repo11b, "git", ["push", "origin", "main"]);
  await bridge.startTask({ jobId: "802", repoPath: repo11b, prompt: "templated pr", agent: "prbody" });
  const s802 = await waitForTerminal(bridge, "802");
  assert(s802.state === "in_review", "template fixture builds", s802.error ?? s802.state);
  setGhMode("WRITE");
  const m802 = await bridge.mergeTask("802");
  setGhMode("ADMIN");
  assert(m802.merged === true && m802.deliveredVia === "pr", "template fixture delivered via pr", JSON.stringify(m802));
  assert(readFileSync(path.join(TMP, "last-pr-body.md"), "utf-8").includes("FILLED TEMPLATE"), "PR body produced by the provider one-shot from the discovered template");

  // ═══ 12. invalidRepo: exact reasons, never guessed paths ═══
  section("12. invalidRepo validation");
  const badPath = await bridge.startTask({ jobId: "901", repoPath: path.join(TMP, "does-not-exist"), prompt: "x" });
  assert(badPath.error === "invalidRepo" && badPath.invalidRepo.includes("does not exist"), "nonexistent path → invalidRepo with exact reason", JSON.stringify(badPath));
  const notGit = path.join(TMP, "not-a-repo");
  mkdirSync(notGit, { recursive: true });
  // Non-git directory: never guessed, never auto-initialized — the job parks
  // awaiting the user's explicit permission to git init.
  const badGit = await bridge.startTask({ jobId: "902", repoPath: notGit, prompt: "add a readme", agent: "ok" });
  assert(badGit.state === "awaiting_input" && (badGit.question ?? "").includes("git init"), "non-git dir → awaiting_input asking permission to git init", JSON.stringify(badGit));
  const initAns = await bridge.answerTask("902", "yes, go ahead");
  assert(initAns.accepted === true && initAns.mode === "git_init", "affirmative answer authorizes git init and resumes", JSON.stringify(initAns));
  const initDone = await waitForState(bridge, "902", "in_review");
  assert(initDone.state === "in_review", "job completes after authorized git init", initDone.error ?? initDone.state);
  assert(existsSync(path.join(notGit, ".git")), "repo was git-initialized in place");
  // Declining aborts the job
  const notGit2 = path.join(TMP, "not-a-repo-2");
  mkdirSync(notGit2, { recursive: true });
  await bridge.startTask({ jobId: "904", repoPath: notGit2, prompt: "x", agent: "ok" });
  const declineAns = await bridge.answerTask("904", "no thanks");
  assert(declineAns.declined === true && (await bridge.getJobStatus("904")).state === "failed", "declining git init fails the job cleanly", JSON.stringify(declineAns));
  assert(!existsSync(path.join(notGit2, ".git")), "declined directory left untouched");
  const deniedBridge = makeBridge("denied", { isPathAllowed: async () => false });
  const badAllow = await deniedBridge.startTask({ jobId: "903", repoPath: repo1, prompt: "x" });
  assert(badAllow.error === "invalidRepo" && badAllow.invalidRepo.includes("ALLOWED_DIRS"), "path outside allowlist → invalidRepo(ALLOWED_DIRS)", JSON.stringify(badAllow));

  // ═══ 13. plan-task: ASYNC read-only plan job ═══
  section("13. plan-task (async job)");
  const repoPlan = makeRepo("repoPlan");
  const tPlan = Date.now();
  const planStart = await bridge.planTask({ jobId: "1001", repoPath: repoPlan, prompt: "plan the refactor", agent: "planner" });
  assert(Date.now() - tPlan < 3000 && planStart.started === true && planStart.state === "planning", "plan-task returns IMMEDIATELY with {started:true, state:planning}", JSON.stringify(planStart));
  const planDone = await waitForTerminal(bridge, "1001");
  assert(planDone.state === "planned", "plan job reaches state=planned", JSON.stringify({ state: planDone.state, error: planDone.error }));
  assert(typeof planDone.plan === "string" && planDone.plan.includes("PLAN:") && planDone.plan.includes("add tests"), "planned job carries the plan text in the `plan` field", planDone.plan?.slice(0, 80));
  assert(planDone.needsInput === false, "no pending question → needsInput:false");
  assert(gitOut(repoPlan, ["status", "--porcelain"]) === "" && !gitOut(repoPlan, ["branch", "--list", "job/1001"]).includes("job/1001"), "plan run left the repo untouched (no writes, no branch)");

  // alreadyPlanning dedup on a slow plan
  const repoPlan2 = makeRepo("repoPlan2");
  const slowPlanStart = await bridge.planTask({ jobId: "1002", repoPath: repoPlan2, prompt: "slow plan", agent: "planSlow" });
  assert(slowPlanStart.started === true, "slow plan dispatched", JSON.stringify(slowPlanStart));
  const dupPlan = await bridge.planTask({ jobId: "1002", repoPath: repoPlan2, prompt: "slow plan again", agent: "planSlow" });
  assert(dupPlan.alreadyPlanning === true && dupPlan.started === false, "duplicate plan-task → alreadyPlanning, no second run", JSON.stringify({ started: dupPlan.started, alreadyPlanning: dupPlan.alreadyPlanning }));
  // start-task during planning refuses
  const buildDuringPlan = await bridge.startTask({ jobId: "1002", repoPath: repoPlan2, prompt: "build now" });
  assert(buildDuringPlan.error === "planningInProgress", "start-task during planning → planningInProgress", JSON.stringify(buildDuringPlan));
  // cancel a planning job (no worktree to clean)
  const cPlan = await bridge.cancelTask("1002");
  assert(cPlan.cancelled === true, "planning job can be cancelled", JSON.stringify(cPlan));

  // planned → build on the SAME task: fresh branch from main, plan retained
  const buildAfterPlan = await bridge.startTask({ jobId: "1001", repoPath: repoPlan, prompt: "now build it" });
  assert(buildAfterPlan.state === "running" && buildAfterPlan.branch === "job/1001", "start-task after planned → build begins on the same row", JSON.stringify(buildAfterPlan));
  const builtAfterPlan = await waitForTerminal(bridge, "1001");
  assert(builtAfterPlan.state === "in_review", "plan→build transition completes to in_review", builtAfterPlan.error ?? builtAfterPlan.state);

  // needsInput: plan that ends with a question (exit 0) → planned + question
  const planQStart = await bridge.planTask({ jobId: "1003", repoPath: repoPlan2, prompt: "plan it", agent: "planq" });
  assert(planQStart.started === true, "question-plan dispatched", JSON.stringify(planQStart));
  const planQDone = await waitForTerminal(bridge, "1003");
  assert(planQDone.state === "planned" && planQDone.needsInput === true && (planQDone.question ?? "").includes("Which database"), "plan asking a question → planned with needsInput + question", JSON.stringify({ state: planQDone.state, needsInput: planQDone.needsInput, question: planQDone.question }));

  // refusal + validation are still synchronous structured returns
  const planRefuse = await bridge.planTask({ jobId: "1004", repoPath: repoPlan, prompt: "plan it", agent: "ok" });
  assert(planRefuse.error === "planUnsupported" && planRefuse.planSupported === false && planRefuse.message.includes("planner"), "planSupported:false + NO fallback configured → planUnsupported refusal", JSON.stringify(planRefuse));
  const planBadRepo = await bridge.planTask({ jobId: "1005", repoPath: path.join(TMP, "nope"), prompt: "x", agent: "planner" });
  assert(planBadRepo.error === "invalidRepo", "plan validates the repo too", JSON.stringify(planBadRepo));

  // ═══ 13b. PLAN_FALLBACK_AGENT routing ═══
  section("13b. Plan fallback routing");
  const fbBridge = makeBridge("fb", { planFallbackAgent: "planner" });
  const repoFb = makeRepo("repoFb");
  const fbStart = await fbBridge.planTask({ jobId: "1101fb", repoPath: repoFb, prompt: "plan via fallback", agent: "ok" });
  assert(fbStart.started === true && fbStart.fallback === true, "planSupported:false + valid fallback → plan starts via fallback", JSON.stringify(fbStart));
  assert(fbStart.agent === "ok" && fbStart.planAgent === "planner", "card's agent stays build provider; fallback is only the planner", JSON.stringify({ agent: fbStart.agent, planAgent: fbStart.planAgent }));
  const fbDone = await waitForTerminal(fbBridge, "1101fb");
  assert(fbDone.state === "planned" && (fbDone.plan ?? "").startsWith("Planned by planner (fallback"), "plan text prefixed with who planned it (fallback)", fbDone.plan?.slice(0, 60));
  assert(fbDone.agent === "ok" && fbDone.planAgent === "planner", "job record keeps provider=card agent, planProvider=fallback");
  // build after fallback-plan uses the CARD'S agent
  const fbBuild = await fbBridge.startTask({ jobId: "1101fb", repoPath: repoFb, prompt: "now build" });
  assert(fbBuild.agent === "ok", "build after fallback-plan dispatches the card's own agent", fbBuild.agent);
  const fbBuilt = await waitForTerminal(fbBridge, "1101fb");
  assert(fbBuilt.state === "in_review" && fbBuilt.agent === "ok", "fallback-planned task builds to in_review with the card's agent", JSON.stringify({ state: fbBuilt.state, agent: fbBuilt.agent }));
  // fallback that itself can't plan → refusal
  const fbBadBridge = makeBridge("fbBad", { planFallbackAgent: "fail" });
  const fbBad = await fbBadBridge.planTask({ jobId: "1102fb", repoPath: repoFb, prompt: "plan it", agent: "ok" });
  assert(fbBad.error === "planUnsupported" && fbBad.planSupported === false && fbBad.message.includes("'fail' can't plan"), "invalid fallback (can't plan) → planUnsupported with explanation", JSON.stringify(fbBad));

  // ═══ 13c. Plan modes: oneshot file capture, interactive pty round-trip, escalation, undrivable fallback ═══
  section("13c. Plan modes (oneshot / interactive pty / escalation / undrivable)");
  // (a) headless capture is covered by section 13's planner assertions.
  // (b) oneshot: plan lands in plan.md, captured, repo left pristine
  const repoOne = makeRepo("repoOne");
  await bridge.planTask({ jobId: "2001", repoPath: repoOne, prompt: "plan it", agent: "oneshot" });
  const oneDone = await waitForState(bridge, "2001", "planned");
  assert(oneDone.state === "planned" && (oneDone.plan ?? "").includes("# The Plan") && (oneDone.plan ?? "").includes("regression tests"), "oneshot provider: generated plan.md captured into plan field", JSON.stringify({ state: oneDone.state, plan: oneDone.plan?.slice(0, 40) }));
  assert(!existsSync(path.join(repoOne, "plan.md")), "generated plan.md cleaned up (untracked artifact deleted)");
  assert(gitOut(repoOne, ["status", "--porcelain"]) === "", "oneshot plan left the repo pristine");

  // (c) interactive: pty question → hold(needs_input) → answer-task → planned
  const repoInt = makeRepo("repoInt");
  await bridge.planTask({ jobId: "2002", repoPath: repoInt, prompt: "build a dashboard", agent: "interactive" });
  const held = await waitForState(bridge, "2002", "awaiting_input");
  assert(held.state === "awaiting_input", "interactive session pauses on the CLI's question → awaiting_input", held.state);
  assert((held.question ?? "").includes("What framework should I use?"), "the CLI's exact prompt is captured in `question`", held.question);
  const ansRes = await bridge.answerTask("2002", "react");
  assert(ansRes.resumed === true && ansRes.mode === "session", "answer-task writes the reply into the LIVE pty session", JSON.stringify(ansRes));
  const intDone = await waitForState(bridge, "2002", "planned");
  assert(intDone.state === "planned" && (intDone.plan ?? "").includes("use react"), "session continues after the answer and completes → planned with the full transcript", JSON.stringify({ state: intDone.state, snippet: intDone.plan?.slice(-60) }));

  // (d) escalation: thin one-shot plan → interactive session for the SAME provider
  const repoEsc = makeRepo("repoEsc");
  await bridge.planTask({ jobId: "2003", repoPath: repoEsc, prompt: "complex feature", agent: "escalator" });
  const escHeld = await waitForState(bridge, "2003", "awaiting_input");
  assert(escHeld.state === "awaiting_input" && (escHeld.question ?? "").includes("Which approach"), "thin one-shot plan ('meh') escalated to interactive, which asked a question", JSON.stringify({ state: escHeld.state, question: escHeld.question }));
  assert(!existsSync(path.join(repoEsc, "plan.md")), "thin plan.md artifact was cleaned before escalation");
  await bridge.answerTask("2003", "B");
  const escDone = await waitForState(bridge, "2003", "planned");
  assert(escDone.state === "planned" && (escDone.plan ?? "").includes("ESCALATED PLAN: approach B"), "escalated session produced the final plan", escDone.plan?.slice(-60));

  // complex:true skips the cheap pass entirely
  await bridge.planTask({ jobId: "2007", repoPath: repoEsc, prompt: "tricky one", agent: "escalator", complex: true });
  const cxHeld = await waitForState(bridge, "2007", "awaiting_input");
  assert(cxHeld.state === "awaiting_input" && (cxHeld.question ?? "").includes("Which approach"), "complex:true goes straight to the interactive session", JSON.stringify({ state: cxHeld.state }));
  await bridge.answerTask("2007", "C");
  const cxDone = await waitForState(bridge, "2007", "planned");
  assert(cxDone.state === "planned" && (cxDone.plan ?? "").includes("approach C"), "complex plan completes interactively");

  // (e) fallback fires ONLY when the plan mode is undrivable
  const fbPtyStart = await fbBridge.planTask({ jobId: "2004", repoPath: repoFb, prompt: "x", agent: "undrivable-pty" });
  assert(fbPtyStart.started === true, "undrivable interactive provider still dispatches (fallback is a runtime decision)", JSON.stringify(fbPtyStart));
  const fbPtyDone = await waitForState(fbBridge, "2004", "planned");
  assert(fbPtyDone.state === "planned" && (fbPtyDone.plan ?? "").startsWith("Planned by planner (fallback"), "pty spawn failure → PLAN_FALLBACK_AGENT produced the plan, attributed", fbPtyDone.plan?.slice(0, 50));
  await fbBridge.planTask({ jobId: "2005", repoPath: repoFb, prompt: "x", agent: "badflag" });
  const fbFlagDone = await waitForState(fbBridge, "2005", "planned");
  assert(fbFlagDone.state === "planned" && (fbFlagDone.plan ?? "").startsWith("Planned by planner (fallback"), "unknown-flag rejection (config/binary drift) → fallback planned, attributed", fbFlagDone.plan?.slice(0, 50));

  // dead-session resume: headless question (no live pty) → answer folds into the brief and re-plans
  await bridge.planTask({ jobId: "2006", repoPath: repoInt, prompt: "choose a db", agent: "askfail" });
  const askHeld = await waitForState(bridge, "2006", "awaiting_input");
  assert(askHeld.state === "awaiting_input" && (askHeld.question ?? "").includes("What DB"), "headless run asking a question → awaiting_input without a session", JSON.stringify({ state: askHeld.state, question: askHeld.question }));
  const ans2 = await bridge.answerTask("2006", "postgres");
  assert(ans2.resumed === true && ans2.mode === "rerun", "answer with no live session → cleanly re-runs with the answer folded in", JSON.stringify(ans2));
  const askDone = await waitForState(bridge, "2006", "planned");
  assert(askDone.state === "planned" && (askDone.plan ?? "").includes("postgres"), "re-planned run incorporates the human's answer", askDone.plan?.slice(-80));

  // answer-task guards
  const ansBad = await bridge.answerTask("2001", "irrelevant");
  assert(ansBad.resumed === false && ansBad.error === "invalidState", "answer refused for a job not awaiting input", JSON.stringify(ansBad));

  // ═══ 14. Empty diff → no commit, flagged ═══
  section("14. Empty-diff build");
  const repo12 = makeRepo("repo12");
  await bridge.startTask({ jobId: "1101", repoPath: repo12, prompt: "do nothing", agent: "noop" });
  const sNoop = await waitForTerminal(bridge, "1101");
  assert(sNoop.state === "in_review" && sNoop.diffStat === "", "empty diff → in_review with EMPTY diffStat (caller sees nothing changed)", JSON.stringify({ state: sNoop.state, diffStat: sNoop.diffStat }));
  assert(gitOut(repo12, ["rev-list", "--count", "main..job/1101"]) === "0", "branch has zero commits ahead of main");
  const bare12 = path.join(TMP, "origins", "repo12.git");
  assert(!gitOut(bare12, ["branch", "--list", "job/1101"]).includes("job/1101"), "nothing pushed for an empty diff");

  // ═══ 15. hold(quota) → auto-retry restores prevState → in_review ═══
  section("15. hold(quota) → sweep resume");
  const repo13 = makeRepo("repo13");
  await bridge.startTask({ jobId: "1201", repoPath: repo13, prompt: "hit the rate limit", agent: "quota" });
  {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const s = await bridge.getJobStatus("1201");
      if (s.state === "paused" || s.state === "awaiting_input") break;
      await sleep(150);
    }
  }
  const sHold = await bridge.getJobStatus("1201");
  assert(sHold.state === "paused" && sHold.pausedReason === "quota", "rate-limit output → paused(quota)", JSON.stringify({ state: sHold.state, pausedReason: sHold.pausedReason }));
  assert(sHold.pausedReason === "quota" && sHold.state === "paused", "paused jobs carry pausedReason (resume state tracked internally)", JSON.stringify({ state: sHold.state, pausedReason: sHold.pausedReason }));
  await sleep(300); // past holdRetryMs (200ms)
  await bridge.sweep();
  const sResumed = await waitForTerminal(bridge, "1201");
  assert(sResumed.state === "in_review", "auto-retry restored prevState and the retry succeeded → in_review", JSON.stringify({ state: sResumed.state, error: sResumed.error }));
  assert(sResumed.pausedReason === null && sResumed.question === null, "hold fields cleared after resume");

  // ═══ 16. Protected main on an "owned" repo → merge-mode push rejected → one-shot pr fallback ═══
  section("16. Rejected main push → automatic fallback to pr mode");
  const repo14 = makeRepo("repo14");
  const bare14 = path.join(TMP, "origins", "repo14.git");
  const hookPath = path.join(bare14, "hooks", "pre-receive");
  writeFileSync(hookPath, `#!/bin/bash\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then echo "protected: main" >&2; exit 1; fi\ndone\nexit 0\n`);
  chmodSync(hookPath, 0o755);
  await bridge.startTask({ jobId: "1301", repoPath: repo14, prompt: "will hit the protected branch" });
  const sProt = await waitForTerminal(bridge, "1301");
  assert(sProt.state === "in_review", "protected-branch fixture builds", sProt.error ?? sProt.state);
  const mProt = await bridge.mergeTask("1301"); // gh mode ADMIN → merge mode is attempted first
  assert(mProt.merged === true && mProt.deliveredVia === "pr", "rejected main push → fell back ONCE to pr delivery", JSON.stringify(mProt));
  assert(gitOut(repo14, ["rev-parse", "main"]) === gitOut(bare14, ["rev-parse", "main"]), "local main reset to origin/main — the unpushable merge commit does not linger");
  assert(gitOut(bare14, ["branch", "--list", "job/1301"]).includes("job/1301"), "job branch pushed for the fallback PR");
  assert((await bridge.getJobStatus("1301")).deliveryMode === "pr", "fallback recorded as deliveryMode=pr");

  // Unauthenticated gh where pr delivery is required → structured error, job still deliverable later
  const repo14b = makeRepo("repo14b");
  writeFileSync(path.join(repo14b, ".bridge.json"), JSON.stringify({ deliver: "pr" }));
  sh(repo14b, "git", ["add", "-A"]); sh(repo14b, "git", ["commit", "-m", "force pr delivery"]); sh(repo14b, "git", ["push", "origin", "main"]);
  await bridge.startTask({ jobId: "1302", repoPath: repo14b, prompt: "pr without gh" });
  const sUn = await waitForTerminal(bridge, "1302");
  assert(sUn.state === "in_review", "unauth fixture builds", sUn.error ?? sUn.state);
  setGhMode("UNAUTH");
  const mUn = await bridge.mergeTask("1302");
  setGhMode("ADMIN");
  assert(mUn.merged === false && mUn.error === "ghUnauthenticated" && (mUn.message ?? "").includes("gh auth login"), "unauthenticated gh in pr mode → { error: ghUnauthenticated }", JSON.stringify(mUn));
  assert((await bridge.getJobStatus("1302")).state === "in_review", "job stays in_review — deliverable once gh is authenticated");

  // ═══ 17. cancel-task: kill, remove worktree, KEEP branch ═══
  section("17. cancel-task");
  const repo15 = makeRepo("repo15");
  const rCancel = await bridge.startTask({ jobId: "1401", repoPath: repo15, prompt: "long run", agent: "silent" });
  await sleep(300);
  const cRes = await bridge.cancelTask("1401");
  assert(cRes.cancelled === true, "cancel-task cancels a running job", JSON.stringify(cRes));
  assert(!existsSync(rCancel.worktree), "worktree removed on cancel");
  assert(gitOut(repo15, ["branch", "--list", "job/1401"]).includes("job/1401"), "branch KEPT on cancel");
  await sleep(300); // give the killed process's close handler a beat
  const sCancel = await bridge.getJobStatus("1401");
  assert(sCancel.state === "cancelled", "state is cancelled (late process-exit didn't overwrite it)", sCancel.state);
  const cAgain = await bridge.cancelTask("1401");
  assert(cAgain.cancelled === false && cAgain.error === "invalidState", "second cancel refused");
  const rResume = await bridge.startTask({ jobId: "1401", repoPath: repo15, prompt: "resume after cancel" });
  assert(rResume.rework === true, "cancelled task can be re-dispatched (rework path)", JSON.stringify(rResume));
  const sResume2 = await waitForTerminal(bridge, "1401");
  assert(sResume2.state === "in_review", "re-dispatched cancelled task completes", sResume2.error ?? sResume2.state);

  // ═══ 19. Power assertion: held while working, released when idle ═══
  section("19. Power assertion");
  const isAlive = (p: number | undefined) => { if (!p) return false; try { process.kill(p, 0); return true; } catch { return false; } };
  const pwrBridge = makeBridge("pwr", { heartbeatTimeoutMs: 2500 });
  const repoPwr = makeRepo("repoPwr");
  await pwrBridge.startTask({ jobId: "3001", repoPath: repoPwr, prompt: "long job", agent: "silent" });
  await sleep(300);
  assert(pwrBridge.ops().powerAssertionHeld === true, "assertion HELD while a job is running", JSON.stringify(pwrBridge.ops().powerAssertionHeld));
  assert(isAlive(pwrBridge.powerPid()), "caffeinate process is actually alive");
  await sleep(2800); await pwrBridge.sweep(); // stale sweep kills the job → queue idle
  assert(pwrBridge.ops().powerAssertionHeld === false, "assertion RELEASED when the queue is idle (Mac may sleep)");

  // ═══ 20. Wake routine + queue drain ═══
  section("20. Wake routine + queue drain");
  let tunnelCalls = 0;
  const wakeBridge = makeBridge("wakeq", { maxConcurrentJobs: 1, heartbeatTimeoutMs: 2500, tunnelCheck: async () => { tunnelCalls++; return { up: true, url: "https://bridge.example.dev" }; } });
  const repoWq = makeRepo("repoWq");
  await wakeBridge.startTask({ jobId: "3101", repoPath: repoWq, prompt: "hog the slot", agent: "silent" });
  const wq2 = await wakeBridge.startTask({ jobId: "3102", repoPath: repoWq, prompt: "waiting in queue" });
  assert(wq2.queued === true, "second job queued at capacity", JSON.stringify(wq2));
  assert(wakeBridge.ops().queueDepth === 1, "ops() reports queue depth");
  await wakeBridge.cancelTask("3101"); // free the slot; sleep-frozen jobs aside, the wake routine must pick up the queue
  const wakeRes = await wakeBridge.triggerWake(300000);
  assert(tunnelCalls >= 1, "wake routine re-verified the tunnel");
  assert(wakeBridge.ops().lastWakeAt !== null && wakeBridge.ops().tunnel.up === true, "ops() reports wake + tunnel state", JSON.stringify(wakeBridge.ops().tunnel));
  assert((wakeRes.dispatched ?? []).includes("3102"), "wake routine drained the queue (job dispatched within seconds of wake)", JSON.stringify(wakeRes.dispatched));
  const wqDone = await waitForState(wakeBridge, "3102", "in_review");
  assert(wqDone.state === "in_review", "queued job ran to completion after wake dispatch", wqDone.error ?? wqDone.state);
  assert(WakeDetector.isWakeGap(15000, 320000, 120000) === true && WakeDetector.isWakeGap(15000, 15400, 120000) === false, "wake gap detector: big clock jump = wake, jitter ≠ wake");
  wakeBridge.close();

  // ═══ 21. Crash/reboot recovery: reattach alive, resume dead, strategies ═══
  section("21. Recovery (reattach / resume / rerun / rework)");
  // (i) alive job REATTACHES — no relaunch
  const repoRec = makeRepo("repoRec");
  const rb1 = makeBridge("rec");
  await rb1.startTask({ jobId: "3201", repoPath: repoRec, prompt: "long build", agent: "reattach" });
  await sleep(1800); // generous: first exec of a fresh script pays ~1s of macOS Gatekeeper latency
  const jsProbe = new JobStore(path.join(TMP, "data", "rec", "jobs.sqlite"));
  const alivePid = jsProbe.getByTaskId("3201")?.pid; jsProbe.close();
  assert(!!alivePid && isAlive(alivePid), "provider process alive before simulated bridge crash");
  rb1.close(); // bridge "crashes"; detached provider keeps running
  const rb2 = makeBridge("rec");
  await rb2.recoverNow("test");
  const reattached = await rb2.getJobStatus("3201");
  assert(reattached.state === "running" && rb2.ops().reattachedJobs.includes("3201"), "alive orphan REATTACHED (state kept, no relaunch)", JSON.stringify({ state: reattached.state, watch: rb2.ops().reattachedJobs }));
  process.kill(alivePid!, "SIGTERM");
  await sleep(400); await rb2.sweep(); // pid gone → finish the pipeline
  const finished = await waitForState(rb2, "3201", "in_review");
  assert(finished.state === "in_review", "reattached job finished verify→commit (local-only) after its process exited", finished.error ?? finished.state);
  rb2.close();
  // (ii) dead job WITH resumeArgsTemplate → resumed in the same worktree
  const repoRec2 = makeRepo("repoRec2");
  const rb3 = makeBridge("rec2");
  await rb3.startTask({ jobId: "3301", repoPath: repoRec2, prompt: "resumable build", agent: "resumable" });
  await sleep(1800);
  const jsProbe2 = new JobStore(path.join(TMP, "data", "rec2", "jobs.sqlite"));
  const deadPid = jsProbe2.getByTaskId("3301")?.pid; jsProbe2.close();
  rb3.close(); // bridge dies FIRST (crash/reboot)…
  process.kill(deadPid!, "SIGKILL"); // …then the orphaned provider dies too
  await sleep(200);
  const rb4 = makeBridge("rec2"); // RESUME_STRATEGY=resume (default)
  await rb4.recoverNow("test");
  const resumed = await waitForState(rb4, "3301", "in_review");
  assert(resumed.state === "in_review", "dead job resumed via resumeArgsTemplate", resumed.error ?? resumed.state);
  assert(sh(repoRec2, "git", ["show", "job/3301:provider-output.txt"]).includes("resumed work"), "resume run continued in the SAME worktree (resume marker committed)");
  rb4.close();
  // (iii) dead job, RESUME_STRATEGY=rework → failed with a note
  const repoRec3 = makeRepo("repoRec3");
  const rb5 = makeBridge("rec3", { resumeStrategy: "rework" as const });
  await rb5.startTask({ jobId: "3401", repoPath: repoRec3, prompt: "will be interrupted", agent: "silent" });
  await sleep(300);
  const jsProbe3 = new JobStore(path.join(TMP, "data", "rec3", "jobs.sqlite"));
  const deadPid3 = jsProbe3.getByTaskId("3401")?.pid; jsProbe3.close();
  rb5.close();
  process.kill(deadPid3!, "SIGKILL");
  await sleep(200);
  const rb6 = makeBridge("rec3", { resumeStrategy: "rework" as const });
  await rb6.recoverNow("test");
  const reworked = await rb6.getJobStatus("3401");
  assert(reworked.state === "failed" && (reworked.error ?? "").includes("RESUME_STRATEGY=rework"), "no-resume strategy=rework → failed with note for the board", JSON.stringify({ state: reworked.state, error: reworked.error }));
  rb6.close();
  // (iv) dead job, no resume template, strategy=resume → falls back to RERUN of the brief
  const repoRec4 = makeRepo("repoRec4");
  const rb7 = makeBridge("rec4");
  await rb7.startTask({ jobId: "3501", repoPath: repoRec4, prompt: "rerun me", agent: "rerun" });
  await sleep(1800); // let the first run actually create .ran-once before the simulated crash
  const jsProbe4 = new JobStore(path.join(TMP, "data", "rec4", "jobs.sqlite"));
  const deadPid4 = jsProbe4.getByTaskId("3501")?.pid; jsProbe4.close();
  rb7.close();
  process.kill(deadPid4!, "SIGKILL");
  await sleep(200);
  const rb8 = makeBridge("rec4");
  await rb8.recoverNow("test");
  const rerunDone = await waitForState(rb8, "3501", "in_review");
  assert(rerunDone.state === "in_review", "provider without resume support → brief re-run in the same worktree", rerunDone.error ?? rerunDone.state);
  rb8.close();
  // ═══ 22. Mode: accept_edits supervised build with question relay ═══
  section("22. Mode: accept_edits (supervised build)");
  const repoSup = makeRepo("repoSup");
  const supStart = await bridge.startTask({ jobId: "4001", repoPath: repoSup, prompt: "add a dependency", agent: "supervised", mode: "accept_edits" });
  assert(supStart.mode === "accept_edits", "start-task accepts mode and records it", supStart.mode);
  const supHeld = await waitForState(bridge, "4001", "awaiting_input");
  assert(supHeld.state === "awaiting_input", "supervised build paused on the higher-risk step → awaiting_input", supHeld.state);
  assert((supHeld.question ?? "").includes("npm install"), "the CLI's exact approval question is captured", supHeld.question);
  assert(existsSync(path.join(supStart.worktree, "supervised-edit.txt")), "file edit was auto-applied BEFORE the pause (accept-edits posture)");
  const supAns = await bridge.answerTask("4001", "yes, approved");
  assert(supAns.resumed === true && supAns.mode === "session" && supAns.state === "running", "answer resumes the live BUILD session back to running", JSON.stringify(supAns));
  const supDone = await waitForState(bridge, "4001", "in_review");
  assert(supDone.state === "in_review", "supervised build runs to completion after approval", supDone.error ?? supDone.state);
  assert(gitOut(repoSup, ["show", "job/4001:supervised-edit.txt"]).includes("edited content"), "supervised edits committed on the task branch");
  const supDefault = await bridge.startTask({ jobId: "4002", repoPath: repoSup, prompt: "default mode check" });
  assert(supDefault.mode === "auto", "mode defaults to auto (DEFAULT_MODE) when unset", supDefault.mode);

  // ═══ 23. ALLOW_PACKAGE_INSTALLS policy ═══
  section("23. ALLOW_PACKAGE_INSTALLS");
  const repoInst = makeRepo("repoInst");
  await bridge.startTask({ jobId: "4101", repoPath: repoInst, prompt: "install allowed", verifyCommand: "echo simulating npm install && true" });
  const instOk = await waitForState(bridge, "4101", "in_review");
  assert(instOk.state === "in_review", "install command runs with no prompt when ALLOW_PACKAGE_INSTALLS=true (default)", instOk.error ?? instOk.state);
  const noInstBridge = makeBridge("noinst", { allowPackageInstalls: false });
  const repoInst2 = makeRepo("repoInst2");
  await noInstBridge.startTask({ jobId: "4102", repoPath: repoInst2, prompt: "install blocked", verifyCommand: "echo simulating npm install && true" });
  const instBlocked = await waitForState(noInstBridge, "4102", "failed");
  assert(instBlocked.state === "failed" && (instBlocked.error ?? "").includes("ALLOW_PACKAGE_INSTALLS=false"), "install command refused when ALLOW_PACKAGE_INSTALLS=false", JSON.stringify({ state: instBlocked.state, error: instBlocked.error }));
  noInstBridge.close();

  // ═══ 24. providers.json exposes three modes for every provider ═══
  section("24. providers.json: auto / acceptEdits / plan for every provider");
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const realRegistry = JSON.parse(readFileSync(path.join(repoRoot, "providers.json"), "utf-8"));
  for (const [name, entry] of Object.entries<any>(realRegistry)) {
    if (name.startsWith("_")) continue;
    const hasAuto = Array.isArray(entry.buildAutoArgs) && entry.buildAutoArgs.length > 0;
    const hasAccept = Array.isArray(entry.buildAcceptEditsArgs) && entry.buildAcceptEditsArgs.length > 0;
    const hasPlan = !!entry.planMode || (Array.isArray(entry.planArgs) && entry.planArgs.length > 0);
    assert(hasAuto && hasAccept && hasPlan, `${name}: auto + acceptEdits + plan all declared`, JSON.stringify({ hasAuto, hasAccept, hasPlan }));
  }

  // ═══ 18. Unit checks: compare URL + slugify ═══
  section("18. Helpers");
  assert(originToWebUrl("git@github.com:owner/repo.git") === "https://github.com/owner/repo", "ssh origin → web URL");
  assert(originToWebUrl("https://github.com/owner/repo.git") === "https://github.com/owner/repo", "https origin → web URL");
  assert(slugifyTaskId("BB 12/weird*chars") === "BB-12-weird-chars", "slugify is defensive", slugifyTaskId("BB 12/weird*chars"));

  // ── Summary ──
  console.log(`\n${"═".repeat(50)}\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILURES"}: ${passed} passed, ${failed} failed`);
  bridge.close(); fastBridge.close(); capBridge.close(); gatedBridge.close(); deniedBridge.close(); fbBridge.close(); fbBadBridge.close(); pwrBridge.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error("SMOKE TEST CRASHED:", e); process.exit(1); });
