// ── Centralised configuration ───────────────────────────────
// All environment parsing lives here so tools and the transport
// layer share a single, validated view of the runtime config.
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { readFileSync, appendFileSync, watch as fsWatch } from "fs";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the project root (one level up from dist/ or src/).
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const bool = (v: string | undefined, def: boolean) =>
  v === undefined ? def : v !== "false";

const int = (v: string | undefined, def: number) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : def;
};

const list = (v: string | undefined) =>
  (v || "").split(",").map(s => s.trim()).filter(Boolean);

// ── Allowed directories ─────────────────────────────────────
// env ∪ positional CLI args ∪ allowed-dirs.txt, defaulting to ~/Documents.
// Additions are non-interactive (`--add-dir <path>` or the file); removals and
// edits happen ONLY by editing the file. The file hot-reloads.
export const ALLOWED_DIRS_FILE = path.resolve(__dirname, "../allowed-dirs.txt");

const expandHome = (d: string) => (d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : d);

function readAllowedDirsFile(): string[] {
  try {
    return readFileSync(ALLOWED_DIRS_FILE, "utf-8")
      .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  } catch { return []; }
}

const envDirs = list(process.env.ALLOWED_DIRS);
const argDirs = process.argv.slice(2).filter(arg => !arg.startsWith("-"));

// Non-interactive add: `node dist/server.js --add-dir <path>` appends and exits.
{
  const addIdx = process.argv.indexOf("--add-dir");
  if (addIdx !== -1) {
    const dir = process.argv[addIdx + 1];
    if (!dir) { console.error("usage: --add-dir <absolute-path>"); process.exit(1); }
    const resolved = path.resolve(expandHome(dir));
    const current = readAllowedDirsFile();
    if (current.includes(resolved)) {
      console.error(`already allowed: ${resolved}`);
    } else {
      appendFileSync(ALLOWED_DIRS_FILE, (current.length === 0 ? "# One allowed directory per line. Edit this file to remove or change entries.\n" : "") + resolved + "\n");
      console.error(`added to allowed dirs: ${resolved}`);
    }
    process.exit(0);
  }
}

function computeAllowedDirs(): string[] {
  return [...new Set([...envDirs, ...argDirs, ...readAllowedDirsFile()])].map(d => path.resolve(expandHome(d)));
}

// Mutable in place so the security module's per-call checks see hot reloads.
export const ALLOWED_DIRS: string[] = computeAllowedDirs();
export const allowedDirsInfo = { defaulted: false };
if (ALLOWED_DIRS.length === 0) {
  ALLOWED_DIRS.push(path.join(os.homedir(), "Documents"));
  allowedDirsInfo.defaulted = true;
}
try {
  fsWatch(path.dirname(ALLOWED_DIRS_FILE), (_e, f) => {
    if (f !== path.basename(ALLOWED_DIRS_FILE)) return;
    const fresh = computeAllowedDirs();
    if (fresh.length > 0) {
      ALLOWED_DIRS.splice(0, ALLOWED_DIRS.length, ...fresh);
      allowedDirsInfo.defaulted = false;
      console.error(`[BRIDGE] allowed-dirs.txt reloaded — ${ALLOWED_DIRS.length} allowed dir(s).`);
    }
  });
} catch { /* watcher is best-effort */ }

// Single source of truth for the port so the server and the ngrok
// bootstrapper always agree (previously 3000 vs 8123 could diverge).
export const PORT = int(process.env.PORT, 8123);
export const COMMAND_TIMEOUT = int(process.env.COMMAND_TIMEOUT, 30000);
// Generic bearer for the internet-exposed MCP endpoint (MCP_TOKEN is the legacy alias).
export const MCP_TOKEN = process.env.BRIDGE_AUTH_TOKEN || process.env.MCP_TOKEN;

