import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { readFile, writeFile, mkdir, readdir, stat, rm, rename, realpath, appendFile, copyFile } from "fs/promises";
import { exec, spawn, execFileSync } from "child_process";
import { watch as fsWatch } from "fs";
import { promisify } from "util";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import * as xlsx from "xlsx";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import mime from "mime-types";
import axios from "axios";
import puppeteer from "puppeteer";
import { parse as csvParse } from "csv-parse/sync";
import fg from "fast-glob";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { createBridge } from "./bridge.js";
import { readFileSync, appendFileSync } from "fs";

// ── Environment Loading ─────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const execPromise = promisify(exec);

// ── Configuration ───────────────────────────────────────────
// ALLOWED_DIRS: env + argv + allowed-dirs.txt, defaulting to ~/Documents.
// Additions are non-interactive (`--add-dir <path>` or the file); removals and
// edits happen ONLY by editing the file — no command can shrink the allowlist.
const ALLOWED_DIRS_FILE = path.resolve(__dirname, "../allowed-dirs.txt");

function readAllowedDirsFile(): string[] {
  try {
    return readFileSync(ALLOWED_DIRS_FILE, "utf-8")
      .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  } catch { return []; }
}

const envDirs = (process.env.ALLOWED_DIRS || "").split(",").filter(Boolean);
const argDirs = process.argv.slice(2).filter(arg => !arg.startsWith("-"));

// Non-interactive add: `node dist/server.js --add-dir <path>` appends to the file and exits.
{
  const addIdx = process.argv.indexOf("--add-dir");
  if (addIdx !== -1) {
    const dir = process.argv[addIdx + 1];
    if (!dir) { console.error("usage: --add-dir <absolute-path>"); process.exit(1); }
    const resolved = path.resolve(dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir);
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

let ALLOWED_DIRS = [...new Set([...envDirs, ...argDirs, ...readAllowedDirsFile()])].map(d =>
  path.resolve(d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : d));
let allowedDirsDefaulted = false;
if (ALLOWED_DIRS.length === 0) {
  ALLOWED_DIRS = [path.join(os.homedir(), "Documents")];
  allowedDirsDefaulted = true;
}
// Hot-reload additions when allowed-dirs.txt changes (removals apply too — the file is authoritative for its own entries).
try {
  fsWatch(path.dirname(ALLOWED_DIRS_FILE), (_e, f) => {
    if (f !== path.basename(ALLOWED_DIRS_FILE)) return;
    const fresh = [...new Set([...envDirs, ...argDirs, ...readAllowedDirsFile()])].map(d =>
      path.resolve(d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : d));
    if (fresh.length > 0) {
      ALLOWED_DIRS = fresh;
      allowedDirsDefaulted = false;
      console.error(`[BRIDGE] allowed-dirs.txt reloaded — ${ALLOWED_DIRS.length} allowed dir(s).`);
    }
  });
} catch { /* watcher is best-effort */ }

const PORT = parseInt(process.env.PORT || "8123", 10); // keep in sync with start.ts + service plists
const COMMAND_TIMEOUT = parseInt(process.env.COMMAND_TIMEOUT || "30000", 10);
// Generic bearer auth for the internet-exposed MCP endpoint. MCP_TOKEN is the legacy alias.
const MCP_TOKEN = process.env.BRIDGE_AUTH_TOKEN || process.env.MCP_TOKEN;
const SESSION_IDLE_TTL_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || String(30 * 60 * 1000), 10);
const SESSION_MAX_TTL_MS = parseInt(process.env.SESSION_MAX_TTL_MS || String(8 * 60 * 60 * 1000), 10);
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ENABLE_WRITE_EDIT = process.env.ENABLE_WRITE_EDIT !== "false";
const ENABLE_RUN_COMMAND = process.env.ENABLE_RUN_COMMAND !== "false";
const ENABLE_GIT = process.env.ENABLE_GIT !== "false";
const ENABLE_FFMPEG = process.env.ENABLE_FFMPEG !== "false";
const ENABLE_BROWSER = process.env.ENABLE_BROWSER !== "false";
const ENABLE_NET = process.env.ENABLE_NET !== "false";
const ENABLE_DB = process.env.ENABLE_DB !== "false";
const MAX_READ_BYTES = parseInt(process.env.MAX_READ_BYTES || String(10 * 1024 * 1024), 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "200", 10);

// ── Build Bridge Configuration ──────────────────────────────
const DEFAULT_PROVIDER = process.env.DEFAULT_AGENT || process.env.DEFAULT_PROVIDER || "claude-code";
const rawWorktreeRoot = process.env.WORKTREE_ROOT || path.join(os.homedir(), ".bridge", "worktrees");
const WORKTREE_ROOT = rawWorktreeRoot.startsWith("~")
  ? path.join(os.homedir(), rawWorktreeRoot.slice(1))
  : path.resolve(rawWorktreeRoot);
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || "2", 10);
const HEARTBEAT_TIMEOUT_MS = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || String(15 * 60 * 1000), 10);
const JOB_MAX_RUNTIME_MS = parseInt(process.env.JOB_MAX_RUNTIME_MS || String(2 * 60 * 60 * 1000), 10);
const REVERT_WINDOW_HOURS = parseInt(process.env.REVERT_WINDOW_HOURS || "168", 10);
const PLAN_TIMEOUT_MS = parseInt(process.env.PLAN_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const HOLD_RETRY_MS = parseInt(process.env.HOLD_RETRY_MS || String(30 * 60 * 1000), 10);
const PLAN_FALLBACK_AGENT = process.env.PLAN_FALLBACK_AGENT ?? "claude-code";
const PLAN_MIN_CHARS = parseInt(process.env.PLAN_MIN_CHARS || "200", 10);
const PLAN_IDLE_MS = parseInt(process.env.PLAN_IDLE_MS || "20000", 10);
const WAKE_GAP_MS = parseInt(process.env.WAKE_GAP_MS || "120000", 10);
const RESUME_STRATEGY = (["resume", "rerun", "rework"].includes(process.env.RESUME_STRATEGY || "") ? process.env.RESUME_STRATEGY : "resume") as "resume" | "rerun" | "rework";
const TUNNEL_API_URL = process.env.TUNNEL_API_URL || "http://127.0.0.1:4040/api/tunnels";
const ALLOW_PACKAGE_INSTALLS = process.env.ALLOW_PACKAGE_INSTALLS !== "false"; // user-authorized installs, default ON
const DEFAULT_MODE = (process.env.DEFAULT_MODE === "accept_edits" ? "accept_edits" : "auto") as "auto" | "accept_edits";

// Tunnel liveness via the ngrok agent's local API (works for the launchd
// tunnel service; the embedded start.ts tunnel has its own health check).
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

// ── Security: Kill Switch ───────────────────────────────────
const KILL_SWITCH_PATH = path.join(os.homedir(), '.mcp_kill');

async function isKillSwitchActive(): Promise<boolean> {
  try {
    await stat(KILL_SWITCH_PATH);
    return true;
  } catch {
    return false;
  }
}

// ── Security: Confirmation Gate ─────────────────────────────
type DangerLevel = 'safe' | 'moderate' | 'dangerous';

const DANGER_MAP: Record<string, Record<string, DangerLevel>> = {
  'fs-manage': {
    read: 'safe', 'read-media': 'safe', 'batch-read': 'safe', list: 'safe',
    'list-with-sizes': 'safe', tree: 'safe', 'file-info': 'safe',
    write: 'moderate', 'smart-edit': 'moderate', patch: 'moderate',
    mkdir: 'moderate', copy: 'moderate', move: 'dangerous', delete: 'dangerous',
  },
  'sys-manage': {
    info: 'safe', 'ps-list': 'safe', 'list-apps': 'safe', 'active-app': 'safe',
    'window-list': 'safe', 'clipboard-read': 'safe', screenshot: 'safe',
    exec: 'dangerous', 'ps-kill': 'dangerous', 'open-app': 'moderate',
    'open-url': 'moderate', 'open-file': 'moderate', 'clipboard-write': 'moderate',
    notification: 'safe', say: 'safe', volume: 'moderate', brightness: 'moderate',
    caffeinate: 'safe', 'lock-screen': 'dangerous',
  },
  'git-manage': {
    status: 'safe', log: 'safe', diff: 'safe', branch: 'safe',
    add: 'moderate', commit: 'moderate', stash: 'moderate', tag: 'moderate',
    push: 'dangerous', pull: 'dangerous', merge: 'dangerous', raw: 'dangerous',
  },
  'bridge-merge': {
    merge: 'dangerous', revert: 'dangerous',
  },
};

function getDangerLevel(tool: string, action: string): DangerLevel {
  return DANGER_MAP[tool]?.[action] ?? 'moderate';
}

const ENABLE_CONFIRMATION_GATE = process.env.ENABLE_CONFIRMATION_GATE === 'true';

function requiresConfirmation(tool: string, action: string, args: Record<string, unknown>): { required: boolean; reason?: string } {
  if (!ENABLE_CONFIRMATION_GATE) return { required: false };
  const level = getDangerLevel(tool, action);
  if (level === 'dangerous') {
    return { required: true, reason: `${tool}:${action} is a dangerous operation` };
  }
  return { required: false };
}

// ── Security: Audit Logger ──────────────────────────────────
async function auditLog(tool: string, input: any, status: "SUCCESS" | "BLOCKED" | "ERROR", sessionId?: string, errorMessage?: string, targetDir?: string) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    session: sessionId || "SYSTEM",
    tool,
    input,
    status,
    ...(targetDir ? { cwd: targetDir } : {}),
    ...(errorMessage ? { error: errorMessage } : {})
  }) + "\n";
  await appendFile(path.join(__dirname, "../audit.log"), entry).catch(e => console.error("Audit log failed:", e));
}

// Startup notice at every boot: where the sandbox is, and the non-interactive
// way to widen it. Removing/editing entries is done ONLY by editing the file.
if (allowedDirsDefaulted) {
  console.error(`[BRIDGE] ALLOWED_DIRS not configured — defaulting to ${ALLOWED_DIRS[0]}`);
}
console.error(`[BRIDGE] Allowed directories (${ALLOWED_DIRS.length}): ${ALLOWED_DIRS.join(", ")}`);
console.error(`[BRIDGE]   add one:    node dist/server.js --add-dir /absolute/path   (also available via the service CLI: add-dir)`);
console.error(`[BRIDGE]   remove/edit: edit ${ALLOWED_DIRS_FILE} (file is the source of truth; changes hot-reload)`);

// Generic bearer auth is REQUIRED — this endpoint is internet-exposed via the tunnel.
if (!MCP_TOKEN && process.env.BRIDGE_ALLOW_NO_AUTH !== "true") {
  console.error("CRITICAL ERROR: BRIDGE_AUTH_TOKEN is not set. The MCP endpoint is internet-exposed and must be authenticated.");
  console.error("Fix:  set BRIDGE_AUTH_TOKEN=<random-secret> in .env   (or BRIDGE_ALLOW_NO_AUTH=true for local-only testing)");
  process.exit(1);
}
if (!MCP_TOKEN) console.error("[BRIDGE] WARNING: running WITHOUT auth (BRIDGE_ALLOW_NO_AUTH=true) — local testing only.");

// ── Security: Path Validation ───────────────────────────────
async function expandAndResolve(filePath: string): Promise<string> {
  let expanded = filePath;
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  return path.resolve(expanded);
}

async function isPathAllowed(filePath: string): Promise<boolean> {
  const resolved = await expandAndResolve(filePath);
  const normalize = (p: string) => process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
  const resolvedLower = normalize(resolved);

  const literalMatch = ALLOWED_DIRS.some(dir => {
    const resolvedDir = normalize(path.resolve(dir));
    return resolvedLower === resolvedDir || resolvedLower.startsWith(resolvedDir + path.sep);
  });

  if (literalMatch) return true;

  try {
    const real = normalize(await realpath(resolved));
    return ALLOWED_DIRS.some(dir => {
      const resolvedDir = normalize(path.resolve(dir));
      return real === resolvedDir || real.startsWith(resolvedDir + path.sep);
    });
  } catch {
    try {
      const parentReal = normalize(await realpath(path.dirname(resolved)));
      return ALLOWED_DIRS.some(dir => {
        const resolvedDir = normalize(path.resolve(dir));
        return parentReal === resolvedDir || parentReal.startsWith(resolvedDir + path.sep);
      });
    } catch {
      return false;
    }
  }
}

