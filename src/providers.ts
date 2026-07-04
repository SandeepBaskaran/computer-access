/**
 * Provider registry for the Build Board bridge.
 *
 * Adapters are data, not code: each entry in providers.json describes how to
 * invoke one coding-agent CLI in two modes:
 *   - build: non-interactive, auto-approved — full write access in the worktree
 *   - plan:  read-only planning mode — no writes, no branch/worktree
 * An entry with an empty `command` is a stub — listed but not usable until
 * filled in. `planSupported: false` makes plan-task refuse cleanly instead of
 * falling back to a writing mode.
 */
import { readFile } from "fs/promises";

export type ProviderMode = "build" | "plan";

/**
 * How a provider produces a plan:
 *   headless    — non-interactive flags; plan arrives on stdout
 *   oneshot     — non-interactive, but the plan lands in a generated file (planOutputFile)
 *   interactive — a TUI driven through a pty (planSend sequences enter plan mode)
 */
export type PlanMode = "headless" | "oneshot" | "interactive";

export interface ProviderEntry {
  command: string;
  /** AUTO-mode build args ({brief}/{workspace} placeholders): full autonomy, skip-permissions posture. */
  buildArgs: string[];
  /** ACCEPT-EDITS build args: edits auto-applied, higher-risk actions (shell/installs/deletes/network)
   *  pause — the supervised pty session relays the CLI's question to the board. */
  acceptEditsArgs?: string[];
  /** Primary plan capability. Omitted + planArgs present → "headless" (back-compat). */
  planMode?: PlanMode;
  /** headless/oneshot spawn args (with placeholders). */
  planArgs?: string[];
  /** oneshot: repo-relative file the CLI writes the plan into (captured then cleaned up). */
  planOutputFile?: string;
  /** interactive: sequences written to the pty after launch ({brief} substituted) — keys, slash-commands, the brief. */
  planSend?: string[];
  /** interactive: TUI launch args (default: none). Also used when a oneshot provider escalates. */
  planInteractiveArgs?: string[];
  /** Override: false disables the provider's own plan mode (plans route to the fallback agent). */
  planSupported?: boolean;
  /** Recovery of a DEAD job: relaunch args resuming the provider's prior session in the same worktree.
   *  Placeholders: {nudge} (continue-where-you-left-off prompt), {brief}, {workspace}, {sessionId}. */
  resumeArgsTemplate?: string[];
  /** Optional regex capturing the provider's session id from its output (group 1); enables {sessionId}. */
  sessionIdRegex?: string;
  /** Working directory relative to the task worktree (default: the worktree itself). */
  cwd?: string;
  /** Extra environment variables (e.g. provider API keys). */
  env?: Record<string, string>;
  /** How the brief reaches the CLI: as an argument or piped to stdin. */
  promptVia: "arg" | "stdin";
}

/** Effective plan mode after back-compat derivation; null = provider cannot plan itself. */
export function planModeOf(entry: ProviderEntry): PlanMode | null {
  if (entry.planSupported === false) return null;
  if (entry.planMode) return entry.planMode;
  if (entry.planArgs && entry.planArgs.length > 0) return "headless";
  return null;
}

export type ProviderRegistry = Map<string, ProviderEntry>;

function assertStringArray(name: string, field: string, v: any): void {
  if (!Array.isArray(v) || v.some((a: any) => typeof a !== "string")) {
    throw new Error(`provider '${name}': '${field}' must be an array of strings`);
  }
}

