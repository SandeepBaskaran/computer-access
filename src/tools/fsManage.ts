import { z } from "zod";
import { readFile, writeFile, mkdir, readdir, stat, rm, rename, copyFile } from "fs/promises";
import path from "path";
import mime from "mime-types";
import { ALLOWED_DIRS, ENABLE_WRITE_EDIT, MAX_READ_BYTES } from "../config.js";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { writeToStdin } from "../exec.js";
import { auditLog } from "../audit.js";
import { getDirectoryTree } from "../runtime.js";
import type { Register } from "./types.js";

export function registerFsManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("fs-manage", {
    title: "Filesystem Manager",
    description: "Advanced file operations including read, write, batch access, tree visualization, and surgical editing.",
    inputSchema: {
      action: z.enum([
        "read", "read-media", "batch-read", "write", "smart-edit", "patch", "list",
        "list-with-sizes", "tree", "file-info", "move", "copy", "delete", "mkdir"
      ]).describe("File operation to perform"),
      path: z.string().optional().describe("Target path"),
      paths: z.array(z.string()).optional().describe("Multiple paths for batch-read"),
      content: z.string().optional().describe("Content for 'write'"),
      targetContent: z.string().optional().describe("String to find for 'smart-edit'"),
      newContent: z.string().optional().describe("Replacement string for 'smart-edit'"),
      destination: z.string().optional().describe("Destination for 'move' or 'copy'"),
      limit: z.number().optional().describe("Line limit for 'read' head/tail"),
      tail: z.boolean().optional().describe("If true, 'read' returns the last N lines"),
      excludes: z.array(z.string()).optional().describe("Patterns to exclude in 'tree'"),
      sortBy: z.enum(["name", "size"]).optional().describe("Sort order for 'list-with-sizes'")
    }
  }, async ({ action, path: filePath, paths, content, targetContent, newContent, destination, limit, tail, excludes, sortBy }) => {
    try {
      if (action === "batch-read") {
        if (!paths) throw new Error("Paths array required for batch-read");
        const results = await Promise.all(paths.map(async (p: string) => {
          const fullP = await expandAndResolve(p);
          if (!(await isPathAllowed(fullP))) return { path: p, error: "ACCESS DENIED" };
          try {
            const st = await stat(fullP);
            if (st.size > MAX_READ_BYTES) return { path: p, error: `File too large (${st.size} bytes, limit ${MAX_READ_BYTES})` };
            return { path: p, content: await readFile(fullP, "utf-8") };
          } catch (e: any) { return { path: p, error: e.message }; }
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      }

      const fullPath = filePath ? await expandAndResolve(filePath) : undefined;
      if (fullPath && !(await isPathAllowed(fullPath))) {
        await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "ACCESS DENIED", fullPath);
        return { content: [{ type: "text" as const, text: `ACCESS DENIED: Path '${fullPath}' is restricted.` }] };
      }

      switch (action) {
        case "read": {
          if (!fullPath) throw new Error("Path required for read");
          const fileStats = await stat(fullPath);
          if (fileStats.size > MAX_READ_BYTES) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, `File too large (${fileStats.size} bytes, limit ${MAX_READ_BYTES})`);
            return { content: [{ type: "text" as const, text: `BLOCKED: File is ${(fileStats.size / 1024 / 1024).toFixed(1)} MB, exceeding MAX_READ_BYTES limit of ${(MAX_READ_BYTES / 1024 / 1024).toFixed(0)} MB. Use 'limit' parameter to read a subset of lines.` }] };
          }
          let text = await readFile(fullPath, "utf-8");
          if (limit) {
            const lines = text.split("\n");
            text = tail ? lines.slice(-limit).join("\n") : lines.slice(0, limit).join("\n");
          }
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text }] };
        }
        case "read-media": {
          if (!fullPath) throw new Error("Path required for read-media");
          const st = await stat(fullPath);
          if (st.size > MAX_READ_BYTES) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, `File too large (${st.size} bytes, limit ${MAX_READ_BYTES})`);
            return { content: [{ type: "text" as const, text: `BLOCKED: File is ${(st.size / 1024 / 1024).toFixed(1)} MB, exceeding MAX_READ_BYTES limit.` }] };
          }
          const buffer = await readFile(fullPath);
          const mimeType = mime.lookup(fullPath) || "application/octet-stream";
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `data:${mimeType};base64,${buffer.toString("base64")}` }] };
        }
        case "write": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || content === undefined) throw new Error("Path and content required for write");
          await mkdir(path.dirname(fullPath), { recursive: true });
          await writeFile(fullPath, content);
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `File written: ${filePath}` }] };
        }
        case "smart-edit": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || targetContent === undefined || newContent === undefined) throw new Error("Path, targetContent, and newContent required for smart-edit");
          const original = await readFile(fullPath, "utf-8");
          const parts = original.split(targetContent);
          const occurrences = parts.length - 1;
          if (occurrences === 0) throw new Error("targetContent not found in file");
          if (occurrences > 1) throw new Error(`targetContent is not unique (${occurrences} matches). Provide more context so exactly one match remains.`);
          // split/join avoids String.replace's special $-sequence interpretation.
          const updated = parts.join(newContent);
          await writeFile(fullPath, updated);
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Successfully updated ${filePath}` }] };
        }
        case "patch": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || !content) throw new Error("Path and content (unified diff) required for patch");
          // Delegate to the system patch(1); it validates context lines instead
          // of blindly splicing hunks like the previous hand-rolled applier.
          const { stdout, stderr } = await writeToStdin("patch", [fullPath], content, { cwd: path.dirname(fullPath) });
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `${stdout}\n${stderr}`.trim() || `Patch applied to ${filePath}` }] };
        }
        case "list": {
          if (!fullPath) throw new Error("Path required for list");
          const entries = await readdir(fullPath, { withFileTypes: true });
          const list = entries.map(e => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`).join("\n");
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: list || "[Empty]" }] };
        }
        case "list-with-sizes": {
          if (!fullPath) throw new Error("Path required for list-with-sizes");
          const entries = await readdir(fullPath, { withFileTypes: true });
          const results = await Promise.all(entries.map(async (e) => {
            const info = await stat(path.join(fullPath, e.name));
            return { name: e.name, type: e.isDirectory() ? "directory" : "file", size: info.size };
          }));
          if (sortBy === "size") results.sort((a, b) => b.size - a.size);
          else results.sort((a, b) => a.name.localeCompare(b.name));
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
        }
        case "tree": {
          if (!fullPath) throw new Error("Path required for tree");
          const tree = await getDirectoryTree(fullPath, excludes);
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: JSON.stringify(tree, null, 2) }] };
        }
        case "file-info": {
          if (!fullPath) throw new Error("Path required for file-info");
          const info = await stat(fullPath);
          const details = {
            size: info.size,
            created: info.birthtime,
            modified: info.mtime,
            permissions: info.mode.toString(8).slice(-3),
            mime: mime.lookup(fullPath) || "unknown"
          };
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }] };
        }
        case "move": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || !destination) throw new Error("Path and destination required for move");
          const destPath = await expandAndResolve(destination);
          if (!(await isPathAllowed(destPath))) {
            await auditLog("fs-manage", { action, path: filePath, destination }, "BLOCKED", sessionId, "Destination restricted.", destPath);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Destination restricted." }] };
          }
          await rename(fullPath, destPath);
          await auditLog("fs-manage", { action, path: filePath, destination }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Moved to ${destination}` }] };
        }
        case "copy": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath || !destination) throw new Error("Path and destination required for copy");
          const destPath = await expandAndResolve(destination);
          if (!(await isPathAllowed(destPath))) {
            await auditLog("fs-manage", { action, path: filePath, destination }, "BLOCKED", sessionId, "Destination restricted.", destPath);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Destination restricted." }] };
          }
          await copyFile(fullPath, destPath);
          await auditLog("fs-manage", { action, path: filePath, destination }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Copied to ${destination}` }] };
        }
        case "delete": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath) throw new Error("Path required for delete");
          const isRoot = ALLOWED_DIRS.some(dir => {
            const resolvedRoot = path.resolve(dir).toLowerCase();
            return fullPath.toLowerCase() === resolvedRoot;
          });
          if (isRoot) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Deleting the workspace root is prohibited.", fullPath);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Deleting the exact root of an allowed directory is prohibited for safety. Delete its contents instead." }] };
          }
          const s = await stat(fullPath).catch(() => null);
          const isDir = s?.isDirectory();
          await rm(fullPath, { recursive: true, force: true });
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Successfully deleted ${isDir ? "directory" : "file"}: ${filePath}` }] };
        }
        case "mkdir": {
          if (!ENABLE_WRITE_EDIT) {
            await auditLog("fs-manage", { action, path: filePath }, "BLOCKED", sessionId, "Write disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Write disabled." }] };
          }
          if (!fullPath) throw new Error("Path required for mkdir");
          await mkdir(fullPath, { recursive: true });
          await auditLog("fs-manage", { action, path: filePath }, "SUCCESS", sessionId, undefined, fullPath);
          return { content: [{ type: "text" as const, text: `Created directory: ${filePath}` }] };
        }
        default:
          throw new Error(`Unsupported fs-manage action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("fs-manage", { action }, "ERROR", sessionId, e.message, filePath ? await expandAndResolve(filePath) : undefined);
      return { content: [{ type: "text" as const, text: `FS Error: ${e.message}` }] };
    }
  });
}
