/**
 * Build bridge tools: plan / start / get_status / answer / cancel / merge.
 *
 * The bridge is a generic build executor — its whole vocabulary is
 * `jobId + repoPath + agent + mode + prompt` and it emits only generic job
 * states. This module owns the singleton bridge instance and registers the
 * six tools through the same guarded registrar as every other tool.
 */
import { z } from "zod";
import { createBridge } from "../bridge.js";
import { isPathAllowed } from "../security.js";
import { auditLog } from "../audit.js";
import {
  ENABLE_CONFIRMATION_GATE, DEFAULT_AGENT, WORKTREE_ROOT, MAX_CONCURRENT_JOBS,
  HEARTBEAT_TIMEOUT_MS, JOB_MAX_RUNTIME_MS, REVERT_WINDOW_HOURS,
  PLAN_TIMEOUT_MS, HOLD_RETRY_MS, PLAN_FALLBACK_AGENT, PLAN_MIN_CHARS, PLAN_IDLE_MS,
  RESUME_STRATEGY, WAKE_GAP_MS, TUNNEL_API_URL, ALLOW_PACKAGE_INSTALLS, DEFAULT_MODE,
  BRIDGE_DATA_DIR, PROVIDERS_PATH,
} from "../config.js";
import type { Register } from "./types.js";

