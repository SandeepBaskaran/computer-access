import { z } from "zod";
import fg from "fast-glob";
import { ALLOWED_DIRS } from "../config.js";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { auditLog } from "../audit.js";
import { runSearch, checkRg } from "../runtime.js";
import type { Register } from "./types.js";

export function registerFsSearch(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("fs-search", {
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
            const excludeArgs = (excludes || []).flatMap((p: string) => ["--glob", `!${p}`]);
            const args = ["-i", "-C", String(contextLines), ...excludeArgs, "--glob", "!.git", "--glob", "!node_modules", "--glob", "!dist", query, "."];
            const stdout = await runSearch("rg", args, targetDir);
            await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
            return { content: [{ type: "text" as const, text: stdout || "No matches (rg)." }] };
          } else {
            const excludeArgs = (excludes || []).map((p: string) => `--exclude=${p}`);
            const args = ["-rinC", String(contextLines), ...excludeArgs, "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=dist", query, "."];
            const stdout = await runSearch("grep", args, targetDir);
            await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
            return { content: [{ type: "text" as const, text: stdout || "No matches (grep)." }] };
          }
        }
        case "file-search": {
          if (isRg) {
            const stdout = await runSearch("rg", ["--files", "-g", query], targetDir);
            await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
            return { content: [{ type: "text" as const, text: stdout || "No files found (rg)." }] };
          } else {
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
          if (isRg) {
            const args = ["-i", ...patternStrings.flatMap(p => ["-e", p]), ".", "--glob", "!.git", "--glob", "!node_modules"];
            const stdout = await runSearch("rg", args, targetDir);
            await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
            return { content: [{ type: "text" as const, text: stdout || "No definitions found (rg)." }] };
          } else {
            const args = ["-rinI", ...patternStrings.flatMap(p => ["-e", p]), ".", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=dist"];
            const stdout = await runSearch("grep", args, targetDir);
            await auditLog("fs-search", { action, query }, "SUCCESS", sessionId, undefined, targetDir);
            return { content: [{ type: "text" as const, text: stdout || "No definitions found (grep)." }] };
          }
        }
        default:
          throw new Error(`Unsupported search action: ${action}`);
      }
    } catch (e: any) {
      const errorMsg = `Search Error (${action}): ${e.stderr || e.message}`;
      await auditLog("fs-search", { action, query }, "ERROR", sessionId, errorMsg, targetDir);
      return { content: [{ type: "text" as const, text: errorMsg }] };
    }
  });
}
