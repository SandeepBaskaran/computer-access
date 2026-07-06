import { z } from "zod";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { ALLOWED_DIRS, ENABLE_WRITE_EDIT } from "../config.js";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerEnvManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("env-manage", {
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
          try { raw = await readFile(fullPath, "utf-8"); } catch { /* new file */ }
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
          try { raw = await readFile(fullPath, "utf-8"); } catch { /* new file */ }
          const parsed = parseEnv(raw);
          delete parsed[key];
          await writeFile(fullPath, serializeEnv(parsed));
          await auditLog("env-manage", { action, path: envPath, key }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Removed ${key} from ${fullPath}` }] };
        }
        case "validate": {
          if (!requiredKeys?.length) throw new Error("requiredKeys array required");
          let raw = "";
          try { raw = await readFile(fullPath, "utf-8"); } catch { /* missing */ }
          const parsed = parseEnv(raw);
          const missing = requiredKeys.filter((k: string) => !(k in parsed) || !parsed[k]);
          return { content: [{ type: "text" as const, text: missing.length ? `Missing or empty keys: ${missing.join(", ")}` : "All required keys are present." }] };
        }
        case "diff": {
          if (!pathB) throw new Error("pathB required for diff");
          const fullB = await expandAndResolve(pathB);
          if (!(await isPathAllowed(fullB))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          let rawA = "", rawB = "";
          try { rawA = await readFile(fullPath, "utf-8"); } catch { /* missing */ }
          try { rawB = await readFile(fullB, "utf-8"); } catch { /* missing */ }
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
}
