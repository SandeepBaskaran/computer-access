import { z } from "zod";
import { readFile } from "fs/promises";
import { AUDIT_LOG_PATH } from "../audit.js";
import type { Register } from "./types.js";

export function registerAuditManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("audit-manage", {
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
      let raw: string;
      try { raw = await readFile(AUDIT_LOG_PATH, "utf-8"); } catch { return { content: [{ type: "text" as const, text: "audit.log not found or empty." }] }; }

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
}
