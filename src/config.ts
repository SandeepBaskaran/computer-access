// ── Centralised configuration ───────────────────────────────
// All environment parsing lives here so tools and the transport
// layer share a single, validated view of the runtime config.
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
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

// Allowed directories: env takes precedence, else positional CLI args.
const envDirs = list(process.env.ALLOWED_DIRS);
const argDirs = process.argv.slice(2).filter(arg => !arg.startsWith("-"));
export const ALLOWED_DIRS = (envDirs.length > 0 ? envDirs : argDirs).map(d => path.resolve(d));

// Single source of truth for the port so the server and the ngrok
// bootstrapper always agree (previously 3000 vs 8123 could diverge).
export const PORT = int(process.env.PORT, 8123);
export const COMMAND_TIMEOUT = int(process.env.COMMAND_TIMEOUT, 30000);
export const MCP_TOKEN = process.env.MCP_TOKEN;

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
