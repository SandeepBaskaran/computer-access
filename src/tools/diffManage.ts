import { z } from "zod";
import { readFile } from "fs/promises";
import { ALLOWED_DIRS } from "../config.js";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { execFileP, writeToStdin } from "../exec.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerDiffManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("diff-manage", {
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
    // diff/diff3 exit non-zero when inputs differ; treat that as normal output.
    const runDiff = async (file: string, args: string[]) => {
      try { const { stdout } = await execFileP(file, args); return stdout; }
      catch (e: any) { if (typeof e.code === "number" && e.stdout !== undefined) return String(e.stdout); throw e; }
    };
    try {
      switch (action) {
        case "file-diff": {
          if (!pathA || !pathB) throw new Error("pathA and pathB required");
          const a = await expandAndResolve(pathA);
          const b = await expandAndResolve(pathB);
          if (!(await isPathAllowed(a)) || !(await isPathAllowed(b))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const stdout = await runDiff("diff", ["-u", a, b]);
          await auditLog("diff-manage", { action, pathA, pathB }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout || "Files are identical." }] };
        }
        case "dir-diff": {
          if (!pathA || !pathB) throw new Error("pathA and pathB required");
          const a = await expandAndResolve(pathA);
          const b = await expandAndResolve(pathB);
          if (!(await isPathAllowed(a)) || !(await isPathAllowed(b))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const stdout = await runDiff("diff", ["-rq", a, b]);
          await auditLog("diff-manage", { action, pathA, pathB }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout || "Directories are identical." }] };
        }
        case "apply-patch": {
          if (!patchFile) throw new Error("patchFile required");
          const patchFull = await expandAndResolve(patchFile);
          const dir = targetDir ? await expandAndResolve(targetDir) : ALLOWED_DIRS[0];
          if (!(await isPathAllowed(patchFull)) || !(await isPathAllowed(dir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const patchContent = await readFile(patchFull, "utf-8");
          const { stdout, stderr } = await writeToStdin("patch", ["-p1"], patchContent, { cwd: dir });
          await auditLog("diff-manage", { action, patchFile }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `${stdout}\n${stderr}`.trim() }] };
        }
        case "three-way-merge": {
          if (!pathA || !pathB || !base) throw new Error("pathA (mine), pathB (theirs), and base required");
          const mine = await expandAndResolve(pathA);
          const theirs = await expandAndResolve(pathB);
          const baseFull = await expandAndResolve(base);
          if (!(await isPathAllowed(mine)) || !(await isPathAllowed(theirs)) || !(await isPathAllowed(baseFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const stdout = await runDiff("diff3", [mine, baseFull, theirs]);
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
}
