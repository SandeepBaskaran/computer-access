import { z } from "zod";
import Database from "better-sqlite3";
import { ENABLE_DB } from "../config.js";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerDbManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("db-manage", {
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
            const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as Array<{ name: string; sql: string }>;
            await auditLog("db-manage", { action, path: dbPath }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: rows.map(r => r.sql).join(";\n\n") || "(no schema)" }] };
          }
          case "list-tables": {
            const rows = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name").all() as Array<{ name: string; type: string }>;
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
}
