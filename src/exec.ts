// ── Safe process execution ──────────────────────────────────
// Prefer execFileP (no shell → no injection) for anything that
// interpolates untrusted input. runShell is reserved for constant
// command strings that genuinely need a shell (pipes, redirects) and
// must never receive caller-controlled data.
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { MAX_EXEC_BUFFER, COMMAND_TIMEOUT } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
}

/** Run a binary with an explicit argument vector — never spawns a shell. */
export async function execFileP(
  file: string,
  args: string[] = [],
  opts: ExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? COMMAND_TIMEOUT,
    maxBuffer: opts.maxBuffer ?? MAX_EXEC_BUFFER,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/**
 * Run a constant shell command. ONLY for hardcoded strings (e.g. a
 * pipeline like `df -h / | tail -1`). Do not pass user input here.
 */
export async function runShell(
  command: string,
  opts: ExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
    cwd: opts.cwd,
    timeout: opts.timeout ?? COMMAND_TIMEOUT,
    maxBuffer: opts.maxBuffer ?? MAX_EXEC_BUFFER,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/**
 * Tokenise a free-form argument string into an argv array, honouring
 * single/double quotes. Tokens are passed to execFileP (no shell), so
 * shell metacharacters are inert — this is safe against injection.
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let hasContent = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasContent) { tokens.push(cur); cur = ""; hasContent = false; }
    } else {
      cur += ch;
      hasContent = true;
    }
  }
  if (hasContent) tokens.push(cur);
  return tokens;
}

/** Run a binary, writing `input` to its stdin (e.g. pbcopy, patch). No shell. */
export function writeToStdin(
  file: string,
  args: string[],
  input: string,
  opts: ExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", reject);
    proc.on("close", () => resolve({ stdout, stderr }));
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/** Fire-and-forget a detached background process (e.g. caffeinate). */
export function spawnDetached(file: string, args: string[]): void {
  const proc = spawn(file, args, { detached: true, stdio: "ignore" });
  proc.unref();
}

/**
 * Spawn a command in its own process group and collect output, killing
 * the whole group (not just the shell) on timeout so child pipelines
 * don't survive. Returns stdout/stderr and the exit code.
 */
export function spawnCollect(
  command: string,
  opts: { cwd?: string; timeout?: number; onData?: (chunk: string) => void } = {},
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", command], { cwd: opts.cwd, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeout
      ? setTimeout(() => {
          timedOut = true;
          if (proc.pid) {
            try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* gone */ } }
          }
        }, opts.timeout)
      : null;
    proc.stdout.on("data", (c: Buffer) => { const s = c.toString(); stdout += s; opts.onData?.(s); });
    proc.stderr.on("data", (c: Buffer) => { const s = c.toString(); stderr += s; opts.onData?.(s); });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) reject(new Error("Command timed out"));
      else resolve({ stdout, stderr, code, timedOut });
    });
    proc.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
  });
}
