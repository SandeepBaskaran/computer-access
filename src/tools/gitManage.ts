import { z } from "zod";
import { stat } from "fs/promises";
import path from "path";
import { ALLOWED_DIRS, ENABLE_GIT } from "../config.js";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { execFileP, tokenizeArgs } from "../exec.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerGitManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("git-manage", {
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

    // Git repo awareness check
    try {
      await stat(path.join(targetDir, ".git"));
    } catch {
      if (action !== "raw" || !args.includes("init")) {
        return { content: [{ type: "text" as const, text: `Git Error: Not a git repository in ${targetDir}. Use 'git-manage raw' with 'init' if you wish to initialize one.` }] };
      }
    }

    try {
      // execFileP runs git with an explicit argv (no shell), so metacharacters
      // in args are inert — no need for the old pipe/semicolon blocklist.
      let argv: string[];
      if (action === "raw") argv = tokenizeArgs(args);
      else if (action === "commit" && message) argv = ["commit", "-m", message, ...tokenizeArgs(args)];
      else argv = [action, ...tokenizeArgs(args)];

      const { stdout, stderr } = await execFileP("git", argv, { cwd: targetDir, timeout: 30000 });
      await auditLog("git-manage", { action, args }, "SUCCESS", sessionId, undefined, targetDir);
      return { content: [{ type: "text" as const, text: `${stdout}\n${stderr}`.trim() || "[Success]" }] };
    } catch (e: any) {
      await auditLog("git-manage", { action }, "ERROR", sessionId, e.message, targetDir);
      return { content: [{ type: "text" as const, text: `Git Error: ${String(e.stdout || e.stderr || e.message)}` }] };
    }
  });
}
