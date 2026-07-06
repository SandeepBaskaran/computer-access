import { z } from "zod";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { ALLOWED_DIRS, ENABLE_RUN_COMMAND, ALLOW_PACKAGE_INSTALLS } from "../config.js";
import { expandAndResolve, isPathAllowed, isBlockedCommand, INSTALL_COMMAND_RE } from "../security.js";
import { auditLog } from "../audit.js";
import { backgroundTasks, capBuffer, evictOldTasks, type BackgroundTask } from "../runtime.js";
import type { Register } from "./types.js";

export function registerTaskManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("task-manage", {
    title: "Background Task Runner",
    description: "Run long shell commands as background jobs so the SSE connection stays alive. Poll status without blocking.",
    inputSchema: {
      action: z.enum(["run", "status", "logs", "cancel", "list"]).describe("Task operation"),
      command: z.string().optional().describe("Shell command to run in background (for 'run')"),
      taskId: z.string().optional().describe("Task ID (for status/logs/cancel)"),
      directory: z.string().optional().describe("Working directory (for 'run')")
    }
  }, async ({ action, command, taskId, directory }) => {
    try {
      switch (action) {
        case "run": {
          if (!ENABLE_RUN_COMMAND) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Exec disabled." }] };
          if (!command) throw new Error("Command required");
          const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];
          if (!(await isPathAllowed(targetDir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          if (isBlockedCommand(command)) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Blocked pattern." }] };
          if (!ALLOW_PACKAGE_INSTALLS && INSTALL_COMMAND_RE.test(command)) return { content: [{ type: "text" as const, text: "ACCESS DENIED: package installs are disabled (ALLOW_PACKAGE_INSTALLS=false)." }] };
          const id = randomUUID();
          const task: BackgroundTask = { id, command, status: "running", stdout: "", stderr: "", exitCode: null, startedAt: Date.now() };
          backgroundTasks.set(id, task);
          evictOldTasks();
          // detached: true → own process group so cancel can kill children too.
          const proc = spawn("bash", ["-c", command], { cwd: targetDir, detached: true });
          task.pid = proc.pid;
          proc.stdout.on("data", (d: Buffer) => { task.stdout = capBuffer(task.stdout + d.toString()); });
          proc.stderr.on("data", (d: Buffer) => { task.stderr = capBuffer(task.stderr + d.toString()); });
          proc.on("close", (code) => { task.status = code === 0 ? "completed" : "failed"; task.exitCode = code; task.finishedAt = Date.now(); });
          proc.on("error", (e) => { task.status = "failed"; task.stderr = capBuffer(task.stderr + e.message); task.finishedAt = Date.now(); });
          await auditLog("task-manage", { action, command }, "SUCCESS", sessionId, undefined, targetDir);
          return { content: [{ type: "text" as const, text: `Task started. ID: ${id}\nPID: ${task.pid}` }] };
        }
        case "status": {
          if (!taskId) throw new Error("taskId required");
          const t = backgroundTasks.get(taskId);
          if (!t) return { content: [{ type: "text" as const, text: `No task found with ID ${taskId}` }] };
          const elapsed = ((t.finishedAt ?? Date.now()) - t.startedAt) / 1000;
          return { content: [{ type: "text" as const, text: JSON.stringify({ id: t.id, status: t.status, exitCode: t.exitCode, elapsedSeconds: elapsed.toFixed(1), stdoutLines: t.stdout.split("\n").length, stderrLines: t.stderr.split("\n").length }, null, 2) }] };
        }
        case "logs": {
          if (!taskId) throw new Error("taskId required");
          const t = backgroundTasks.get(taskId);
          if (!t) return { content: [{ type: "text" as const, text: `No task found with ID ${taskId}` }] };
          return { content: [{ type: "text" as const, text: `STDOUT:\n${t.stdout || "(empty)"}\n\nSTDERR:\n${t.stderr || "(empty)"}` }] };
        }
        case "cancel": {
          if (!taskId) throw new Error("taskId required");
          const t = backgroundTasks.get(taskId);
          if (!t) return { content: [{ type: "text" as const, text: `No task found with ID ${taskId}` }] };
          if (t.pid) { try { process.kill(-t.pid, "SIGTERM"); } catch { try { process.kill(t.pid, "SIGTERM"); } catch { /* gone */ } } }
          t.status = "cancelled";
          t.finishedAt = Date.now();
          return { content: [{ type: "text" as const, text: `Task ${taskId} cancelled.` }] };
        }
        case "list": {
          const tasks = Array.from(backgroundTasks.values()).map(t => ({
            id: t.id, status: t.status, command: t.command.slice(0, 80), pid: t.pid,
            elapsedSeconds: (((t.finishedAt ?? Date.now()) - t.startedAt) / 1000).toFixed(1)
          }));
          return { content: [{ type: "text" as const, text: tasks.length ? JSON.stringify(tasks, null, 2) : "No background tasks." }] };
        }
        default: throw new Error(`Unknown task action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("task-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Task Error: ${e.message}` }] };
    }
  });
}
