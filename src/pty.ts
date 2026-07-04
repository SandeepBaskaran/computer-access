/**
 * Minimal pty layer for interactive plan sessions.
 *
 * Prefers node-pty when the user has installed it (optional — NOT a declared
 * dependency); otherwise relays through expect(1) (ships with macOS/most
 * Linux), which allocates a real pty and forwards our piped stdin/stdout.
 * (macOS script(1) is unusable here: it requires a tty on ITS stdin.)
 * Throwing here means "this provider's interactive plan mode can't be
 * driven" — callers route to PLAN_FALLBACK_AGENT.
 */
import { spawn } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import os from "os";
import path from "path";

export interface PtyHandle {
  write(data: string): void;
  kill(): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  pid: number | undefined;
}

/**
 * Bidirectional pty relay: spawns $argv on a pty, streams its output to our
 * stdout, forwards our (piped) stdin to the pty, exits with the child's code.
 */
const RELAY_PROGRAM = `set timeout -1
log_user 1
spawn -noecho {*}$argv
fconfigure stdin -blocking 0
fileevent stdin readable {
  set d [read stdin]
  if {$d ne ""} { send -- $d }
  if {[eof stdin]} { fileevent stdin readable {} }
}
expect eof
catch wait result
exit [lindex $result 3]
`;

let relayPath: string | null = null;
function relayScriptPath(): string {
  if (!relayPath) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-pty-"));
    relayPath = path.join(dir, "relay.exp");
    writeFileSync(relayPath, RELAY_PROGRAM);
  }
  return relayPath;
}

export async function spawnPty(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<PtyHandle> {
  // Preferred: node-pty, if present. Loaded dynamically so it stays optional.
  try {
    const modName = "node-pty";
    const ptyMod: any = await import(modName);
    const p = ptyMod.spawn(command, args, {
      name: "xterm-256color", cols: 120, rows: 40,
      cwd: opts.cwd, env: opts.env as Record<string, string>,
    });
    return {
      write: (d) => p.write(d),
      kill: () => { try { p.kill(); } catch { /* already gone */ } },
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit((e: { exitCode: number }) => cb(e.exitCode)),
      pid: p.pid,
    };
  } catch { /* node-pty not installed — fall through to script(1) */ }

  const env = { ...opts.env, TERM: "xterm-256color", COLUMNS: "120", LINES: "40" };
  const proc = spawn("expect", ["-f", relayScriptPath(), "--", command, ...args], { cwd: opts.cwd, env, detached: true });
  return {
    write: (d) => { try { proc.stdin.write(d); } catch { /* stream closed */ } },
    kill: () => {
      if (proc.pid) {
        try { process.kill(-proc.pid, "SIGTERM"); } catch {
          try { proc.kill("SIGTERM"); } catch { /* already gone */ }
        }
      }
    },
    onData: (cb) => {
      proc.stdout.on("data", (c: Buffer) => cb(c.toString()));
      proc.stderr.on("data", (c: Buffer) => cb(c.toString()));
    },
    onExit: (cb) => {
      proc.on("close", (code) => cb(code));
      proc.on("error", () => cb(-1));
    },
    pid: proc.pid,
  };
}