// ── Build Bridge ────────────────────────────────────────────
// Durable, dispatcher-agnostic job orchestration (start / plan / get_status /
// answer / merge / cancel). Confirmation gate is break-glass: ON means merge
// refuses outright — approval flows live with whichever tool dispatches work.
const bridge = createBridge({
  dataDir: path.join(__dirname, "../data"),
  registryPath: path.join(__dirname, "../providers.json"),
  worktreeRoot: WORKTREE_ROOT,
  defaultProvider: DEFAULT_PROVIDER,
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
  confirmationGateEnabled: () => requiresConfirmation("bridge-merge", "merge", {}).required,
  isPathAllowed,
});
bridge.startSweeps();

// ── Helper: Directory Tree ──────────────────────────────────
async function getDirectoryTree(dirPath: string, excludes: string[] = []): Promise<any> {
    const name = path.basename(dirPath);
    const item: any = { name, type: "directory", children: [] };
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        if (excludes.some(pattern => entry.name.includes(pattern))) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            item.children.push(await getDirectoryTree(fullPath, excludes));
        } else {
            item.children.push({ name: entry.name, type: "file" });
        }
    }
    return item;
}

// ── Security: Command Blocklist ─────────────────────────────
// Package installs are USER-AUTHORIZED by design (these are the user's own
// repos): with ALLOW_PACKAGE_INSTALLS=true (default) nothing here matches an
// install. Only when the user opts out is the pattern enforced — and exec
// already only runs inside ALLOWED_DIRS.
const INSTALL_COMMAND_RE = /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bcargo\s+(install|add)\b|\bbrew\s+install\b|\bgem\s+install\b|\bpoetry\s+add\b|\buv\s+(pip\s+install|add)\b/i;

const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)?\//,
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
  /mkfs\./,
  /dd\s+if=/,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
  />\s*\/dev\/sd/,
  /chmod\s+777/,
  /curl\s.*\|\s*(ba)?sh/,
  /wget\s.*\|\s*(ba)?sh/,
  /shutdown/,
  /reboot/,
  /init\s+[06]/,
];

// ── Global Singletons ──────────────────────────────────────
let browser: puppeteer.Browser | null = null;
let isRgInstalled: boolean | null = null;

async function checkRg() {
  if (isRgInstalled !== null) return isRgInstalled;
  try { await execPromise("rg --version"); isRgInstalled = true; }
  catch { isRgInstalled = false; }
  return isRgInstalled;
}

// ── Background Tasks ────────────────────────────────────────
interface BackgroundTask {
  id: string;
  command: string;
  status: "running" | "completed" | "failed" | "cancelled";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  pid?: number;
}
const backgroundTasks = new Map<string, BackgroundTask>();

// ── File Watchers ───────────────────────────────────────────
interface FileWatcherEntry {
  id: string;
  watchedPath: string;
  events: Array<{ type: string; filename: string | null; timestamp: number }>;
  handle: ReturnType<typeof fsWatch>;
}
const fileWatchers = new Map<string, FileWatcherEntry>();

// ── Webhook Helper ──────────────────────────────────────────
async function sendWebhook(tool: string, action: string, result: string) {
  if (!WEBHOOK_URL) return;
  try {
    await axios.post(WEBHOOK_URL, { tool, action, result, timestamp: new Date().toISOString() }, { timeout: 5000 });
  } catch { /* non-fatal */ }
}

