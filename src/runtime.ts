// ── Shared runtime state & helpers ──────────────────────────
// Mutable singletons and cross-tool helpers live here so that both the
// per-tool modules and the transport layer share one instance.
import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdir, stat } from "fs/promises";
import { watch as fsWatch } from "fs";
import path from "path";
import puppeteer from "puppeteer";
import axios from "axios";
import { execFileP } from "./exec.js";
import { KILL_SWITCH_PATH, WEBHOOK_URL } from "./config.js";

// ── Kill switch ─────────────────────────────────────────────
export async function isKillSwitchActive(): Promise<boolean> {
  try { await stat(KILL_SWITCH_PATH); return true; } catch { return false; }
}

// ── Directory tree (depth-capped, symlink-safe) ─────────────
const MAX_TREE_DEPTH = 25;
export async function getDirectoryTree(dirPath: string, excludes: string[] = [], depth = 0): Promise<any> {
  const name = path.basename(dirPath);
  const item: any = { name, type: "directory", children: [] };
  if (depth >= MAX_TREE_DEPTH) { item.truncated = true; return item; }
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (excludes.some(pattern => entry.name.includes(pattern))) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      item.children.push({ name: entry.name, type: "symlink" });
    } else if (entry.isDirectory()) {
      item.children.push(await getDirectoryTree(fullPath, excludes, depth + 1));
    } else {
      item.children.push({ name: entry.name, type: "file" });
    }
  }
  return item;
}

// Run a search binary, treating a clean "no match" (exit 1) as empty output.
export async function runSearch(file: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP(file, args, { cwd });
    return stdout;
  } catch (e: any) {
    if (e.code === 1) return "";
    throw e;
  }
}

// ── Browser singleton (with crash recovery) ─────────────────
let browser: puppeteer.Browser | null = null;
let isRgInstalled: boolean | null = null;

export async function checkRg(): Promise<boolean> {
  if (isRgInstalled !== null) return isRgInstalled;
  try { await execFileP("rg", ["--version"]); isRgInstalled = true; }
  catch { isRgInstalled = false; }
  return isRgInstalled;
}

export async function getBrowser(): Promise<puppeteer.Browser> {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({ headless: true });
    browser.on("disconnected", () => { browser = null; });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } browser = null; }
}

// ── Background tasks ─────────────────────────────────────────
const MAX_TASK_BUFFER = 1_000_000;
const MAX_TASKS = 200;
export interface BackgroundTask {
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
export const backgroundTasks = new Map<string, BackgroundTask>();

export const capBuffer = (buf: string) =>
  buf.length > MAX_TASK_BUFFER ? buf.slice(buf.length - MAX_TASK_BUFFER) : buf;

export function evictOldTasks() {
  if (backgroundTasks.size <= MAX_TASKS) return;
  const finished = Array.from(backgroundTasks.values())
    .filter(t => t.status !== "running")
    .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
  for (const t of finished) {
    if (backgroundTasks.size <= MAX_TASKS) break;
    backgroundTasks.delete(t.id);
  }
}

// ── File watchers ────────────────────────────────────────────
export interface FileWatcherEntry {
  id: string;
  watchedPath: string;
  events: Array<{ type: string; filename: string | null; timestamp: number }>;
  handle: ReturnType<typeof fsWatch>;
}
export const fileWatchers = new Map<string, FileWatcherEntry>();

// ── Sessions (shared by transport + tools that stream events) ─
export interface ActiveSession {
  transport: SSEServerTransport;
  server: McpServer;
  createdAt: number;
  lastActivity: number;
  resumeToken: string;
  page: puppeteer.Page | null;
  writeEvent: (msg: string) => void;
}
export const activeSessions = new Map<string, ActiveSession>();
export const sessionsByResumeToken = new Map<string, string>();

// ── Webhook helper ──────────────────────────────────────────
export async function sendWebhook(tool: string, action: string, result: string) {
  if (!WEBHOOK_URL) return;
  try {
    await axios.post(WEBHOOK_URL, { tool, action, result, timestamp: new Date().toISOString() }, { timeout: 5000 });
  } catch { /* non-fatal */ }
}
