import { z } from "zod";
import { watch as fsWatch } from "fs";
import { randomUUID } from "crypto";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { execFileP } from "../exec.js";
import { auditLog } from "../audit.js";
import { fileWatchers, type FileWatcherEntry } from "../runtime.js";
import type { Register } from "./types.js";

export function registerWatchManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("watch-manage", {
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
          const { stdout } = await execFileP("tail", ["-n", String(lines), fullPath]);
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
}