export const SESSION_IDLE_TTL_MS = int(process.env.SESSION_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
export const SESSION_MAX_TTL_MS = int(process.env.SESSION_MAX_TTL_MS, 8 * 60 * 60 * 1000);
export const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export const CORS_ORIGINS = list(process.env.CORS_ORIGINS);

export const ENABLE_WRITE_EDIT = bool(process.env.ENABLE_WRITE_EDIT, true);
export const ENABLE_RUN_COMMAND = bool(process.env.ENABLE_RUN_COMMAND, true);
export const ENABLE_GIT = bool(process.env.ENABLE_GIT, true);
export const ENABLE_FFMPEG = bool(process.env.ENABLE_FFMPEG, true);
export const ENABLE_BROWSER = bool(process.env.ENABLE_BROWSER, true);
export const ENABLE_NET = bool(process.env.ENABLE_NET, true);
export const ENABLE_DB = bool(process.env.ENABLE_DB, true);
// Keychain access is the largest exfiltration surface — off by default.
export const ENABLE_SECRETS = bool(process.env.ENABLE_SECRETS, false);

export const ENABLE_CONFIRMATION_GATE = process.env.ENABLE_CONFIRMATION_GATE === "true";

export const MAX_READ_BYTES = int(process.env.MAX_READ_BYTES, 10 * 1024 * 1024);
// Buffer cap for child-process stdout/stderr (rg over large repos needs headroom).
export const MAX_EXEC_BUFFER = int(process.env.MAX_EXEC_BUFFER, 64 * 1024 * 1024);
export const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
export const RATE_LIMIT_WINDOW_MS = int(process.env.RATE_LIMIT_WINDOW_MS, 60000);
export const RATE_LIMIT_MAX = int(process.env.RATE_LIMIT_MAX, 200);

// Optional per-tool allowlist for least-privilege deployments.
// When set (comma-separated tool names), only those tools are registered.
export const TOOL_ALLOWLIST = list(process.env.TOOLS);

export const KILL_SWITCH_PATH = path.join(os.homedir(), ".mcp_kill");
export const AUDIT_LOG_PATH = path.resolve(__dirname, "../audit.log");
// Rotate the audit log once it grows past this size (bytes).
export const AUDIT_LOG_MAX_BYTES = int(process.env.AUDIT_LOG_MAX_BYTES, 10 * 1024 * 1024);

// ── Build bridge configuration ──────────────────────────────
export const DEFAULT_AGENT = process.env.DEFAULT_AGENT || process.env.DEFAULT_PROVIDER || "claude-code";
export const WORKTREE_ROOT = path.resolve(expandHome(process.env.WORKTREE_ROOT || path.join(os.homedir(), ".bridge", "worktrees")));
export const MAX_CONCURRENT_JOBS = int(process.env.MAX_CONCURRENT_JOBS, 2);
export const HEARTBEAT_TIMEOUT_MS = int(process.env.HEARTBEAT_TIMEOUT_MS, 15 * 60 * 1000);
export const JOB_MAX_RUNTIME_MS = int(process.env.JOB_MAX_RUNTIME_MS, 2 * 60 * 60 * 1000);
export const REVERT_WINDOW_HOURS = int(process.env.REVERT_WINDOW_HOURS, 168);
export const PLAN_TIMEOUT_MS = int(process.env.PLAN_TIMEOUT_MS, 10 * 60 * 1000);
export const HOLD_RETRY_MS = int(process.env.HOLD_RETRY_MS, 30 * 60 * 1000);
export const PLAN_FALLBACK_AGENT = process.env.PLAN_FALLBACK_AGENT ?? "claude-code";
export const PLAN_MIN_CHARS = int(process.env.PLAN_MIN_CHARS, 200);
export const PLAN_IDLE_MS = int(process.env.PLAN_IDLE_MS, 20000);
export const RESUME_STRATEGY = (["resume", "rerun", "rework"].includes(process.env.RESUME_STRATEGY || "") ? process.env.RESUME_STRATEGY : "resume") as "resume" | "rerun" | "rework";
export const WAKE_GAP_MS = int(process.env.WAKE_GAP_MS, 120000);
export const TUNNEL_API_URL = process.env.TUNNEL_API_URL || "http://127.0.0.1:4040/api/tunnels";
export const ALLOW_PACKAGE_INSTALLS = bool(process.env.ALLOW_PACKAGE_INSTALLS, true);
export const DEFAULT_MODE = (process.env.DEFAULT_MODE === "accept_edits" ? "accept_edits" : "auto") as "auto" | "accept_edits";
export const BRIDGE_DATA_DIR = path.resolve(__dirname, "../data");
export const PROVIDERS_PATH = path.resolve(__dirname, "../providers.json");