// Tunnel liveness via the ngrok agent's local API (the launchd tunnel
// service); the embedded start.ts tunnel has its own health check.
async function defaultTunnelCheck(): Promise<{ up: boolean; url?: string }> {
  try {
    const res = await fetch(TUNNEL_API_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { up: false };
    const data: any = await res.json();
    const t = (data.tunnels ?? []).find((x: any) => x.public_url);
    return { up: !!t, url: t?.public_url };
  } catch {
    return { up: false };
  }
}

export const bridge = createBridge({
  dataDir: BRIDGE_DATA_DIR,
  registryPath: PROVIDERS_PATH,
  worktreeRoot: WORKTREE_ROOT,
  defaultProvider: DEFAULT_AGENT,
  maxConcurrentJobs: MAX_CONCURRENT_JOBS,
  heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  jobMaxRuntimeMs: JOB_MAX_RUNTIME_MS,
  revertWindowHours: REVERT_WINDOW_HOURS,
  planTimeoutMs: PLAN_TIMEOUT_MS,
  holdRetryMs: HOLD_RETRY_MS,
  planFallbackAgent: PLAN_FALLBACK_AGENT,
  planMinChars: PLAN_MIN_CHARS,
  planIdleMs: PLAN_IDLE_MS,
  resumeStrategy: RESUME_STRATEGY,
  wakeGapMs: WAKE_GAP_MS,
  tunnelCheck: defaultTunnelCheck,
  defaultMode: DEFAULT_MODE,
  allowPackageInstalls: ALLOW_PACKAGE_INSTALLS,
  // Break-glass: ON means merge/revert refuse outright — the caller's own
  // approval flow is the real gate (this is deliberately NOT the confirm:true
  // re-call mechanism; an agent-completable confirmation is no gate at all).
  confirmationGateEnabled: () => ENABLE_CONFIRMATION_GATE,
  isPathAllowed,
});
bridge.startSweeps();

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

export function registerBridgeTools(register: Register, sessionId: string) {
  register("start", {
    title: "Bridge: Start Build Job",
    description: "Dispatch a build job to a local coding-agent CLI. Creates an isolated git worktree on branch job/<jobId> (or the given branch), runs the agent asynchronously, and returns immediately. On success the branch is committed, pushed, and a PR/compare URL is recorded (state: in_review). Structured returns: alreadyRunning (idempotent on jobId), queued (capacity full — dispatched FIFO as slots free), invalidRepo, awaiting_input (directory has no git repo — reply via `answer` to authorize `git init`). Re-calling for a failed/in_review job re-runs on the same branch/worktree with the new prompt.",
    inputSchema: {
      jobId: z.string().describe("Opaque caller-supplied id — the idempotency/dedup key; also derives branch job/<jobId>"),
      repoPath: z.string().describe("Absolute path to the target directory (must be inside ALLOWED_DIRS)"),
      prompt: z.string().describe("Natural-language work description passed to the coding agent"),
      agent: z.string().optional().describe(`Local agent from providers.json (default: ${DEFAULT_AGENT})`),
      mode: z.enum(["auto", "accept_edits"]).optional().describe(`Execution posture: auto = full autonomy (skip-permissions), accept_edits = supervised (edits auto-apply; shell/installs/deletes pause → awaiting_input → answer). Default: ${DEFAULT_MODE}`),
      verifyCommand: z.string().optional().describe("Shell command run in the worktree after the agent finishes; non-zero exit fails the job. Falls back to the repo's .bridge.json verifyCommand, then skips."),
      branch: z.string().optional().describe("Branch to work on (default: job/<jobId>)"),
    },
  }, async (params: any) => {
    try {
      const result = await bridge.startTask(params);
      await auditLog("start", { jobId: params.jobId, agent: params.agent }, "SUCCESS", sessionId, undefined, params.repoPath);
      return json(result);
    } catch (e: any) {
      await auditLog("start", { jobId: params.jobId }, "ERROR", sessionId, e.message, params.repoPath);
      return json({ error: e.message });
    }
  });

  register("plan", {
    title: "Bridge: Plan Job",
    description: "Dispatch a READ-ONLY plan job — no branch, no worktree, no writes — and return IMMEDIATELY ({started:true}). Never blocks on a slow plan. Poll get_status: 'planning' → still running; 'planned' → result in the `plan` field (+ needsInput/question when the agent asked something). If the chosen agent has no plan mode, the plan runs via PLAN_FALLBACK_AGENT (read-only) while the chosen agent stays the build agent — the plan text says who planned it. Structured returns: alreadyPlanning, queued, invalidRepo, planUnsupported (planSupported:false only when neither the agent nor a valid fallback can plan).",
    inputSchema: {
      jobId: z.string().describe("Opaque caller-supplied id — the idempotency/dedup key"),
      repoPath: z.string().describe("Absolute path to the target directory (must be inside ALLOWED_DIRS)"),
      prompt: z.string().describe("What to plan"),
      agent: z.string().optional().describe(`Local agent from providers.json (default: ${DEFAULT_AGENT})`),
      complex: z.boolean().optional().describe("Skip the cheap one-shot pass and go straight to an interactive plan session when the agent supports one"),
    },
  }, async (params: any) => {
    try {
      const result = await bridge.planTask(params);
      await auditLog("plan", { jobId: params.jobId, agent: params.agent }, result.error ? "BLOCKED" : "SUCCESS", sessionId, result.error, params.repoPath);
      return json(result);
    } catch (e: any) {
      await auditLog("plan", { jobId: params.jobId }, "ERROR", sessionId, e.message, params.repoPath);
      return json({ error: e.message });
    }
  });

  register("get_status", {
    title: "Bridge: Job Status",
    description: "Durable job state, always as an ARRAY. With jobId: one entry with full detail including a log excerpt. Without: the 50 most recent jobs. States: planning | planned | queued | running | awaiting_input (see `question`) | paused (see `pausedReason`: quota auto-retries; session/blocked need a human) | in_review (see prUrl/branchUrl/diffStat) | failed | merged | cancelled. Survives bridge restarts.",
    inputSchema: {
      jobId: z.string().optional().describe("Job id; omit to list recent jobs"),
    },
  }, async ({ jobId }: any) => {
    try {
      const result = await bridge.getJobStatus(jobId);
      const arr = Array.isArray(result?.jobs) ? result.jobs : [result];
      await auditLog("get_status", { jobId }, "SUCCESS", sessionId);
      return json(arr);
    } catch (e: any) {
      await auditLog("get_status", { jobId }, "ERROR", sessionId, e.message);
      return json({ error: e.message });
    }
  });

  register("answer", {
    title: "Bridge: Answer Job Question",
    description: "Relay a reply into a job in awaiting_input. A live interactive session gets the answer written into its pty; a dead session (or headless question, or a pending git-init authorization) re-runs cleanly with the answer applied. Loop until planned/in_review.",
    inputSchema: {
      jobId: z.string().describe("Job id of the waiting job"),
      answer: z.string().describe("The reply to the job's `question`"),
    },
  }, async ({ jobId, answer }: any) => {
    try {
      const result = await bridge.answerTask(jobId, answer);
      await auditLog("answer", { jobId }, result.accepted ? "SUCCESS" : "BLOCKED", sessionId, result.error ?? result.message);
      return json(result);
    } catch (e: any) {
      await auditLog("answer", { jobId }, "ERROR", sessionId, e.message);
      return json({ error: e.message });
    }
  });

  register("cancel", {
    title: "Bridge: Cancel Job",
    description: "Cancel a running/queued/waiting job: kills the agent process, removes the worktree, KEEPS the branch. Re-dispatching later with `start` resumes on the same branch.",
    inputSchema: {
      jobId: z.string().describe("Job id to cancel"),
    },
  }, async ({ jobId }: any) => {
    try {
      const result = await bridge.cancelTask(jobId);
      await auditLog("cancel", { jobId }, result.cancelled ? "SUCCESS" : "BLOCKED", sessionId, result.error ?? result.message);
      return json(result);
    } catch (e: any) {
      await auditLog("cancel", { jobId }, "ERROR", sessionId, e.message);
      return json({ error: e.message });
    }
  });

  register("merge", {
    title: "Bridge: Merge Job",
    description: "Merge a reviewed job into the default branch with --no-ff and push. Refuses unless the job is in_review and no tracked files have uncommitted changes (untracked junk like .DS_Store never blocks). The branch is KEPT for the revert window; the worktree is removed. On conflict returns {merged:false, conflict:true} with everything intact. action:'revert' reverts a merged job's merge commit within the revert window (operator use).",
    inputSchema: {
      jobId: z.string().describe("Job id to merge"),
      action: z.enum(["merge", "revert"]).optional().describe("Default: merge"),
    },
  }, async ({ jobId, action }: any) => {
    try {
      const result = await bridge.mergeTask(jobId, action ?? "merge");
      const status = result.merged || result.reverted ? "SUCCESS" : "BLOCKED";
      await auditLog("merge", { jobId, action: action ?? "merge" }, status, sessionId, result.error ?? result.message);
      return json(result);
    } catch (e: any) {
      await auditLog("merge", { jobId, action: action ?? "merge" }, "ERROR", sessionId, e.message);
      return json({ error: e.message });
    }
  });
}
