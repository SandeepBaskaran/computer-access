import { z } from "zod";
import path from "path";
import { ENABLE_RUN_COMMAND } from "../config.js";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { execFileP } from "../exec.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerCodeFormat(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("code-format", {
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
          try { await execFileP("which", [f]); available.push(f); } catch { /* not installed */ }
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

      const checkArgs: Record<string, string[]> = {
        prettier: ["--check", fullPath], black: ["--check", fullPath], gofmt: ["-l", fullPath], rustfmt: ["--check", fullPath],
      };
      const writeArgs: Record<string, string[]> = {
        prettier: ["--write", fullPath], black: [fullPath], gofmt: ["-w", fullPath], rustfmt: [fullPath],
      };
      const args = action === "check"
        ? (checkArgs[detected] ?? ["--check", fullPath])
        : (writeArgs[detected] ?? ["-i", fullPath]);

      const { stdout, stderr } = await execFileP(detected, args);
      await auditLog("code-format", { action, path: filePath, formatter: detected }, "SUCCESS", sessionId);
      return { content: [{ type: "text" as const, text: `${stdout}\n${stderr}`.trim() || (action === "check" ? "File is correctly formatted." : "Formatted successfully.") }] };
    } catch (e: any) {
      await auditLog("code-format", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Format Error: ${String(e.stdout || e.stderr || e.message)}` }] };
    }
  });
}