// ── MCP Server Factory ──────────────────────────────────────
function createMcpServer(sessionId: string) {
  const server = new McpServer({
    name: "computer-access",
    version: "1.0.0",
    description: "Universal cross-platform secure bridge for ANY cloud agent"
  });

  /**
   * ── Master Tool 1: fs-manage ──────────────────────────────
   */
  server.registerTool("fs-manage", {
    title: "Filesystem Manager",
    description: "Advanced file operations including read, write, batch access, tree visualization, and surgical editing.",
    inputSchema: {
      action: z.enum([
        "read", "read-media", "batch-read", "write", "smart-edit", "patch", "list", 
        "list-with-sizes", "tree", "file-info", "move", "copy", "delete", "mkdir"
      ]).describe("File operation to perform"),
      path: z.string().optional().describe("Target path"),
      paths: z.array(z.string()).optional().describe("Multiple paths for batch-read"),
      content: z.string().optional().describe("Content for 'write'"),
      targetContent: z.string().optional().describe("String to find for 'smart-edit'"),
      newContent: z.string().optional().describe("Replacement string for 'smart-edit'"),
      destination: z.string().optional().describe("Destination for 'move' or 'copy'"),
      limit: z.number().optional().describe("Line limit for 'read' head/tail"),
      tail: z.boolean().optional().describe("If true, 'read' returns the last N lines"),
      excludes: z.array(z.string()).optional().describe("Patterns to exclude in 'tree'"),
      sortBy: z.enum(["name", "size"]).optional().describe("Sort order for 'list-with-sizes'")
    }
  }, async ({ action, path: filePath, paths, content, targetContent, newContent, destination, limit, tail, excludes, sortBy }) => {
    try {
      if (action === "batch-read") {
        if (!paths) throw new Error("Paths array required for batch-read");
        const results = await Promise.all(paths.map(async (p) => {
            const fullP = await expandAndResolve(p);
            if (!(await isPathAllowed(fullP))) return { path: p, error: "ACCESS DENIED" };
            try { return { path: p, content: await readFile(fullP, "utf-8") }; }
            catch (e: any) { return { path: p, error: e.message }; }
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      }

      const fullPath = filePath ? await expandAndResolve(filePath) : undefined;
      if (fullPath && !(await isPathAllowed(fullPath))) {
          await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "ACCESS DENIED", fullPath);
          return { content: [{ type: "text" as const, text: `ACCESS DENIED: Path '${fullPath}' is restricted.` }] };
      }

      switch (action) {
        case "read": {
          if (!fullPath) throw new Error("Path required for read");
          const fileStats = await stat(fullPath);
          if (fileStats.size > MAX_READ_BYTES) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, `File too large (${fileStats.size} bytes, limit ${MAX_READ_BYTES})`);
            return { content: [{ type: "text" as const, text: `BLOCKED: File is ${(fileStats.size / 1024 / 1024).toFixed(1)} MB, exceeding MAX_READ_BYTES limit of ${(MAX_READ_BYTES / 1024 / 1024).toFixed(0)} MB. Use 'limit' parameter to read a subset of lines.` }] };
          }
          let text = await readFile(fullPath, "utf-8");
          if (limit) {
            const lines = text.split("\n");
            text = tail ? lines.slice(-limit).join("\n") : lines.slice(0, limit).join("\n");
          }
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text }] };
        }
        case "read-media": {
          if (!fullPath) throw new Error("Path required for read-media");
          const buffer = await readFile(fullPath);
          const mimeType = mime.lookup(fullPath) || "application/octet-stream";
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `data:${mimeType};base64,${buffer.toString("base64")}` }] };
        }
        case "write": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || content === undefined) throw new Error("Path and content required for write");
          await mkdir(path.dirname(fullPath), { recursive: true });
          await writeFile(fullPath, content);
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `File written: ${filePath}` }] };
        }
        case "smart-edit": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || targetContent === undefined || newContent === undefined) throw new Error("Path, targetContent, and newContent required for smart-edit");
          const original = await readFile(fullPath, "utf-8");
          if (!original.includes(targetContent)) throw new Error("targetContent not found in file");
          const updated = original.replace(targetContent, newContent);
          await writeFile(fullPath, updated);
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Successfully updated ${filePath}` }] };
        }
        case "list": {
          if (!fullPath) throw new Error("Path required for list");
          const entries = await readdir(fullPath, { withFileTypes: true });
          const list = entries.map(e => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`).join("\n");
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: list || "[Empty]" }] };
        }
        case "list-with-sizes": {
          if (!fullPath) throw new Error("Path required for list-with-sizes");
          const entries = await readdir(fullPath, { withFileTypes: true });
          let results = await Promise.all(entries.map(async (e) => {
              const info = await stat(path.join(fullPath, e.name));
              return { name: e.name, type: e.isDirectory() ? "directory" : "file", size: info.size };
          }));
          if (sortBy === "size") results.sort((a, b) => b.size - a.size);
          else results.sort((a, b) => a.name.localeCompare(b.name));
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
        }
        case "tree": {
          if (!fullPath) throw new Error("Path required for tree");
          const tree = await getDirectoryTree(fullPath, excludes);
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: JSON.stringify(tree, null, 2) }] };
        }
        case "file-info": {
          if (!fullPath) throw new Error("Path required for file-info");
          const info = await stat(fullPath);
          const details = {
              size: info.size,
              created: info.birthtime,
              modified: info.mtime,
              permissions: info.mode.toString(8).slice(-3),
              mime: mime.lookup(fullPath) || "unknown"
          };
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }] };
        }
        case "move": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || !destination) throw new Error("Path and destination required for move");
          const destPath = await expandAndResolve(destination);
          if (!(await isPathAllowed(destPath))) {
            await auditLog("fs-manage", { action, path: filePath, destination }, "BLOCKED", sessionId, "Destination restricted.", destPath);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Destination restricted." }] };
          }
          await rename(fullPath, destPath);
          await auditLog("fs-manage", { action, path: filePath, destination }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Moved to ${destination}` }] };
        }
        case "copy": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || !destination) throw new Error("Path and destination required for copy");
          const destPath = await expandAndResolve(destination);
          if (!(await isPathAllowed(destPath))) {
            await auditLog("fs-manage", { action, path: filePath, destination }, "BLOCKED", sessionId, "Destination restricted.", destPath);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Destination restricted." }] };
          }
          await copyFile(fullPath, destPath);
          await auditLog("fs-manage", { action, path: filePath, destination }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Copied to ${destination}` }] };
        }
        case "delete": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath) throw new Error("Path required for delete");
          
          // Safety: Prevent deleting the exact root of an allowed directory
          const isRoot = ALLOWED_DIRS.some(dir => {
            const resolvedRoot = path.resolve(dir).toLowerCase();
            return fullPath.toLowerCase() === resolvedRoot;
          });
          if (isRoot) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Deleting the workspace root is prohibited.", fullPath);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Deleting the exact root of an allowed directory is prohibited for safety. Delete its contents instead." }] };
          }

          const s = await stat(fullPath).catch(() => null);
          const isDir = s?.isDirectory();
          await rm(fullPath, { recursive: true, force: true });
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Successfully deleted ${isDir ? "directory" : "file"}: ${filePath}` }] };
        }
        case "mkdir": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath) throw new Error("Path required for mkdir");
          await mkdir(fullPath, { recursive: true });
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Created directory: ${filePath}` }] };
        }
        case "patch": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || !content) throw new Error("Path and content (unified diff) required for patch");
          const original = await readFile(fullPath, "utf-8");
          const origLines = original.split("\n");
          const diffLines = content.split("\n");
          const result: string[] = [...origLines];
          let offset = 0;
          const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
          for (let i = 0; i < diffLines.length; i++) {
            const m = diffLines[i].match(hunkRe);
            if (!m) continue;
            const origStart = parseInt(m[1], 10) - 1;
            const removals: number[] = [];
            const additions: string[] = [];
            let lineIdx = origStart;
            let j = i + 1;
            while (j < diffLines.length && !diffLines[j].match(hunkRe)) {
              const dl = diffLines[j];
              if (dl.startsWith("-")) { removals.push(lineIdx + offset); lineIdx++; }
              else if (dl.startsWith("+")) { additions.push(dl.substring(1)); }
              else { lineIdx++; }
              j++;
            }
            for (const idx of removals.reverse()) result.splice(idx, 1);
            const insertAt = removals.length > 0 ? Math.min(...removals) : origStart + offset;
            result.splice(insertAt, 0, ...additions);
            offset += additions.length - removals.length;
            i = j - 1;
          }
          await writeFile(fullPath, result.join("\n"));
          const hunkCount = diffLines.filter(l => l.match(hunkRe)).length;
          await auditLog("fs-manage", { action, path: filePath, hunks: hunkCount }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Patch applied to ${filePath} (${hunkCount} hunk${hunkCount !== 1 ? "s" : ""})` }] };
        }
        default:
          throw new Error(`Unsupported fs-manage action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("fs-manage", { action }, "ERROR", sessionId, e.message, filePath ? await expandAndResolve(filePath) : undefined);
      return { content: [{ type: "text" as const, text: `FS Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 2: fs-search ──────────────────────────────
   */
  server.registerTool("fs-search", {
    title: "Codebase Search",
    description: "Recursive regex search, glob-based file finding, or code definition listing.",
    inputSchema: {
      action: z.enum(["regex-search", "file-search", "code-definitions"]).describe("Action to perform"),
      query: z.string().describe("Search query (regex, glob, or symbol name)"),
      directory: z.string().optional().describe("Target directory"),
      contextLines: z.number().optional().describe("Lines of context for regex-search (default: 2)"),
      excludes: z.array(z.string()).optional().describe("Glob patterns to exclude")
    }
  }, async ({ action, query, directory, contextLines = 2, excludes }) => {
    const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];
    if (!(await isPathAllowed(targetDir))) {
      await auditLog("fs-search", { action, query, directory }, "BLOCKED", sessionId, "ACCESS DENIED", targetDir);
      return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
    }
    
    try {
      const isRg = await checkRg();
      switch (action) {
        case "regex-search": {
          if (isRg) {
            const excludeArgs = (excludes || []).map(p => `--glob "!${p}"`).join(" ");
            const { stdout } = await execPromise(`rg -iC ${contextLines} ${excludeArgs} --glob "!.git" --glob "!node_modules" --glob "!dist" ${JSON.stringify(query)} .`, { cwd: targetDir });
            await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
            return { content: [{ type: "text" as const, text: stdout || "No matches (rg)." }] };
          } else {
            const excludeArgs = (excludes || []).map(p => `--exclude="${p}"`).join(" ");
            const { stdout } = await execPromise(`grep -rinC ${contextLines} ${excludeArgs} --exclude-dir={.git,node_modules,dist} ${JSON.stringify(query)} .`, { cwd: targetDir });
            await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
            return { content: [{ type: "text" as const, text: stdout || "No matches (grep)." }] };
          }
        }
        case "file-search": {
          if (isRg) {
            const { stdout } = await execPromise(`rg --files -g ${JSON.stringify(query)}`, { cwd: targetDir });
            await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
            return { content: [{ type: "text" as const, text: stdout || "No files found (rg)." }] };
          } else {
            // Use fast-glob for absolute accuracy and ** support
            const files = await fg(query, { cwd: targetDir, ignore: excludes || ["node_modules/**", ".git/**"] });
            await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
            return { content: [{ type: "text" as const, text: files.join("\n") || "No files found (glob)." }] };
          }
        }
        case "code-definitions": {
            const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const patternStrings = [
                `export (async )?function ${escapedQuery}`,
                `class ${escapedQuery}`,
                `const ${escapedQuery} =`,
                `let ${escapedQuery} =`,
                `interface ${escapedQuery}`,
                `type ${escapedQuery}`
            ];
            
            try {
              if (isRg) {
                const args = patternStrings.map(p => `-e ${JSON.stringify(p)}`).join(" ");
                const { stdout } = await execPromise(`rg -i ${args} . --glob "!.git" --glob "!node_modules"`, { cwd: targetDir });
                await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
                return { content: [{ type: "text" as const, text: stdout || "No definitions found (rg)." }] };
              } else {
                const args = patternStrings.map(p => `-e ${JSON.stringify(p)}`).join(" ");
                const { stdout } = await execPromise(`grep -rinI ${args} . --exclude-dir={.git,node_modules,dist}`, { cwd: targetDir });
                await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
                return { content: [{ type: "text" as const, text: stdout || "No definitions found (grep)." }] };
              }
            } catch (e: any) {
              const errorMsg = `Search Error (code-definitions):\nExit Code: ${e.code}\nStderr: ${e.stderr}\nStdout: ${e.stdout}\nMessage: ${e.message}`;
              await auditLog("fs-search", { action, query }, "ERROR", sessionId, errorMsg, targetDir);
              return { content: [{ type: "text" as const, text: errorMsg }] };
            }
        }
        default:
          throw new Error(`Unsupported search action: ${action}`);
      }
    } catch (e: any) {
      const errorMsg = `Search Error (${action}):\nExit Code: ${e.code}\nStderr: ${e.stderr}\nStdout: ${e.stdout}\nMessage: ${e.message}`;
      await auditLog("fs-search", { action, query }, "ERROR", sessionId, errorMsg, targetDir);
      return { content: [{ type: "text" as const, text: errorMsg }] };
    }
  });

  /**
   * ── Master Tool 3: sys-manage ──────────────────────────────
   */
  server.registerTool("sys-manage", {
    title: "System & macOS Control",
    description: "Execute shell commands, manage processes, control macOS apps, clipboard, and system settings.",
    inputSchema: {
      action: z.enum([
        "exec", "info", "ps-list", "ps-kill", "list-apps", "open-app", "open-url", "open-file",
        "clipboard-read", "clipboard-write", "screenshot", "notification", "say",
        "volume", "brightness", "caffeinate", "lock-screen", "active-app", "window-list",
        "test-run", "lint"
      ]).describe("Action to perform"),
      command: z.string().optional().describe("Shell command (for 'exec')"),
      pid: z.number().optional().describe("PID (for 'ps-kill')"),
      url: z.string().optional().describe("URL (for 'open-url')"),
      path: z.string().optional().describe("File path (for 'open-file' or 'screenshot')"),
      name: z.string().optional().describe("App name (for 'open-app')"),
      text: z.string().optional().describe("Text (for 'clipboard-write', 'notification', 'say')"),
      title: z.string().optional().describe("Title (for 'notification')"),
      level: z.number().optional().describe("Level 0-100 (for 'volume', 'brightness')"),
      duration: z.number().optional().describe("Duration in seconds (for 'caffeinate')"),
      directory: z.string().optional().describe("CWD (for 'exec')")
    }
  }, async ({ action, command, pid, url, path: filePath, name, text, title, level, duration, directory }) => {
    try {
      const fullPath = filePath ? await expandAndResolve(filePath) : undefined;
      const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];
      
      switch (action) {
        case "exec": {
          if (!ENABLE_RUN_COMMAND) {
            await auditLog("sys-manage", { action, command }, "BLOCKED", sessionId, "Exec disabled.", targetDir);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Exec disabled." }] };
          }
          if (!command) throw new Error("Command required for exec");
          if (!(await isPathAllowed(targetDir))) {
            await auditLog("sys-manage", { action, command }, "BLOCKED", sessionId, "ACCESS DENIED.", targetDir);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          }
          for (const p of BLOCKED_COMMAND_PATTERNS) {
            if (p.test(command)) {
              await auditLog("sys-manage", { action, command }, "BLOCKED", sessionId, "Blocked pattern.", targetDir);
              return { content: [{ type: "text" as const, text: "ACCESS DENIED: Blocked pattern." }] };
            }
          }
          if (!ALLOW_PACKAGE_INSTALLS && INSTALL_COMMAND_RE.test(command)) {
            await auditLog("sys-manage", { action, command }, "BLOCKED", sessionId, "Installs disabled.", targetDir);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: package installs are disabled (ALLOW_PACKAGE_INSTALLS=false)." }] };
          }
          // Stream stdout/stderr progress lines back over SSE so proxies see activity
          const writeEvent = activeSessions.get(sessionId)?.writeEvent;
          const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const proc = spawn("bash", ["-c", command], { cwd: targetDir });
            let stdout = "";
            let stderr = "";
            const timer = setTimeout(() => { proc.kill(); reject(new Error("Command timed out")); }, COMMAND_TIMEOUT);
            proc.stdout.on("data", (chunk: Buffer) => {
              const line = chunk.toString();
              stdout += line;
              writeEvent?.(`exec: ${line.trimEnd().slice(0, 200)}`);
            });
            proc.stderr.on("data", (chunk: Buffer) => {
              const line = chunk.toString();
              stderr += line;
              writeEvent?.(`exec: ${line.trimEnd().slice(0, 200)}`);
            });
            proc.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr }); });
            proc.on("error", (e) => { clearTimeout(timer); reject(e); });
          });
          await auditLog("sys-manage", { action, command }, "SUCCESS", sessionId, undefined, targetDir);
          return { content: [{ type: "text" as const, text: `${result.stdout}\n${result.stderr}`.trim() || "[Done]" }] };
        }
        case "info": {
          const { stdout: disk } = await execPromise("df -h / | tail -1 | awk '{print $4}'");
          const info = {
              os: `${os.type()} ${os.release()}`,
              cpu: os.cpus()[0].model,
              ram: Math.round(os.totalmem() / 1e9) + "GB",
              disk: disk.trim(),
              uptime: Math.round(os.uptime() / 3600) + "h"
          };
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
        }
        case "ps-list": {
          const { stdout } = await execPromise("ps -A -o pid,pcpu,pmem,comm | head -n 50");
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        case "ps-kill": {
          if (!pid) throw new Error("PID required");
          process.kill(pid);
          await auditLog("sys-manage", { action, pid }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Killed process ${pid}` }] };
        }
        case "list-apps": {
          const { stdout } = await execPromise("find /Applications -maxdepth 2 -name '*.app' | head -n 100");
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        case "open-app": {
          if (!name) throw new Error("App name required");
          await execPromise(`open -a ${JSON.stringify(name)}`);
          return { content: [{ type: "text" as const, text: `Opening ${name}` }] };
        }
        case "open-url": {
          if (!url) throw new Error("URL required");
          await execPromise(`open ${JSON.stringify(url)}`);
          return { content: [{ type: "text" as const, text: `Opening URL: ${url}` }] };
        }
        case "open-file": {
          if (!fullPath) throw new Error("Path required");
          if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          await execPromise(`open ${JSON.stringify(fullPath)}`);
          return { content: [{ type: "text" as const, text: `Opening file: ${filePath}` }] };
        }
        case "clipboard-read": {
          const { stdout } = await execPromise("pbpaste");
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        case "clipboard-write": {
          if (!text) throw new Error("Text required");
          const child = exec("pbcopy");
          child.stdin?.write(text);
          child.stdin?.end();
          return { content: [{ type: "text" as const, text: "Copied to clipboard." }] };
        }
        case "screenshot": {
          const target = fullPath || path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
          await execPromise(`screencapture -x ${JSON.stringify(target)}`);
          return { content: [{ type: "text" as const, text: `Screenshot saved to ${target}` }] };
        }
        case "notification": {
          if (!text) throw new Error("Text required");
          const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title || "Computer Access")}`;
          await execPromise(`osascript -e ${JSON.stringify(script)}`);
          await auditLog("sys-manage", { action, title, text: text.substring(0, 50) + (text.length > 50 ? "..." : "") }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: "Notification sent." }] };
        }
        case "say": {
          if (!text) throw new Error("Text required");
          await execPromise(`say ${JSON.stringify(text)}`);
          await auditLog("sys-manage", { action, text: text.substring(0, 50) + (text.length > 50 ? "..." : "") }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Said: ${text}` }] };
        }
        case "volume": {
          if (level === undefined) {
              const { stdout } = await execPromise("osascript -e 'output volume of (get volume settings)'");
              await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
              return { content: [{ type: "text" as const, text: `Current Volume: ${stdout.trim()}` }] };
          }
          await execPromise(`osascript -e 'set volume output volume ${level}'`);
          await auditLog("sys-manage", { action, level }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Volume set to ${level}` }] };
        }
        case "brightness": {
            // macOS safe brightness via pmset or mention limitation
            // For now, we'll use a display sleep command as a safe fallback for "0" or just mention it's limited.
            if (level === 0) {
                await execPromise("pmset displaysleepnow");
                await auditLog("sys-manage", { action, level }, "SUCCESS", sessionId);
                return { content: [{ type: "text" as const, text: "Display put to sleep." }] };
            }
            return { content: [{ type: "text" as const, text: "Brightness control requires 'brightness' CLI tool. Use 'say' or 'notification' for feedback." }] };
        }
        case "caffeinate": {
          const dur = duration || 3600;
          exec(`caffeinate -t ${dur}`);
          await auditLog("sys-manage", { action, duration: dur }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Preventing sleep for ${dur} seconds.` }] };
        }
        case "lock-screen": {
          await execPromise("/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend");
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: "Screen locked." }] };
        }
        case "active-app": {
          const { stdout } = await execPromise("osascript -e 'tell application \"System Events\" to get name of first process whose frontmost is true'");
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Active App: ${stdout.trim()}` }] };
        }
        case "window-list": {
          const script = 'tell application "System Events" to get name of every window of (every process whose visible is true)';
          const { stdout } = await execPromise(`osascript -e ${JSON.stringify(script)}`);
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout.trim() }] };
        }
        case "test-run": {
          if (!ENABLE_RUN_COMMAND) {
            await auditLog("sys-manage", { action }, "BLOCKED", sessionId, "Run command disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Run command disabled." }] };
          }
          const testDir = directory ? await expandAndResolve(directory) : filePath ? await expandAndResolve(filePath) : '.';
          const testCmd = command || 'npm test';
          try {
            const { stdout, stderr } = await execPromise(testCmd, { cwd: testDir, timeout: 120000 });
            await auditLog("sys-manage", { action, command: testCmd, directory: testDir }, "SUCCESS", sessionId);
            const output = [stdout, stderr].filter(Boolean).join('\n---stderr---\n');
            return { content: [{ type: "text" as const, text: `Test Results:\n${output}` }] };
          } catch (err: any) {
            await auditLog("sys-manage", { action, command: testCmd, directory: testDir }, "ERROR", sessionId, err.message);
            const output = [err.stdout, err.stderr].filter(Boolean).join('\n---stderr---\n');
            return { content: [{ type: "text" as const, text: `Test Failed (exit ${err.code}):\n${output}` }] };
          }
        }
        case "lint": {
          if (!ENABLE_RUN_COMMAND) {
            await auditLog("sys-manage", { action }, "BLOCKED", sessionId, "Run command disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Run command disabled." }] };
          }
          const lintDir = directory ? await expandAndResolve(directory) : filePath ? await expandAndResolve(filePath) : '.';
          const lintCmd = command || 'npx eslint . --format compact';
          try {
            const { stdout, stderr } = await execPromise(lintCmd, { cwd: lintDir, timeout: 60000 });
            await auditLog("sys-manage", { action, command: lintCmd, directory: lintDir }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: `Lint Results:\n${stdout || 'No issues found.'}` }] };
          } catch (err: any) {
            await auditLog("sys-manage", { action, command: lintCmd, directory: lintDir }, "ERROR", sessionId, err.message);
            const output = [err.stdout, err.stderr].filter(Boolean).join('\n---stderr---\n');
            return { content: [{ type: "text" as const, text: `Lint Issues (exit ${err.code}):\n${output}` }] };
          }
        }
        default:
          throw new Error(`Unsupported system action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("sys-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Sys Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 4: git-manage ─────────────────────────────
   */
  server.registerTool("git-manage", {
    title: "Git Commander",
    description: "Manage Git repositories with targeted actions or raw commands.",
    inputSchema: {
      action: z.enum([
        "status", "add", "commit", "push", "pull", "branch", "log", "diff", "stash", "merge", "tag", "raw"
      ]).describe("Git action to perform"),
      args: z.string().optional().describe("Arguments for the action (or raw command)"),
      message: z.string().optional().describe("Commit message"),
      directory: z.string().optional()
    }
  }, async ({ action, args = "", message, directory }) => {
    const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];
    if (!ENABLE_GIT) return { content: [{ type: "text" as const, text: "Error: Git disabled." }] };
    if (!(await isPathAllowed(targetDir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
    
    // Safety check for shell escapes in all git args
    if (args.includes("|") || args.includes(";") || args.includes("&")) return { content: [{ type: "text" as const, text: "Error: Shell escapes banned." }] };

    // Git Repo Awareness Check
    try {
      await stat(path.join(targetDir, ".git"));
    } catch {
      if (action !== "raw" || !args.includes("init")) {
        return { content: [{ type: "text" as const, text: `Git Error: Not a git repository in ${targetDir}. Use 'git init' via sys-manage or git-manage raw if you wish to initialize one.` }] };
      }
    }

    try {
      let cmd = `git ${action} ${args}`;
      if (action === "raw") cmd = `git ${args}`;
      if (action === "commit" && message) cmd = `git commit -m ${JSON.stringify(message)} ${args}`;
      
      const { stdout, stderr } = await execPromise(cmd, { cwd: targetDir, timeout: 30000 });
      await auditLog("git-manage", { action, args }, "SUCCESS", sessionId, undefined, targetDir);
      return { content: [{ type: "text" as const, text: `${stdout}\n${stderr}`.trim() || "[Success]" }] };
    } catch (e: any) {
      await auditLog("git-manage", { action }, "ERROR", sessionId, e.message, targetDir);
      return { content: [{ type: "text" as const, text: `Git Error: ${e.stdout || e.stderr || e.message}` }] };
    }
  });

  /**
   * ── Master Tool 5: media-manage ────────────────────────────
   */
  server.registerTool("media-manage", {
    title: "Media Processor",
    description: "Transcode video, convert images, extract audio, or read metadata via FFmpeg/FFprobe.",
    inputSchema: {
      action: z.enum(["transcode", "convert-image", "extract-audio", "metadata"]).describe("Action to perform"),
      args: z.string().optional().describe("FFmpeg args"),
      input: z.string().optional().describe("Input path"),
      output: z.string().optional().describe("Output path"),
      directory: z.string().optional()
    }
  }, async ({ action, args, input, output, directory }) => {
    const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];
    if (!ENABLE_FFMPEG) return { content: [{ type: "text" as const, text: "Error: FFmpeg disabled." }] };
    if (!(await isPathAllowed(targetDir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
    
    try {
      const fullInput = input ? path.join(targetDir, input) : undefined;
      const fullOutput = output ? path.join(targetDir, output) : undefined;

      switch (action) {
        case "transcode": {
          if (!args) throw new Error("Args required for transcode");
          const { stderr } = await execPromise(`ffmpeg -y ${args}`, { cwd: targetDir, timeout: 120000 });
          await auditLog("media-manage", { action, args }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stderr }] };
        }
        case "convert-image": {
          if (!input || !output) throw new Error("Input and output paths required");
          await execPromise(`ffmpeg -y -i ${JSON.stringify(input)} ${JSON.stringify(output)}`, { cwd: targetDir });
          await auditLog("media-manage", { action, input, output }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Converted to ${output}` }] };
        }
        case "extract-audio": {
          if (!input || !output) throw new Error("Input and output paths required");
          await execPromise(`ffmpeg -y -i ${JSON.stringify(input)} -vn -acodec libmp3lame ${JSON.stringify(output)}`, { cwd: targetDir });
          await auditLog("media-manage", { action, input, output }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Audio extracted to ${output}` }] };
        }
        case "metadata": {
          if (!input) throw new Error("Input path required");
          const mimeType = mime.lookup(input);
          if (mimeType && (mimeType.startsWith("application/") || mimeType.startsWith("text/"))) {
            if (!mimeType.includes("image") && !mimeType.includes("video") && !mimeType.includes("audio")) {
                return { content: [{ type: "text" as const, text: `Error: ${input} is a ${mimeType} file. Metadata extracting is only supported for media containers (audio/video/images). Use doc-manage for text files.` }] };
            }
          }
          const { stdout } = await execPromise(`ffprobe -v quiet -print_format json -show_format -show_streams ${JSON.stringify(input)}`, { cwd: targetDir });
          await auditLog("media-manage", { action, input }, "SUCCESS", sessionId, undefined, targetDir);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        default:
          throw new Error(`Unsupported media action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("media-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Media Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 6: doc-manage ──────────────────────────────
   */
  server.registerTool("doc-manage", {
    title: "Document Intelligence",
    description: "Read PDF, Word, Spreadsheets, CSV, or preview Markdown.",
    inputSchema: { 
        action: z.enum(["pdf", "docx", "spreadsheet", "csv", "markdown-preview"]).describe("Action to perform"),
        path: z.string().describe("Target file path")
    }
  }, async ({ action, path: filePath }) => {
    const fullPath = await expandAndResolve(filePath);
    if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
    
    try {
      switch (action) {
        case "spreadsheet": {
          const wb = xlsx.readFile(fullPath);
          const res: any = {};
          wb.SheetNames.forEach(n => res[n] = xlsx.utils.sheet_to_json(wb.Sheets[n]));
          await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
        }
        case "docx": {
          const { value } = await mammoth.extractRawText({ path: fullPath });
          await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: value }] };
        }
        case "csv": {
            const content = await readFile(fullPath, "utf-8");
            const records = csvParse(content, { columns: true, skip_empty_lines: true });
            await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }] };
        }
        case "markdown-preview": {
            // macOS trick: open md in browser or default app
            await execPromise(`open ${JSON.stringify(fullPath)}`);
            await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: `Opened ${filePath} for preview.` }] };
        }
        case "pdf": {
          const buf = await readFile(fullPath);
          const parser = new PDFParse({ data: buf });
          const data = await parser.getText();
          await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: data.text }] };
        }
      }
    } catch (e: any) {
      await auditLog("doc-manage", { action }, "ERROR", sessionId, e.message, fullPath);
      return { content: [{ type: "text" as const, text: `Doc Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 7: browser-manage ──────────────────────────
   */
  server.registerTool("browser-manage", {
    title: "Web Browser Controller",
    description: "Control a headless browser to navigate, click, type, and scrape content.",
    inputSchema: {
      action: z.enum(["navigate", "click", "type", "screenshot-page", "get-text", "get-html", "evaluate", "wait", "pdf"]).describe("Action to perform"),
      url: z.string().optional().describe("URL to navigate to"),
      selector: z.string().optional().describe("CSS selector for elements"),
      text: z.string().optional().describe("Text to type"),
      script: z.string().optional().describe("JS to evaluate"),
      path: z.string().optional().describe("Path for screenshot/PDF")
    }
  }, async ({ action, url, selector, text, script, path: filePath }) => {
    if (!ENABLE_BROWSER) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Browser tools disabled." }] };
    try {
      if (!browser) browser = await puppeteer.launch({ headless: true });
      const session = activeSessions.get(sessionId);
      if (!session) throw new Error("Session lost");
      if (!session.page) session.page = await browser.newPage();
      const page = session.page;

      switch (action) {
        case "navigate": {
          if (!url) throw new Error("URL required");
          await page.goto(url, { waitUntil: "networkidle2" });
          await auditLog("browser-manage", { action, url }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Navigated to ${url}` }] };
        }
        case "click": {
          if (!selector) throw new Error("Selector required");
          await page.click(selector);
          await auditLog("browser-manage", { action, selector }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Clicked ${selector}` }] };
        }
        case "type": {
          if (!selector || !text) throw new Error("Selector and text required");
          await page.type(selector, text);
          await auditLog("browser-manage", { action, selector }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Typed into ${selector}` }] };
        }
        case "get-text": {
          const content = await page.evaluate(() => document.body.innerText);
          await auditLog("browser-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: content }] };
        }
        case "get-html": {
          const html = await page.content();
          await auditLog("browser-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: html }] };
        }
        case "screenshot-page": {
          const target = filePath ? await expandAndResolve(filePath) : path.join(os.tmpdir(), `browser_${Date.now()}.png`);
          await page.screenshot({ path: target, fullPage: true });
          await auditLog("browser-manage", { action, target }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Screenshot saved to ${target}` }] };
        }
        case "pdf": {
          const target = filePath ? await expandAndResolve(filePath) : path.join(os.tmpdir(), `page_${Date.now()}.pdf`);
          await page.pdf({ path: target, format: "A4" });
          await auditLog("browser-manage", { action, target }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `PDF saved to ${target}` }] };
        }
        case "wait": {
          if (selector) await page.waitForSelector(selector);
          else await new Promise(r => setTimeout(r, 2000));
          await auditLog("browser-manage", { action, selector }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: "Wait complete." }] };
        }
        case "evaluate": {
          if (!script) throw new Error("Script required");
          const result = await page.evaluate(script);
          await auditLog("browser-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        }
        default:
          throw new Error(`Unsupported browser action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("browser-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Browser Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 8: net-manage ──────────────────────────────
   */
  server.registerTool("net-manage", {
    title: "Network & Research Manager",
    description: "HTTP requests, file downloads, web search, and port checks.",
    inputSchema: {
      action: z.enum(["http-request", "download", "web-search", "port-check"]).describe("Action to perform"),
      url: z.string().optional().describe("URL for request/download/search"),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("HTTP method"),
      headers: z.record(z.string()).optional().describe("HTTP headers"),
      body: z.any().optional().describe("Request body"),
      path: z.string().optional().describe("Path for download"),
      port: z.number().optional().describe("Port for check")
    }
  }, async ({ action, url, method = "GET", headers, body, path: filePath, port }) => {
    if (!ENABLE_NET) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Network tools disabled." }] };
    try {
      switch (action) {
        case "http-request": {
          if (!url) throw new Error("URL required");
          const res = await axios({ url, method, headers, data: body });
          await auditLog("net-manage", { action, url, method }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }] };
        }
        case "download": {
          if (!url || !filePath) throw new Error("URL and path required");
          const fullPath = await expandAndResolve(filePath);
          if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const res = await axios({ url, method: "GET", responseType: "arraybuffer" });
          await writeFile(fullPath, Buffer.from(res.data as any));
          return { content: [{ type: "text" as const, text: `Downloaded to ${filePath}` }] };
        }
        case "web-search": {
          if (!url) throw new Error("Search query (url) required");
          const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(url)}`;
          const { data } = await axios.get(searchUrl);
          const titles = ((data as string).match(/result__a">([^<]+)/g) || []).slice(0, 5).map((t: string) => t.replace('result__a">', ''));
          await auditLog("net-manage", { action, query: url }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Search results for "${url}":\n` + (titles.join("\n") || "No results found.") }] };
        }
        case "port-check": {
          const targetPort = port || 80;
          const { stdout } = await execPromise(`lsof -i :${targetPort} || echo "FREE"`);
          await auditLog("net-manage", { action, port: targetPort }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout.includes("FREE") ? `Port ${targetPort} is FREE` : `Port ${targetPort} is IN USE:\n${stdout}` }] };
        }
        default:
          throw new Error(`Unsupported net action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("net-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Net Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 9: task-manage ─────────────────────────────
   */
  server.registerTool("task-manage", {
    title: "Background Task Runner",
    description: "Run long shell commands as background jobs so the SSE connection stays alive. Poll status without blocking.",
    inputSchema: {
      action: z.enum(["run", "status", "logs", "cancel", "list"]).describe("Task operation"),
      command: z.string().optional().describe("Shell command to run in background (for 'run')"),
      taskId: z.string().optional().describe("Task ID (for status/logs/cancel)"),
      directory: z.string().optional().describe("Working directory (for 'run')")
    }
  }, async ({ action, command, taskId, directory }) => {
    try {
      switch (action) {
        case "run": {
          if (!ENABLE_RUN_COMMAND) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Exec disabled." }] };
          if (!command) throw new Error("Command required");
          const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];
          if (!(await isPathAllowed(targetDir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          for (const p of BLOCKED_COMMAND_PATTERNS) {
            if (p.test(command)) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Blocked pattern." }] };
          }
          if (!ALLOW_PACKAGE_INSTALLS && INSTALL_COMMAND_RE.test(command)) {
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: package installs are disabled (ALLOW_PACKAGE_INSTALLS=false)." }] };
          }
          const id = randomUUID();
          const task: BackgroundTask = { id, command, status: "running", stdout: "", stderr: "", exitCode: null, startedAt: Date.now() };
          backgroundTasks.set(id, task);
          const proc = spawn("bash", ["-c", command], { cwd: targetDir, detached: false });
          task.pid = proc.pid;
          proc.stdout.on("data", (d: Buffer) => { task.stdout += d.toString(); });
          proc.stderr.on("data", (d: Buffer) => { task.stderr += d.toString(); });
          proc.on("close", (code) => {
            task.status = code === 0 ? "completed" : "failed";
            task.exitCode = code;
            task.finishedAt = Date.now();
          });
          proc.on("error", (e) => { task.status = "failed"; task.stderr += e.message; task.finishedAt = Date.now(); });
          await auditLog("task-manage", { action, command }, "SUCCESS", sessionId, undefined, targetDir);
          return { content: [{ type: "text" as const, text: `Task started. ID: ${id}\nPID: ${task.pid}` }] };
        }
        case "status": {
          if (!taskId) throw new Error("taskId required");
          const t = backgroundTasks.get(taskId);
          if (!t) return { content: [{ type: "text" as const, text: `No task found with ID ${taskId}` }] };
          const elapsed = ((t.finishedAt ?? Date.now()) - t.startedAt) / 1000;
          return { content: [{ type: "text" as const, text: JSON.stringify({ id: t.id, status: t.status, exitCode: t.exitCode, elapsedSeconds: elapsed.toFixed(1), stdoutLines: t.stdout.split("\n").length, stderrLines: t.stderr.split("\n").length }, null, 2) }] };
        }
        case "logs": {
          if (!taskId) throw new Error("taskId required");
          const t = backgroundTasks.get(taskId);
          if (!t) return { content: [{ type: "text" as const, text: `No task found with ID ${taskId}` }] };
          return { content: [{ type: "text" as const, text: `STDOUT:\n${t.stdout || "(empty)"}\n\nSTDERR:\n${t.stderr || "(empty)"}` }] };
        }
        case "cancel": {
          if (!taskId) throw new Error("taskId required");
          const t = backgroundTasks.get(taskId);
          if (!t) return { content: [{ type: "text" as const, text: `No task found with ID ${taskId}` }] };
          if (t.pid) try { process.kill(t.pid, "SIGTERM"); } catch {}
          t.status = "cancelled";
          t.finishedAt = Date.now();
          return { content: [{ type: "text" as const, text: `Task ${taskId} cancelled.` }] };
        }
        case "list": {
          const tasks = Array.from(backgroundTasks.values()).map(t => ({
            id: t.id, status: t.status, command: t.command.slice(0, 80), pid: t.pid,
            elapsedSeconds: (((t.finishedAt ?? Date.now()) - t.startedAt) / 1000).toFixed(1)
          }));
          return { content: [{ type: "text" as const, text: tasks.length ? JSON.stringify(tasks, null, 2) : "No background tasks." }] };
        }
        default: throw new Error(`Unknown task action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("task-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Task Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 10: watch-manage ───────────────────────────
   */
  server.registerTool("watch-manage", {
    title: "Filesystem Watcher & Log Tailer",
    description: "Watch files/directories for changes. Poll accumulated events. Also tail log files.",
    inputSchema: {
      action: z.enum(["watch", "poll", "unwatch", "list-watchers", "tail-log"]).describe("Watch operation"),
      path: z.string().optional().describe("Path to watch or log file to tail"),
      watchId: z.string().optional().describe("Watcher ID (for poll/unwatch)"),
      lines: z.number().optional().describe("Lines to tail (for tail-log, default 50)")
    }
  }, async ({ action, path: filePath, watchId, lines = 50 }) => {
    try {
      switch (action) {
        case "watch": {
          if (!filePath) throw new Error("Path required");
          const fullPath = await expandAndResolve(filePath);
          if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const id = randomUUID();
          const events: FileWatcherEntry["events"] = [];
          const handle = fsWatch(fullPath, { recursive: true }, (eventType, filename) => {
            events.push({ type: eventType, filename, timestamp: Date.now() });
            if (events.length > 500) events.shift();
          });
          fileWatchers.set(id, { id, watchedPath: fullPath, events, handle });
          await auditLog("watch-manage", { action, path: filePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Watcher started. ID: ${id}\nWatching: ${fullPath}` }] };
        }
        case "poll": {
          if (!watchId) throw new Error("watchId required");
          const w = fileWatchers.get(watchId);
          if (!w) return { content: [{ type: "text" as const, text: `No watcher found with ID ${watchId}` }] };
          const snapshot = [...w.events];
          w.events.length = 0;
          return { content: [{ type: "text" as const, text: snapshot.length ? JSON.stringify(snapshot, null, 2) : "No new events." }] };
        }
        case "unwatch": {
          if (!watchId) throw new Error("watchId required");
          const w = fileWatchers.get(watchId);
          if (!w) return { content: [{ type: "text" as const, text: `No watcher found with ID ${watchId}` }] };
          w.handle.close();
          fileWatchers.delete(watchId);
          return { content: [{ type: "text" as const, text: `Watcher ${watchId} stopped.` }] };
        }
        case "list-watchers": {
          const list = Array.from(fileWatchers.values()).map(w => ({ id: w.id, path: w.watchedPath, bufferedEvents: w.events.length }));
          return { content: [{ type: "text" as const, text: list.length ? JSON.stringify(list, null, 2) : "No active watchers." }] };
        }
        case "tail-log": {
          if (!filePath) throw new Error("Path required");
          const fullPath = await expandAndResolve(filePath);
          if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const { stdout } = await execPromise(`tail -n ${lines} ${JSON.stringify(fullPath)}`);
          await auditLog("watch-manage", { action, path: filePath, lines }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout || "(file is empty)" }] };
        }
        default: throw new Error(`Unknown watch action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("watch-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Watch Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 11: secret-manage ─────────────────────────
   */
  server.registerTool("secret-manage", {
    title: "macOS Keychain Manager",
    description: "Read, write, and delete secrets from the macOS Keychain via the security CLI.",
    inputSchema: {
      action: z.enum(["get", "set", "delete", "list"]).describe("Keychain operation"),
      service: z.string().optional().describe("Keychain service name"),
      account: z.string().optional().describe("Keychain account name"),
      value: z.string().optional().describe("Secret value (for 'set')")
    }
  }, async ({ action, service, account, value }) => {
    try {
      switch (action) {
        case "get": {
          if (!service || !account) throw new Error("service and account required");
          const { stdout } = await execPromise(`security find-generic-password -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w`);
          await auditLog("secret-manage", { action, service, account }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout.trim() }] };
        }
        case "set": {
          if (!service || !account || value === undefined) throw new Error("service, account, and value required");
          await execPromise(`security add-generic-password -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w ${JSON.stringify(value)} -U`);
          await auditLog("secret-manage", { action, service, account }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Secret set for ${service}/${account}` }] };
        }
        case "delete": {
          if (!service || !account) throw new Error("service and account required");
          await execPromise(`security delete-generic-password -s ${JSON.stringify(service)} -a ${JSON.stringify(account)}`);
          await auditLog("secret-manage", { action, service, account }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Secret deleted: ${service}/${account}` }] };
        }
        case "list": {
          const { stdout } = await execPromise(`security dump-keychain | grep -E '"svce"|"acct"' | head -100`);
          await auditLog("secret-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout || "(no entries)" }] };
        }
        default: throw new Error(`Unknown secret action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("secret-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Secret Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 12: archive-manage ────────────────────────
   */
  server.registerTool("archive-manage", {
    title: "Archive Manager",
    description: "Create and extract zip/tar archives. List archive contents.",
    inputSchema: {
      action: z.enum(["zip", "unzip", "tar", "untar", "list-contents"]).describe("Archive operation"),
      source: z.string().optional().describe("Source path(s), comma-separated for zip/tar"),
      destination: z.string().optional().describe("Output archive or extraction directory"),
      path: z.string().optional().describe("Archive path (for unzip/untar/list-contents)")
    }
  }, async ({ action, source, destination, path: archivePath }) => {
    try {
      switch (action) {
        case "zip": {
          if (!source || !destination) throw new Error("source and destination required");
          const destFull = await expandAndResolve(destination);
          if (!(await isPathAllowed(destFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const sources = source.split(",").map(s => JSON.stringify(s.trim())).join(" ");
          await execPromise(`zip -r ${JSON.stringify(destFull)} ${sources}`);
          await auditLog("archive-manage", { action, source, destination }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Zipped to ${destFull}` }] };
        }
        case "unzip": {
          if (!archivePath || !destination) throw new Error("path and destination required");
          const archFull = await expandAndResolve(archivePath);
          const destFull = await expandAndResolve(destination);
          if (!(await isPathAllowed(archFull)) || !(await isPathAllowed(destFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          await mkdir(destFull, { recursive: true });
          const { stdout } = await execPromise(`unzip -o ${JSON.stringify(archFull)} -d ${JSON.stringify(destFull)}`);
          await auditLog("archive-manage", { action, path: archivePath, destination }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        case "tar": {
          if (!source || !destination) throw new Error("source and destination required");
          const destFull = await expandAndResolve(destination);
          if (!(await isPathAllowed(destFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const sources = source.split(",").map(s => JSON.stringify(s.trim())).join(" ");
          await execPromise(`tar czf ${JSON.stringify(destFull)} ${sources}`);
          await auditLog("archive-manage", { action, source, destination }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Tar created at ${destFull}` }] };
        }
        case "untar": {
          if (!archivePath || !destination) throw new Error("path and destination required");
          const archFull = await expandAndResolve(archivePath);
          const destFull = await expandAndResolve(destination);
          if (!(await isPathAllowed(archFull)) || !(await isPathAllowed(destFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          await mkdir(destFull, { recursive: true });
          const { stdout } = await execPromise(`tar xzf ${JSON.stringify(archFull)} -C ${JSON.stringify(destFull)}`);
          await auditLog("archive-manage", { action, path: archivePath, destination }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Extracted to ${destFull}` }] };
        }
        case "list-contents": {
          if (!archivePath) throw new Error("path required");
          const archFull = await expandAndResolve(archivePath);
          if (!(await isPathAllowed(archFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const isZip = archFull.endsWith(".zip");
          const { stdout } = await execPromise(isZip ? `unzip -l ${JSON.stringify(archFull)}` : `tar tzf ${JSON.stringify(archFull)}`);
          await auditLog("archive-manage", { action, path: archivePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        default: throw new Error(`Unknown archive action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("archive-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Archive Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 13: db-manage ──────────────────────────────
   */
  server.registerTool("db-manage", {
    title: "SQLite Database Manager",
    description: "Query and manage local SQLite databases.",
    inputSchema: {
      action: z.enum(["query", "execute", "schema", "list-tables"]).describe("Database operation"),
      path: z.string().describe("Path to SQLite database file"),
      sql: z.string().optional().describe("SQL statement"),
      params: z.array(z.any()).optional().describe("Query parameters")
    }
  }, async ({ action, path: dbPath, sql, params = [] }) => {
    if (!ENABLE_DB) return { content: [{ type: "text" as const, text: "ACCESS DENIED: DB tools disabled." }] };
    try {
      const fullPath = await expandAndResolve(dbPath);
      if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
      const db = new Database(fullPath, { readonly: action === "query" || action === "list-tables" || action === "schema" });
      try {
        switch (action) {
          case "query": {
            if (!sql) throw new Error("SQL required");
            const rows = db.prepare(sql).all(...params);
            await auditLog("db-manage", { action, path: dbPath, sql }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
          }
          case "execute": {
            if (!sql) throw new Error("SQL required");
            const info = db.prepare(sql).run(...params);
            await auditLog("db-manage", { action, path: dbPath, sql }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: `Rows affected: ${info.changes}\nLast insert rowid: ${info.lastInsertRowid}` }] };
          }
          case "schema": {
            const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as Array<{name:string;sql:string}>;
            await auditLog("db-manage", { action, path: dbPath }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: rows.map(r => r.sql).join(";\n\n") || "(no schema)" }] };
          }
          case "list-tables": {
            const rows = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name").all() as Array<{name:string;type:string}>;
            await auditLog("db-manage", { action, path: dbPath }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
          }
          default: throw new Error(`Unknown db action: ${action}`);
        }
      } finally {
        db.close();
      }
    } catch (e: any) {
      await auditLog("db-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `DB Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 14: diff-manage ────────────────────────────
   */
  server.registerTool("diff-manage", {
    title: "Diff & Patch Manager",
    description: "Compare files or directories, apply patches, and three-way merge.",
    inputSchema: {
      action: z.enum(["file-diff", "dir-diff", "apply-patch", "three-way-merge"]).describe("Diff operation"),
      pathA: z.string().optional().describe("First file/dir or 'mine' for three-way-merge"),
      pathB: z.string().optional().describe("Second file/dir or 'theirs' for three-way-merge"),
      base: z.string().optional().describe("Base file for three-way-merge"),
      patchFile: z.string().optional().describe("Patch file path (for apply-patch)"),
      targetDir: z.string().optional().describe("Directory to apply patch in")
    }
  }, async ({ action, pathA, pathB, base, patchFile, targetDir }) => {
    try {
      switch (action) {
        case "file-diff": {
          if (!pathA || !pathB) throw new Error("pathA and pathB required");
          const a = await expandAndResolve(pathA);
          const b = await expandAndResolve(pathB);
          if (!(await isPathAllowed(a)) || !(await isPathAllowed(b))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const { stdout } = await execPromise(`diff -u ${JSON.stringify(a)} ${JSON.stringify(b)} || true`);
          await auditLog("diff-manage", { action, pathA, pathB }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout || "Files are identical." }] };
        }
        case "dir-diff": {
          if (!pathA || !pathB) throw new Error("pathA and pathB required");
          const a = await expandAndResolve(pathA);
          const b = await expandAndResolve(pathB);
          if (!(await isPathAllowed(a)) || !(await isPathAllowed(b))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const { stdout } = await execPromise(`diff -rq ${JSON.stringify(a)} ${JSON.stringify(b)} || true`);
          await auditLog("diff-manage", { action, pathA, pathB }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout || "Directories are identical." }] };
        }
        case "apply-patch": {
          if (!patchFile) throw new Error("patchFile required");
          const patchFull = await expandAndResolve(patchFile);
          const dir = targetDir ? await expandAndResolve(targetDir) : ALLOWED_DIRS[0];
          if (!(await isPathAllowed(patchFull)) || !(await isPathAllowed(dir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const { stdout, stderr } = await execPromise(`patch -p1 < ${JSON.stringify(patchFull)}`, { cwd: dir });
          await auditLog("diff-manage", { action, patchFile }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `${stdout}\n${stderr}`.trim() }] };
        }
        case "three-way-merge": {
          if (!pathA || !pathB || !base) throw new Error("pathA (mine), pathB (theirs), and base required");
          const mine = await expandAndResolve(pathA);
          const theirs = await expandAndResolve(pathB);
          const baseFull = await expandAndResolve(base);
          if (!(await isPathAllowed(mine)) || !(await isPathAllowed(theirs)) || !(await isPathAllowed(baseFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const { stdout } = await execPromise(`diff3 ${JSON.stringify(mine)} ${JSON.stringify(baseFull)} ${JSON.stringify(theirs)} || true`);
          await auditLog("diff-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout || "No conflicts." }] };
        }
        default: throw new Error(`Unknown diff action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("diff-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Diff Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 15: code-format ────────────────────────────
   */
  server.registerTool("code-format", {
    title: "Code Formatter",
    description: "Format source files with prettier, black, gofmt, rustfmt, etc. Auto-detects from extension.",
    inputSchema: {
      action: z.enum(["format", "check", "list-formatters"]).describe("Format operation"),
      path: z.string().optional().describe("File to format"),
      formatter: z.string().optional().describe("Override formatter (e.g. prettier, black, gofmt)")
    }
  }, async ({ action, path: filePath, formatter }) => {
    if (!ENABLE_RUN_COMMAND) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Exec disabled." }] };
    try {
      if (action === "list-formatters") {
        const formatters = ["prettier", "black", "gofmt", "rustfmt", "clang-format", "shfmt"];
        const available: string[] = [];
        for (const f of formatters) {
          try { await execPromise(`which ${f}`); available.push(f); } catch {}
        }
        return { content: [{ type: "text" as const, text: `Available formatters:\n${available.join("\n") || "(none found)"}` }] };
      }

      if (!filePath) throw new Error("path required");
      const fullPath = await expandAndResolve(filePath);
      if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };

      const ext = path.extname(fullPath).toLowerCase();
      const detected = formatter || (() => {
        if ([".js", ".ts", ".jsx", ".tsx", ".json", ".css", ".md", ".html"].includes(ext)) return "prettier";
        if ([".py"].includes(ext)) return "black";
        if ([".go"].includes(ext)) return "gofmt";
        if ([".rs"].includes(ext)) return "rustfmt";
        if ([".c", ".cpp", ".h"].includes(ext)) return "clang-format";
        if ([".sh"].includes(ext)) return "shfmt";
        return null;
      })();

      if (!detected) return { content: [{ type: "text" as const, text: `No formatter found for extension '${ext}'. Use the 'formatter' param to specify one.` }] };

      let cmd: string;
      if (action === "check") {
        cmd = detected === "prettier" ? `prettier --check ${JSON.stringify(fullPath)}`
          : detected === "black" ? `black --check ${JSON.stringify(fullPath)}`
          : detected === "gofmt" ? `gofmt -l ${JSON.stringify(fullPath)}`
          : `${detected} --check ${JSON.stringify(fullPath)}`;
      } else {
        cmd = detected === "prettier" ? `prettier --write ${JSON.stringify(fullPath)}`
          : detected === "black" ? `black ${JSON.stringify(fullPath)}`
          : detected === "gofmt" ? `gofmt -w ${JSON.stringify(fullPath)}`
          : detected === "rustfmt" ? `rustfmt ${JSON.stringify(fullPath)}`
          : `${detected} -i ${JSON.stringify(fullPath)}`;
      }

      const { stdout, stderr } = await execPromise(cmd);
      await auditLog("code-format", { action, path: filePath, formatter: detected }, "SUCCESS", sessionId);
      return { content: [{ type: "text" as const, text: `${stdout}\n${stderr}`.trim() || (action === "check" ? "File is correctly formatted." : "Formatted successfully.") }] };
    } catch (e: any) {
      await auditLog("code-format", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Format Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 16: test-manage ────────────────────────────
   */
  server.registerTool("test-manage", {
    title: "Structured Test Runner",
    description: "Run test suites and return structured pass/fail data instead of raw terminal output.",
    inputSchema: {
      action: z.enum(["run", "run-file", "coverage"]).describe("Test operation"),
      path: z.string().optional().describe("Test file (for run-file)"),
      directory: z.string().optional().describe("Project directory"),
      runner: z.enum(["jest", "vitest", "pytest", "go", "cargo"]).optional().describe("Override test runner")
    }
  }, async ({ action, path: testFile, directory, runner }) => {
    if (!ENABLE_RUN_COMMAND) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Exec disabled." }] };
    try {
      const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];
      if (!(await isPathAllowed(targetDir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };

      // Detect runner from project files
      const detected = runner || await (async () => {
        try { await stat(path.join(targetDir, "package.json"));
          const pkg = JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf-8"));
          if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) return "vitest";
          return "jest";
        } catch {}
        try { await stat(path.join(targetDir, "pytest.ini")); return "pytest"; } catch {}
        try { await stat(path.join(targetDir, "go.mod")); return "go"; } catch {}
        try { await stat(path.join(targetDir, "Cargo.toml")); return "cargo"; } catch {}
        return "jest";
      })();

      let cmd: string;
      const writeEvent = activeSessions.get(sessionId)?.writeEvent;
      switch (detected) {
        case "jest":
          cmd = action === "coverage" ? "npx jest --coverage --json 2>/dev/null || true"
            : action === "run-file" ? `npx jest ${JSON.stringify(testFile)} --json 2>/dev/null || true`
            : "npx jest --json 2>/dev/null || true";
          break;
        case "vitest":
          cmd = action === "coverage" ? "npx vitest run --coverage 2>&1 || true"
            : action === "run-file" ? `npx vitest run ${JSON.stringify(testFile)} 2>&1 || true`
            : "npx vitest run 2>&1 || true";
          break;
        case "pytest":
          cmd = action === "coverage" ? "python -m pytest --tb=short -q --co 2>&1 || true"
            : action === "run-file" ? `python -m pytest ${JSON.stringify(testFile)} -v 2>&1 || true`
            : "python -m pytest -v 2>&1 || true";
          break;
        case "go":
          cmd = action === "coverage" ? "go test ./... -cover 2>&1 || true"
            : "go test ./... -v 2>&1 || true";
          break;
        case "cargo":
          cmd = "cargo test 2>&1 || true";
          break;
        default:
          cmd = "npm test 2>&1 || true";
      }

      writeEvent?.(`test: Running ${detected} tests...`);
      const { stdout, stderr } = await execPromise(cmd, { cwd: targetDir, timeout: 120000 });
      const raw = `${stdout}\n${stderr}`.trim();

      // Try to parse Jest JSON for structured output
      let structured: string = raw;
      if ((detected === "jest") && action !== "coverage") {
        try {
          const jsonStart = raw.indexOf("{");
          if (jsonStart >= 0) {
            const parsed = JSON.parse(raw.slice(jsonStart));
            const summary = {
              passed: parsed.numPassedTests, failed: parsed.numFailedTests,
              skipped: parsed.numPendingTests, total: parsed.numTotalTests,
              duration: parsed.testResults?.reduce((a: number, r: any) => a + (r.endTime - r.startTime), 0),
              failedTests: parsed.testResults?.flatMap((r: any) => r.testResults?.filter((t: any) => t.status === "failed").map((t: any) => ({ name: t.fullName, message: t.failureMessages?.join("\n").slice(0, 300) }))) ?? []
            };
            structured = JSON.stringify(summary, null, 2);
          }
        } catch {}
      }

      await auditLog("test-manage", { action, runner: detected }, "SUCCESS", sessionId, undefined, targetDir);
      return { content: [{ type: "text" as const, text: structured }] };
    } catch (e: any) {
      await auditLog("test-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Test Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 17: audit-manage ───────────────────────────
   */
  server.registerTool("audit-manage", {
    title: "Audit Log Explorer",
    description: "Query and analyse the MCP server's own audit.log — tail entries, search by tool/status/session, or get stats.",
    inputSchema: {
      action: z.enum(["tail", "search", "stats", "session-history"]).describe("Audit operation"),
      count: z.number().optional().describe("Number of entries to tail (default 50)"),
      tool: z.string().optional().describe("Filter by tool name"),
      status: z.enum(["SUCCESS", "BLOCKED", "ERROR"]).optional().describe("Filter by status"),
      sessionId: z.string().optional().describe("Session ID to filter by (for session-history)")
    }
  }, async ({ action, count = 50, tool: filterTool, status: filterStatus, sessionId: filterSession }) => {
    try {
      const logPath = path.join(__dirname, "../audit.log");
      let raw: string;
      try { raw = await readFile(logPath, "utf-8"); } catch { return { content: [{ type: "text" as const, text: "audit.log not found or empty." }] }; }

      const entries = raw.trim().split("\n").filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);

      switch (action) {
        case "tail": {
          const slice = entries.slice(-count);
          return { content: [{ type: "text" as const, text: JSON.stringify(slice, null, 2) }] };
        }
        case "search": {
          let results = entries;
          if (filterTool) results = results.filter((e: any) => e.tool === filterTool);
          if (filterStatus) results = results.filter((e: any) => e.status === filterStatus);
          return { content: [{ type: "text" as const, text: JSON.stringify(results.slice(-200), null, 2) }] };
        }
        case "stats": {
          const byTool: Record<string, number> = {};
          const byStatus: Record<string, number> = {};
          for (const e of entries as any[]) {
            byTool[e.tool] = (byTool[e.tool] || 0) + 1;
            byStatus[e.status] = (byStatus[e.status] || 0) + 1;
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ totalEntries: entries.length, byTool, byStatus }, null, 2) }] };
        }
        case "session-history": {
          const sid = filterSession || sessionId;
          const results = (entries as any[]).filter(e => e.session === sid);
          return { content: [{ type: "text" as const, text: results.length ? JSON.stringify(results, null, 2) : `No entries for session ${sid}` }] };
        }
        default: throw new Error(`Unknown audit action: ${action}`);
      }
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Audit Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 18: env-manage ─────────────────────────────
   */
  server.registerTool("env-manage", {
    title: "Environment File Manager",
    description: "Safely read, write, and validate .env files with proper parsing and masked audit logging.",
    inputSchema: {
      action: z.enum(["read", "set", "unset", "validate", "diff"]).describe("Env operation"),
      path: z.string().optional().describe(".env file path (default: ALLOWED_DIRS[0]/.env)"),
      key: z.string().optional().describe("Key to set/unset"),
      value: z.string().optional().describe("Value to set"),
      requiredKeys: z.array(z.string()).optional().describe("Keys to check exist (for validate)"),
      pathB: z.string().optional().describe("Second .env file for diff")
    }
  }, async ({ action, path: envPath, key, value, requiredKeys, pathB }) => {
    try {
      const defaultEnvPath = path.join(ALLOWED_DIRS[0], ".env");
      const fullPath = envPath ? await expandAndResolve(envPath) : defaultEnvPath;
      if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };

      const parseEnv = (raw: string): Record<string, string> => {
        const result: Record<string, string> = {};
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx < 0) continue;
          const k = trimmed.slice(0, eqIdx).trim();
          const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          result[k] = v;
        }
        return result;
      };

      const serializeEnv = (obj: Record<string, string>): string =>
        Object.entries(obj).map(([k, v]) => `${k}=${v.includes(" ") ? `"${v}"` : v}`).join("\n") + "\n";

      switch (action) {
        case "read": {
          let raw: string;
          try { raw = await readFile(fullPath, "utf-8"); } catch { return { content: [{ type: "text" as const, text: `No .env file found at ${fullPath}` }] }; }
          const parsed = parseEnv(raw);
          const masked = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v.length > 4 ? `${v.slice(0, 2)}${"*".repeat(v.length - 2)}` : "***"]));
          await auditLog("env-manage", { action, path: envPath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(masked, null, 2) }] };
        }
        case "set": {
          if (!ENABLE_WRITE_EDIT) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          if (!key) throw new Error("key required");
          let raw = "";
          try { raw = await readFile(fullPath, "utf-8"); } catch {}
          const parsed = parseEnv(raw);
          parsed[key] = value ?? "";
          await writeFile(fullPath, serializeEnv(parsed));
          await auditLog("env-manage", { action, path: envPath, key }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Set ${key} in ${fullPath}` }] };
        }
        case "unset": {
          if (!ENABLE_WRITE_EDIT) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          if (!key) throw new Error("key required");
          let raw = "";
          try { raw = await readFile(fullPath, "utf-8"); } catch {}
          const parsed = parseEnv(raw);
          delete parsed[key];
          await writeFile(fullPath, serializeEnv(parsed));
          await auditLog("env-manage", { action, path: envPath, key }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Removed ${key} from ${fullPath}` }] };
        }
        case "validate": {
          if (!requiredKeys?.length) throw new Error("requiredKeys array required");
          let raw = "";
          try { raw = await readFile(fullPath, "utf-8"); } catch {}
          const parsed = parseEnv(raw);
          const missing = requiredKeys.filter(k => !(k in parsed) || !parsed[k]);
          return { content: [{ type: "text" as const, text: missing.length ? `Missing or empty keys: ${missing.join(", ")}` : "All required keys are present." }] };
        }
        case "diff": {
          if (!pathB) throw new Error("pathB required for diff");
          const fullB = await expandAndResolve(pathB);
          if (!(await isPathAllowed(fullB))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          let rawA = "", rawB = "";
          try { rawA = await readFile(fullPath, "utf-8"); } catch {}
          try { rawB = await readFile(fullB, "utf-8"); } catch {}
          const a = parseEnv(rawA);
          const b = parseEnv(rawB);
          const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
          const diffs: string[] = [];
          for (const k of allKeys) {
            if (!(k in a)) diffs.push(`+ ${k} (only in B)`);
            else if (!(k in b)) diffs.push(`- ${k} (only in A)`);
            else if (a[k] !== b[k]) diffs.push(`~ ${k} (values differ)`);
          }
          return { content: [{ type: "text" as const, text: diffs.length ? diffs.join("\n") : "Files are identical." }] };
        }
        default: throw new Error(`Unknown env action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("env-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Env Error: ${e.message}` }] };
    }
  });

  /**
   * ── Master Tool 19: window-manage ──────────────────────────
   */
  server.registerTool("window-manage", {
    title: "macOS Window Controller",
    description: "List, focus, resize, move windows and run AppleScript. Extends sys-manage with window-level control.",
    inputSchema: {
      action: z.enum(["list", "focus", "resize", "move", "screenshot-window", "applescript"]).describe("Window operation"),
      app: z.string().optional().describe("App name (for focus/resize/move)"),
      width: z.number().optional().describe("Width pixels (for resize)"),
      height: z.number().optional().describe("Height pixels (for resize)"),
      x: z.number().optional().describe("X position (for move)"),
      y: z.number().optional().describe("Y position (for move)"),
      script: z.string().optional().describe("AppleScript source (for applescript)"),
      path: z.string().optional().describe("Output path (for screenshot-window)")
    }
  }, async ({ action, app, width, height, x, y, script, path: filePath }) => {
    try {
      switch (action) {
        case "list": {
          const { stdout } = await execPromise(`osascript -e 'tell application "System Events" to get {name, title} of every window of every process whose visible is true'`);
          await auditLog("window-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout.trim() }] };
        }
        case "focus": {
          if (!app) throw new Error("app required");
          await execPromise(`osascript -e 'tell application ${JSON.stringify(app)} to activate'`);
          await auditLog("window-manage", { action, app }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Focused ${app}` }] };
        }
        case "resize": {
          if (!app || !width || !height) throw new Error("app, width, height required");
          const scpt = `tell application ${JSON.stringify(app)} to set bounds of front window to {0, 0, ${width}, ${height}}`;
          await execPromise(`osascript -e '${scpt}'`);
          await auditLog("window-manage", { action, app, width, height }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Resized ${app} to ${width}x${height}` }] };
        }
        case "move": {
          if (!app || x === undefined || y === undefined) throw new Error("app, x, y required");
          const scpt = `tell application ${JSON.stringify(app)} to set position of front window to {${x}, ${y}}`;
          await execPromise(`osascript -e '${scpt}'`);
          await auditLog("window-manage", { action, app, x, y }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Moved ${app} window to (${x}, ${y})` }] };
        }
        case "screenshot-window": {
          if (!app) throw new Error("app required");
          const target = filePath ? await expandAndResolve(filePath) : path.join(os.tmpdir(), `window_${Date.now()}.png`);
          await execPromise(`screencapture -l$(osascript -e 'tell application ${JSON.stringify(app)} to id of front window') ${JSON.stringify(target)} 2>/dev/null || screencapture ${JSON.stringify(target)}`);
          await auditLog("window-manage", { action, app }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Screenshot saved to ${target}` }] };
        }
        case "applescript": {
          if (!script) throw new Error("script required");
          const { stdout } = await execPromise(`osascript -e ${JSON.stringify(script)}`);
          await auditLog("window-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout.trim() || "[Done]" }] };
        }
        default: throw new Error(`Unknown window action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("window-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Window Error: ${e.message}` }] };
    }
  });

  /**
   * ── Bridge Tool 1: start ───────────────────────────────────
   */
  server.registerTool("start", {
    title: "Bridge: Start Build Job",
    description: "Dispatch a build job to a local coding-agent CLI. Creates an isolated git worktree on branch job/<jobId> (or the given branch), runs the agent asynchronously, and returns immediately. On success the branch is committed, pushed, and a PR/compare URL is recorded (state: in_review). Structured returns: alreadyRunning (idempotent on jobId), queued (capacity full — dispatched FIFO as slots free), invalidRepo, awaiting_input (directory has no git repo — reply via `answer` to authorize `git init`). Re-calling for a failed/in_review job re-runs on the same branch/worktree with the new prompt.",
    inputSchema: {
      jobId: z.string().describe("Opaque caller-supplied id — the idempotency/dedup key; also derives branch job/<jobId>"),
      repoPath: z.string().describe("Absolute path to the target directory (must be inside ALLOWED_DIRS)"),
      prompt: z.string().describe("Natural-language work description passed to the coding agent"),
      agent: z.string().optional().describe(`Local agent from providers.json (default: ${DEFAULT_PROVIDER})`),
      mode: z.enum(["auto", "accept_edits"]).optional().describe(`Execution posture: auto = full autonomy (skip-permissions), accept_edits = supervised (edits auto-apply; shell/installs/deletes pause → awaiting_input → answer). Default: ${DEFAULT_MODE}`),
      verifyCommand: z.string().optional().describe("Shell command run in the worktree after the agent finishes; non-zero exit fails the job. Falls back to the repo's .bridge.json verifyCommand, then skips."),
      branch: z.string().optional().describe("Branch to work on (default: job/<jobId>)")
    }
  }, async (params) => {
    try {
      const result = await bridge.startTask(params);
      await auditLog("start", { jobId: params.jobId, agent: params.agent }, "SUCCESS", sessionId, undefined, params.repoPath);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      await auditLog("start", { jobId: params.jobId }, "ERROR", sessionId, e.message, params.repoPath);
      return { content: [{ type: "text" as const, text: `Start Error: ${e.message}` }] };
    }
  });

  /**
   * ── Bridge Tool 2: plan ────────────────────────────────────
   */
  server.registerTool("plan", {
    title: "Bridge: Plan Job",
    description: "Dispatch a READ-ONLY plan job — no branch, no worktree, no writes — and return IMMEDIATELY ({started:true}). Never blocks on a slow plan. Poll get_status: 'planning' → still running; 'planned' → result in the `plan` field (+ needsInput/question when the agent asked something). If the chosen agent has no plan mode, the plan runs via PLAN_FALLBACK_AGENT (read-only) while the chosen agent stays the build agent — the plan text says who planned it. Structured returns: alreadyPlanning, queued, invalidRepo, planUnsupported (planSupported:false only when neither the agent nor a valid fallback can plan).",
    inputSchema: {
      jobId: z.string().describe("Opaque caller-supplied id — the idempotency/dedup key"),
      repoPath: z.string().describe("Absolute path to the target directory (must be inside ALLOWED_DIRS)"),
      prompt: z.string().describe("What to plan"),
      agent: z.string().optional().describe(`Local agent from providers.json (default: ${DEFAULT_PROVIDER})`),
      complex: z.boolean().optional().describe("Skip the cheap one-shot pass and go straight to an interactive plan session when the agent supports one")
    }
  }, async (params) => {
    try {
      const result = await bridge.planTask(params);
      await auditLog("plan", { jobId: params.jobId, agent: params.agent }, result.error ? "BLOCKED" : "SUCCESS", sessionId, result.error, params.repoPath);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      await auditLog("plan", { jobId: params.jobId }, "ERROR", sessionId, e.message, params.repoPath);
      return { content: [{ type: "text" as const, text: `Plan Error: ${e.message}` }] };
    }
  });

  /**
   * ── Bridge Tool 3: get_status ──────────────────────────────
   */
  server.registerTool("get_status", {
    title: "Bridge: Job Status",
    description: "Durable job state, always as an ARRAY. With jobId: one entry with full detail including a log excerpt. Without: the 50 most recent jobs. States: planning | planned | queued | running | awaiting_input (see `question`) | paused (see `pausedReason`: quota auto-retries; session/blocked need a human) | in_review (see prUrl/branchUrl/diffStat) | failed | merged | cancelled. Survives bridge restarts.",
    inputSchema: {
      jobId: z.string().optional().describe("Job id; omit to list recent jobs")
    }
  }, async ({ jobId }) => {
    try {
      const result = await bridge.getJobStatus(jobId);
      const arr = Array.isArray(result?.jobs) ? result.jobs : [result];
      await auditLog("get_status", { jobId }, "SUCCESS", sessionId);
      return { content: [{ type: "text" as const, text: JSON.stringify(arr, null, 2) }] };
    } catch (e: any) {
      await auditLog("get_status", { jobId }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Status Error: ${e.message}` }] };
    }
  });

  /**
   * ── Bridge Tool 4: answer ──────────────────────────────────
   */
  server.registerTool("answer", {
    title: "Bridge: Answer Job Question",
    description: "Relay a reply into a job in awaiting_input. A live interactive session gets the answer written into its pty; a dead session (or headless question, or a pending git-init authorization) re-runs cleanly with the answer applied. Loop until planned/in_review.",
    inputSchema: {
      jobId: z.string().describe("Job id of the waiting job"),
      answer: z.string().describe("The reply to the job's `question`")
    }
  }, async ({ jobId, answer }) => {
    try {
      const result = await bridge.answerTask(jobId, answer);
      await auditLog("answer", { jobId }, result.accepted ? "SUCCESS" : "BLOCKED", sessionId, result.error ?? result.message);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      await auditLog("answer", { jobId }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Answer Error: ${e.message}` }] };
    }
  });

  /**
   * ── Bridge Tool 5: cancel ──────────────────────────────────
   */
  server.registerTool("cancel", {
    title: "Bridge: Cancel Job",
    description: "Cancel a running/queued/waiting job: kills the agent process, removes the worktree, KEEPS the branch. Re-dispatching later with `start` resumes on the same branch.",
    inputSchema: {
      jobId: z.string().describe("Job id to cancel")
    }
  }, async ({ jobId }) => {
    try {
      const result = await bridge.cancelTask(jobId);
      await auditLog("cancel", { jobId }, result.cancelled ? "SUCCESS" : "BLOCKED", sessionId, result.error ?? result.message);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      await auditLog("cancel", { jobId }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Cancel Error: ${e.message}` }] };
    }
  });

  /**
   * ── Bridge Tool 6: merge ───────────────────────────────────
   */
  server.registerTool("merge", {
    title: "Bridge: Merge Job",
    description: "Merge a reviewed job into the default branch with --no-ff and push. Refuses unless the job is in_review and the repo's working tree is clean. The branch is KEPT for the revert window; the worktree is removed. On conflict returns {merged:false, conflict:true} with everything intact. action:'revert' reverts a merged job's merge commit within the revert window (operator use).",
    inputSchema: {
      jobId: z.string().describe("Job id to merge"),
      action: z.enum(["merge", "revert"]).optional().describe("Default: merge")
    }
  }, async ({ jobId, action }) => {
    try {
      const result = await bridge.mergeTask(jobId, action ?? "merge");
      const status = result.merged || result.reverted ? "SUCCESS" : "BLOCKED";
      await auditLog("merge", { jobId, action: action ?? "merge" }, status, sessionId, result.error ?? result.message);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      await auditLog("merge", { jobId, action: action ?? "merge" }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Merge Error: ${e.message}` }] };
    }
  });

  /**
   * ── MCP Prompts ──────────────────────────────────────────
   */
  server.registerPrompt("check-codebase", {
    title: "Check Codebase",
    description: "Perform a high-level audit of the codebase structure and identity major components."
  }, async () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Please use fs-manage/tree and fs-search/regex-search to audit this codebase. Identify the main entry points, configuration files, and core logic modules." }
      }
    ]
  }));

  server.registerPrompt("security-review", {
    title: "Security Review",
    description: "Scan the codebase for potential security vulnerabilities like hardcoded secrets or shell injection risks."
  }, async () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Perform a security review. Search for 'exec(', 'process.env', 'apiKey', 'password', and 'token'. Check if inputs are sanitized before being passed to shell commands." }
      }
    ]
  }));

  return server;
}

// ── Transport Layer (HTTP/SSE) ──────────────────────────────
const app = express();
app.set("trust proxy", 1);

// CORS lockdown: honour CORS_ORIGINS allowlist; fall back to permissive only when unset
app.use(cors({
  origin: CORS_ORIGINS.length > 0
    ? (origin, cb) => { if (!origin || CORS_ORIGINS.includes(origin)) cb(null, true); else cb(new Error("CORS: origin not allowed")); }
    : true,
  credentials: true,
}));

// Rate limiting — protects against request flooding (DoS)
app.use(rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.url === "/health" || req.url === "/status",
}));

let totalRequests = 0;
app.use((req, _res, next) => { if (req.method === "POST") totalRequests++; next(); });

// P0: Health endpoint for monitoring & keep-alive
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const authenticate = (req: Request, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS" || req.method === "HEAD") return next();
  if (req.url === "/health" || req.url.startsWith("/.well-known/")) return next();
  if (!MCP_TOKEN) return next();

  const authHeader = req.headers.authorization;
  const providedToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : req.query.token as string;

  if (providedToken === MCP_TOKEN.trim()) return next();
  res.status(401).json({ error: "Unauthorized" });
};

interface ActiveSession {
  transport: SSEServerTransport;
  server: McpServer;
  createdAt: number;
  lastActivity: number;
  resumeToken: string;
  page: puppeteer.Page | null;
  writeEvent: (msg: string) => void;
}
const activeSessions = new Map<string, ActiveSession>();
// Secondary index for fast resume-token lookup
const sessionsByResumeToken = new Map<string, string>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions) {
    const idleTooLong = now - session.lastActivity > SESSION_IDLE_TTL_MS;
    const exceededMaxAge = now - session.createdAt > SESSION_MAX_TTL_MS;
    if (idleTooLong || exceededMaxAge) {
      if (session.page) session.page.close().catch(() => {});
      sessionsByResumeToken.delete(session.resumeToken);
      activeSessions.delete(id);
      session.server.close().catch(() => {});
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

const SERVER_START_TIME = Date.now();

app.get("/status", (_req, res) => res.json({
  status: "running",
  uptimeSeconds: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
  activeSessions: activeSessions.size,
  backgroundTasks: { total: backgroundTasks.size, running: Array.from(backgroundTasks.values()).filter(t => t.status === "running").length },
  bridgeJobs: bridge.summary(),
  bridgeOps: bridge.ops(),
  usableProviders: bridge.listUsableProviders(),
  activeWatchers: fileWatchers.size,
  totalToolCalls: totalRequests,
  rateLimitWindow: RATE_LIMIT_WINDOW_MS,
  rateLimitMax: RATE_LIMIT_MAX,
  sessionIdleTtlMs: SESSION_IDLE_TTL_MS,
  sessionMaxTtlMs: SESSION_MAX_TTL_MS,
}));

const sseHandler = async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Session resumption: if a valid resumeToken is supplied, reattach to that session's
  // page/state instead of starting from scratch. The SSE transport itself is always new
  // (HTTP doesn't allow reusing the old response stream), but the Puppeteer page persists.
  const incomingResumeToken = req.query.resumeToken as string | undefined;
  let resumedPage: puppeteer.Page | null = null;
  if (incomingResumeToken) {
    const existingId = sessionsByResumeToken.get(incomingResumeToken);
    if (existingId) {
      const existingSession = activeSessions.get(existingId);
      if (existingSession) {
        resumedPage = existingSession.page;
        // Cleanly detach old session without closing its browser page
        existingSession.page = null;
        sessionsByResumeToken.delete(incomingResumeToken);
        activeSessions.delete(existingId);
        existingSession.server.close().catch(() => {});
      }
    }
  }

  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer(transport.sessionId);
  const resumeToken = randomUUID();
  const now = Date.now();

  const writeEvent = (msg: string) => {
    try { res.write(`: ${msg}\n\n`); } catch { /* connection already gone */ }
  };

  activeSessions.set(transport.sessionId, {
    transport,
    server,
    createdAt: now,
    lastActivity: now,
    resumeToken,
    page: resumedPage,
    writeEvent,
  });
  sessionsByResumeToken.set(resumeToken, transport.sessionId);

  res.setHeader("X-Session-Resume-Token", resumeToken);
  res.setHeader("X-Session-Id", transport.sessionId);

  let keepAlive: ReturnType<typeof setInterval>;

  const cleanup = async () => {
    clearInterval(keepAlive);
    const session = activeSessions.get(transport.sessionId);
    if (session?.page) await session.page.close().catch(() => {});
    sessionsByResumeToken.delete(resumeToken);
    activeSessions.delete(transport.sessionId);
    await server.close().catch(() => {});
  };

  res.on("close", cleanup);

  keepAlive = setInterval(() => {
    try {
      const ok = res.write(': heartbeat\n\n');
      // If the write is buffered (backpressure), the stream is likely stalled; clean up
      if (!ok) {
        res.destroy();
      }
    } catch {
      cleanup();
    }
  }, 10000);

  await server.connect(transport);
};

// Kill switch middleware — blocks ALL tool calls when ~/.mcp_kill exists
const killSwitchGuard = async (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  if (req.url === '/health') return next();
  if (await isKillSwitchActive()) {
    await auditLog('KILL_SWITCH', { url: req.url }, 'BLOCKED');
    return res.status(503).json({ error: 'KillSwitchActive', message: 'Emergency kill switch is active. Remove ~/.mcp_kill to resume.' });
  }
  next();
};

app.get(["/", "/sse", "/message", "/messages"], authenticate, killSwitchGuard, sseHandler);
app.use('/messages', killSwitchGuard);

app.post(["/messages", "/message", "/sse", "/"], authenticate, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) return res.status(405).send("Method Not Allowed");

  const session = activeSessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Unknown session" });

  // Reset idle TTL on every tool call
  session.lastActivity = Date.now();

  try {
    await session.transport.handlePostMessage(req, res);
    // Fire-and-forget webhook notification after each tool call
    if (WEBHOOK_URL) {
      const tool = (req.body as any)?.params?.name ?? "unknown";
      const action = (req.body as any)?.params?.arguments?.action ?? "";
      sendWebhook(tool, action, "completed").catch(() => {});
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: "Handling error" });
  }
});

export function startServer() {
  return new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(PORT, "0.0.0.0", () => {
      console.error(`🚀 Computer Access MCP started on http://localhost:${PORT}`);
      resolve();
    }).on('error', reject);

    async function gracefulShutdown(signal: string) {
      for (const [id, session] of activeSessions) {
        if (session.page) { try { await session.page.close(); } catch {} }
        try { await session.server.close(); } catch { }
      }
      if (browser) await browser.close();
      httpServer.close(() => process.exit(0));
    }
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(() => process.exit(1));
}