function validateEntry(name: string, raw: any): ProviderEntry {
  if (!raw || typeof raw !== "object") throw new Error(`provider '${name}': entry must be an object`);
  if (typeof raw.command !== "string") throw new Error(`provider '${name}': 'command' must be a string`);
  assertStringArray(name, "buildArgs", raw.buildArgs);
  if (raw.acceptEditsArgs !== undefined) assertStringArray(name, "acceptEditsArgs", raw.acceptEditsArgs);
  if (raw.planArgs !== undefined) assertStringArray(name, "planArgs", raw.planArgs);
  if (raw.planSend !== undefined) assertStringArray(name, "planSend", raw.planSend);
  if (raw.planInteractiveArgs !== undefined) assertStringArray(name, "planInteractiveArgs", raw.planInteractiveArgs);
  if (raw.planOutputFile !== undefined && typeof raw.planOutputFile !== "string") {
    throw new Error(`provider '${name}': 'planOutputFile' must be a string`);
  }
  if (raw.resumeArgsTemplate !== undefined) assertStringArray(name, "resumeArgsTemplate", raw.resumeArgsTemplate);
  if (raw.sessionIdRegex !== undefined) {
    if (typeof raw.sessionIdRegex !== "string") throw new Error(`provider '${name}': 'sessionIdRegex' must be a string`);
    try { new RegExp(raw.sessionIdRegex); } catch { throw new Error(`provider '${name}': 'sessionIdRegex' is not a valid regex`); }
  }
  if (raw.planMode !== undefined && !["headless", "oneshot", "interactive"].includes(raw.planMode)) {
    throw new Error(`provider '${name}': 'planMode' must be "headless", "oneshot", or "interactive"`);
  }
  if (raw.planSupported !== undefined && typeof raw.planSupported !== "boolean") {
    throw new Error(`provider '${name}': 'planSupported' must be a boolean`);
  }
  // Per-mode requirements
  if (raw.planMode === "headless" && (!Array.isArray(raw.planArgs) || raw.planArgs.length === 0)) {
    throw new Error(`provider '${name}': planMode "headless" requires non-empty 'planArgs'`);
  }
  if (raw.planMode === "oneshot" && (!Array.isArray(raw.planArgs) || raw.planArgs.length === 0 || !raw.planOutputFile)) {
    throw new Error(`provider '${name}': planMode "oneshot" requires non-empty 'planArgs' and 'planOutputFile'`);
  }
  if (raw.planMode === "interactive" && (!Array.isArray(raw.planSend) || raw.planSend.length === 0)) {
    throw new Error(`provider '${name}': planMode "interactive" requires non-empty 'planSend'`);
  }
  if (raw.promptVia !== "arg" && raw.promptVia !== "stdin") {
    throw new Error(`provider '${name}': 'promptVia' must be "arg" or "stdin"`);
  }
  if (raw.cwd !== undefined && typeof raw.cwd !== "string") throw new Error(`provider '${name}': 'cwd' must be a string`);
  if (raw.env !== undefined && (typeof raw.env !== "object" || raw.env === null || Object.values(raw.env).some(v => typeof v !== "string"))) {
    throw new Error(`provider '${name}': 'env' must be a string→string map`);
  }
  const entry: ProviderEntry = {
    command: raw.command, buildArgs: raw.buildArgs, acceptEditsArgs: raw.acceptEditsArgs,
    planMode: raw.planMode, planArgs: raw.planArgs, planOutputFile: raw.planOutputFile,
    planSend: raw.planSend, planInteractiveArgs: raw.planInteractiveArgs,
    planSupported: raw.planSupported,
    resumeArgsTemplate: raw.resumeArgsTemplate, sessionIdRegex: raw.sessionIdRegex,
    cwd: raw.cwd, env: raw.env, promptVia: raw.promptVia,
  };
  // Materialize planSupported so callers can rely on a plain boolean.
  entry.planSupported = raw.planSupported ?? (planModeOf(entry) !== null);
  return entry;
}

/**
 * Load and validate the registry. A malformed file logs the error and returns
 * an empty registry — the server must still start.
 */
export async function loadProviders(registryPath: string): Promise<ProviderRegistry> {
  const registry: ProviderRegistry = new Map();
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch (e: any) {
    console.error(`[BRIDGE] providers.json not found at ${registryPath}: ${e.message} — no providers available.`);
    return registry;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    console.error(`[BRIDGE] providers.json is invalid JSON: ${e.message} — no providers available.`);
    return registry;
  }
  for (const [name, entry] of Object.entries(parsed)) {
    if (name.startsWith("_")) continue; // "_TODO" etc. — JSON has no comments, so _-prefixed keys are notes
    try {
      registry.set(name, validateEntry(name, entry));
    } catch (e: any) {
      console.error(`[BRIDGE] Skipping invalid provider entry: ${e.message}`);
    }
  }
  return registry;
}

export function isStub(entry: ProviderEntry): boolean {
  return entry.command.trim() === "";
}

export function usableProviders(registry: ProviderRegistry): string[] {
  return [...registry.entries()].filter(([, e]) => !isStub(e)).map(([n]) => n);
}

/**
 * Resolve a provider by name (or the default). Unknown or stub providers
 * throw a clear, actionable message — callers surface it as tool text.
 */
export function resolveProvider(registry: ProviderRegistry, name: string | undefined, defaultProvider: string): { name: string; entry: ProviderEntry } {
  const wanted = name?.trim() || defaultProvider;
  const entry = registry.get(wanted);
  const usable = usableProviders(registry);
  if (!entry) {
    throw new Error(`Unknown coding agent '${wanted}'. Usable providers: ${usable.join(", ") || "(none configured)"}. Add it to providers.json to enable it.`);
  }
  if (isStub(entry)) {
    throw new Error(`Coding agent '${wanted}' is a stub (no command configured in providers.json). Usable providers: ${usable.join(", ") || "(none configured)"}.`);
  }
  return { name: wanted, entry };
}

/**
 * Substitute {brief}/{workspace} for the given mode; for stdin providers,
 * drop args carrying {brief}. The brief is substituted VERBATIM as a single
 * argv element (never through a shell) — repo content and the brief are
 * untrusted input and must never be expanded or interpolated further.
 */
export function buildProviderArgs(entry: ProviderEntry, mode: ProviderMode, brief: string, workspace: string): string[] {
  const template = mode === "plan" ? (entry.planArgs ?? []) : entry.buildArgs;
  const filtered = entry.promptVia === "stdin" ? template.filter(a => !a.includes("{brief}")) : template;
  return filtered.map(a => a.replaceAll("{brief}", brief).replaceAll("{workspace}", workspace));
}
