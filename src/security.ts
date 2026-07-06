// ── Security primitives ─────────────────────────────────────
// Path sandboxing, command blocklist, and the danger/confirmation
// map. These are pure and side-effect free so they can be unit
// tested in isolation (see tests/security.test.ts).
import path from "path";
import os from "os";
import { realpath } from "fs/promises";
import { ALLOWED_DIRS, ENABLE_CONFIRMATION_GATE } from "./config.js";

export async function expandAndResolve(filePath: string): Promise<string> {
  let expanded = filePath;
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  return path.resolve(expanded);
}

// macOS and Windows filesystems are case-insensitive by default.
const normalize = (p: string) =>
  process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;

const isWithin = (child: string, parent: string) => {
  const c = normalize(child);
  const p = normalize(path.resolve(parent));
  return c === p || c.startsWith(p + path.sep);
};

/**
 * Canonicalise a path by resolving symlinks on the deepest existing
 * ancestor and re-appending any not-yet-created tail. This is what
 * closes the symlink-escape hole: even a path that lexically sits
 * inside an allowed dir is rejected if a symlink component points out.
 */
export async function canonicalize(p: string): Promise<string> {
  let cur = p;
  const tail: string[] = [];
  // Walk up until an existing path resolves.
  for (;;) {
    try {
      const real = await realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // reached the root, nothing resolved
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export async function isPathAllowed(filePath: string): Promise<boolean> {
  const resolved = await expandAndResolve(filePath);
  const real = await canonicalize(resolved);
  // Compare the fully symlink-resolved path against symlink-resolved roots.
  for (const dir of ALLOWED_DIRS) {
    const realDir = await canonicalize(path.resolve(dir));
    if (isWithin(real, realDir)) return true;
  }
  return false;
}

// ── Command blocklist ───────────────────────────────────────
// A tripwire, NOT a security boundary. Once shell exec is enabled the
// caller can run anything the user can; this only catches the most
// obvious footguns. Real containment comes from disabling exec.
export const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
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

export function isBlockedCommand(command: string): boolean {
  return BLOCKED_COMMAND_PATTERNS.some(p => p.test(command));
}

// Package installs are USER-AUTHORIZED by design (these are the user's own
// repos): with ALLOW_PACKAGE_INSTALLS=true (default) nothing matches an
// install. Tool modules enforce this only when the user opts out.
export const INSTALL_COMMAND_RE = /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bcargo\s+(install|add)\b|\bbrew\s+install\b|\bgem\s+install\b|\bpoetry\s+add\b|\buv\s+(pip\s+install|add)\b/i;

// ── Danger / confirmation gate ──────────────────────────────
export type DangerLevel = "safe" | "moderate" | "dangerous";

export const DANGER_MAP: Record<string, Record<string, DangerLevel>> = {
  "fs-manage": {
    read: "safe", "read-media": "safe", "batch-read": "safe", list: "safe",
    "list-with-sizes": "safe", tree: "safe", "file-info": "safe",
    write: "moderate", "smart-edit": "moderate", patch: "moderate",
    mkdir: "moderate", copy: "moderate", move: "dangerous", delete: "dangerous",
  },
  "sys-manage": {
    info: "safe", "ps-list": "safe", "list-apps": "safe", "active-app": "safe",
    "window-list": "safe", "clipboard-read": "safe", screenshot: "safe",
    exec: "dangerous", "ps-kill": "dangerous", "open-app": "moderate",
    "open-url": "moderate", "open-file": "moderate", "clipboard-write": "moderate",
    notification: "safe", say: "safe", volume: "moderate", brightness: "moderate",
    caffeinate: "safe", "lock-screen": "dangerous",
  },
  "git-manage": {
    status: "safe", log: "safe", diff: "safe", branch: "safe",
    add: "moderate", commit: "moderate", stash: "moderate", tag: "moderate",
    push: "dangerous", pull: "dangerous", merge: "dangerous", raw: "dangerous",
  },
  "secret-manage": {
    get: "dangerous", list: "dangerous", set: "moderate", delete: "dangerous",
  },
};

export function getDangerLevel(tool: string, action: string): DangerLevel {
  return DANGER_MAP[tool]?.[action] ?? "moderate";
}

export function requiresConfirmation(
  tool: string,
  action: string,
): { required: boolean; reason?: string } {
  if (!ENABLE_CONFIRMATION_GATE) return { required: false };
  if (getDangerLevel(tool, action) === "dangerous") {
    return { required: true, reason: `${tool}:${action} is a dangerous operation` };
  }
  return { required: false };
}
