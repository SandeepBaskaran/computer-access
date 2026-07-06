import { z } from "zod";
import { mkdir } from "fs/promises";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { execFileP } from "../exec.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerArchiveManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("archive-manage", {
    title: "Archive Manager",
    description: "Create and extract zip/tar archives. List archive contents.",
    inputSchema: {
      action: z.enum(["zip", "unzip", "tar", "untar", "list-contents"]).describe("Archive operation"),
      source: z.string().optional().describe("Source path(s), comma-separated for zip/tar"),
      destination: z.string().optional().describe("Output archive or extraction directory"),
      path: z.string().optional().describe("Archive path (for unzip/untar/list-contents)")
    }
  }, async ({ action, source, destination, path: archivePath }) => {
    try {
      switch (action) {
        case "zip": {
          if (!source || !destination) throw new Error("source and destination required");
          const destFull = await expandAndResolve(destination);
          if (!(await isPathAllowed(destFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const sources = source.split(",").map((s: string) => s.trim());
          await execFileP("zip", ["-r", destFull, ...sources]);
          await auditLog("archive-manage", { action, source, destination }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Zipped to ${destFull}` }] };
        }
        case "unzip": {
          if (!archivePath || !destination) throw new Error("path and destination required");
          const archFull = await expandAndResolve(archivePath);
          const destFull = await expandAndResolve(destination);
          if (!(await isPathAllowed(archFull)) || !(await isPathAllowed(destFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          await mkdir(destFull, { recursive: true });
          const { stdout } = await execFileP("unzip", ["-o", archFull, "-d", destFull]);
          await auditLog("archive-manage", { action, path: archivePath, destination }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        case "tar": {
          if (!source || !destination) throw new Error("source and destination required");
          const destFull = await expandAndResolve(destination);
          if (!(await isPathAllowed(destFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const sources = source.split(",").map((s: string) => s.trim());
          await execFileP("tar", ["czf", destFull, ...sources]);
          await auditLog("archive-manage", { action, source, destination }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Tar created at ${destFull}` }] };
        }
        case "untar": {
          if (!archivePath || !destination) throw new Error("path and destination required");
          const archFull = await expandAndResolve(archivePath);
          const destFull = await expandAndResolve(destination);
          if (!(await isPathAllowed(archFull)) || !(await isPathAllowed(destFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          await mkdir(destFull, { recursive: true });
          const { stdout } = await execFileP("tar", ["xzf", archFull, "-C", destFull]);
          await auditLog("archive-manage", { action, path: archivePath, destination }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Extracted to ${destFull}\n${stdout}`.trim() }] };
        }
        case "list-contents": {
          if (!archivePath) throw new Error("path required");
          const archFull = await expandAndResolve(archivePath);
          if (!(await isPathAllowed(archFull))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const isZip = archFull.endsWith(".zip");
          const { stdout } = isZip
            ? await execFileP("unzip", ["-l", archFull])
            : await execFileP("tar", ["tzf", archFull]);
          await auditLog("archive-manage", { action, path: archivePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        default: throw new Error(`Unknown archive action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("archive-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Archive Error: ${e.message}` }] };
    }
  });
}
