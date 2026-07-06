import { z } from "zod";
import os from "os";
import path from "path";
import { ALLOWED_DIRS, COMMAND_TIMEOUT, ENABLE_RUN_COMMAND, ALLOW_PACKAGE_INSTALLS } from "../config.js";
import { expandAndResolve, isPathAllowed, isBlockedCommand, INSTALL_COMMAND_RE } from "../security.js";
import { execFileP, runShell, spawnCollect, writeToStdin, spawnDetached } from "../exec.js";
import { auditLog } from "../audit.js";
import { activeSessions } from "../runtime.js";
import type { Register } from "./types.js";

export function registerSysManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("sys-manage", {
    title: "System & macOS Control",
    description: "Execute shell commands, manage processes, control macOS apps, clipboard, and system settings.",
    inputSchema: {
      action: z.enum([
        "exec", "info", "ps-list", "ps-kill", "list-apps", "open-app", "open-url", "open-file",
        "clipboard-read", "clipboard-write", "screenshot", "notification", "say",
        "volume", "brightness", "caffeinate", "lock-screen", "active-app", "window-list",
        "test-run", "lint"
      ]).describe("Action to perform"),
      command: z.string().optional().describe("Shell command (for 'exec')"),
      pid: z.number().optional().describe("PID (for 'ps-kill')"),
      url: z.string().optional().describe("URL (for 'open-url')"),
      path: z.string().optional().describe("File path (for 'open-file' or 'screenshot')"),
      name: z.string().optional().describe("App name (for 'open-app')"),
      text: z.string().optional().describe("Text (for 'clipboard-write', 'notification', 'say')"),
      title: z.string().optional().describe("Title (for 'notification')"),
      level: z.number().optional().describe("Level 0-100 (for 'volume', 'brightness')"),
      duration: z.number().optional().describe("Duration in seconds (for 'caffeinate')"),
      directory: z.string().optional().describe("CWD (for 'exec')")
    }
  }, async ({ action, command, pid, url, path: filePath, name, text, title, level, duration, directory }) => {
    try {
      const fullPath = filePath ? await expandAndResolve(filePath) : undefined;
      const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];

      switch (action) {
        case "exec": {
          if (!ENABLE_RUN_COMMAND) {
            await auditLog("sys-manage", { action, command }, "BLOCKED", sessionId, "Exec disabled.", targetDir);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Exec disabled." }] };
          }
          if (!command) throw new Error("Command required for exec");
          if (!(await isPathAllowed(targetDir))) {
            await auditLog("sys-manage", { action, command }, "BLOCKED", sessionId, "ACCESS DENIED.", targetDir);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          }
          if (isBlockedCommand(command)) {
            await auditLog("sys-manage", { action, command }, "BLOCKED", sessionId, "Blocked pattern.", targetDir);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Blocked pattern." }] };
          }
          if (!ALLOW_PACKAGE_INSTALLS && INSTALL_COMMAND_RE.test(command)) {
            await auditLog("sys-manage", { action, command }, "BLOCKED", sessionId, "Installs disabled.", targetDir);
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: package installs are disabled (ALLOW_PACKAGE_INSTALLS=false)." }] };
          }
          const writeEvent = activeSessions.get(sessionId)?.writeEvent;
          const result = await spawnCollect(command, {
            cwd: targetDir,
            timeout: COMMAND_TIMEOUT,
            onData: (line) => writeEvent?.(`exec: ${line.trimEnd().slice(0, 200)}`),
          });
          await auditLog("sys-manage", { action, command }, "SUCCESS", sessionId, undefined, targetDir);
          return { content: [{ type: "text" as const, text: `${result.stdout}\n${result.stderr}`.trim() || "[Done]" }] };
        }
        case "info": {
          const { stdout: disk } = await runShell("df -h / | tail -1 | awk '{print $4}'");
          const info = {
            os: `${os.type()} ${os.release()}`,
            cpu: os.cpus()[0].model,
            ram: Math.round(os.totalmem() / 1e9) + "GB",
            disk: disk.trim(),
            uptime: Math.round(os.uptime() / 3600) + "h"
          };
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
        }
        case "ps-list": {
          const { stdout } = await runShell("ps -A -o pid,pcpu,pmem,comm | head -n 50");
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        case "ps-kill": {
          if (!pid) throw new Error("PID required");
          process.kill(pid);
          await auditLog("sys-manage", { action, pid }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Killed process ${pid}` }] };
        }
        case "list-apps": {
          const { stdout } = await runShell("find /Applications -maxdepth 2 -name '*.app' | head -n 100");
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        case "open-app": {
          if (!name) throw new Error("App name required");
          await execFileP("open", ["-a", name]);
          return { content: [{ type: "text" as const, text: `Opening ${name}` }] };
        }
        case "open-url": {
          if (!url) throw new Error("URL required");
          await execFileP("open", [url]);
          return { content: [{ type: "text" as const, text: `Opening URL: ${url}` }] };
        }
        case "open-file": {
          if (!fullPath) throw new Error("Path required");
          if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          await execFileP("open", [fullPath]);
          return { content: [{ type: "text" as const, text: `Opening file: ${filePath}` }] };
        }
        case "clipboard-read": {
          const { stdout } = await execFileP("pbpaste", []);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        case "clipboard-write": {
          if (!text) throw new Error("Text required");
          await writeToStdin("pbcopy", [], text);
          return { content: [{ type: "text" as const, text: "Copied to clipboard." }] };
        }
        case "screenshot": {
          const target = fullPath || path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
          await execFileP("screencapture", ["-x", target]);
          return { content: [{ type: "text" as const, text: `Screenshot saved to ${target}` }] };
        }
        case "notification": {
          if (!text) throw new Error("Text required");
          const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title || "Computer Access")}`;
          await execFileP("osascript", ["-e", script]);
          await auditLog("sys-manage", { action, title, text: text.substring(0, 50) + (text.length > 50 ? "..." : "") }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: "Notification sent." }] };
        }
        case "say": {
          if (!text) throw new Error("Text required");
          await execFileP("say", [text]);
          await auditLog("sys-manage", { action, text: text.substring(0, 50) + (text.length > 50 ? "..." : "") }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Said: ${text}` }] };
        }
        case "volume": {
          if (level === undefined) {
            const { stdout } = await execFileP("osascript", ["-e", "output volume of (get volume settings)"]);
            await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: `Current Volume: ${stdout.trim()}` }] };
          }
          await execFileP("osascript", ["-e", `set volume output volume ${level}`]);
          await auditLog("sys-manage", { action, level }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Volume set to ${level}` }] };
        }
        case "brightness": {
          if (level === 0) {
            await execFileP("pmset", ["displaysleepnow"]);
            await auditLog("sys-manage", { action, level }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: "Display put to sleep." }] };
          }
          return { content: [{ type: "text" as const, text: "Brightness control requires the 'brightness' CLI tool. Use 'say' or 'notification' for feedback." }] };
        }
        case "caffeinate": {
          const dur = duration || 3600;
          spawnDetached("caffeinate", ["-t", String(dur)]);
          await auditLog("sys-manage", { action, duration: dur }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Preventing sleep for ${dur} seconds.` }] };
        }
        case "lock-screen": {
          await execFileP("/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession", ["-suspend"]);
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: "Screen locked." }] };
        }
        case "active-app": {
          const { stdout } = await execFileP("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true']);
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Active App: ${stdout.trim()}` }] };
        }
        case "window-list": {
          const script = 'tell application "System Events" to get name of every window of (every process whose visible is true)';
          const { stdout } = await execFileP("osascript", ["-e", script]);
          await auditLog("sys-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout.trim() }] };
        }
        case "test-run": {
          if (!ENABLE_RUN_COMMAND) {
            await auditLog("sys-manage", { action }, "BLOCKED", sessionId, "Run command disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Run command disabled." }] };
          }
          const testDir = directory ? await expandAndResolve(directory) : filePath ? await expandAndResolve(filePath) : ALLOWED_DIRS[0];
          if (!(await isPathAllowed(testDir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const testCmd = command || 'npm test';
          try {
            const { stdout, stderr } = await runShell(testCmd, { cwd: testDir, timeout: 120000 });
            await auditLog("sys-manage", { action, command: testCmd, directory: testDir }, "SUCCESS", sessionId);
            const output = [stdout, stderr].filter(Boolean).join('\n---stderr---\n');
            return { content: [{ type: "text" as const, text: `Test Results:\n${output}` }] };
          } catch (err: any) {
            await auditLog("sys-manage", { action, command: testCmd, directory: testDir }, "ERROR", sessionId, err.message);
            const output = [err.stdout, err.stderr].filter(Boolean).map(String).join('\n---stderr---\n');
            return { content: [{ type: "text" as const, text: `Test Failed (exit ${err.code}):\n${output}` }] };
          }
        }
        case "lint": {
          if (!ENABLE_RUN_COMMAND) {
            await auditLog("sys-manage", { action }, "BLOCKED", sessionId, "Run command disabled.");
            return { content: [{ type: "text" as const, text: "ACCESS DENIED: Run command disabled." }] };
          }
          const lintDir = directory ? await expandAndResolve(directory) : filePath ? await expandAndResolve(filePath) : ALLOWED_DIRS[0];
          if (!(await isPathAllowed(lintDir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const lintCmd = command || 'npx eslint . --format compact';
          try {
            const { stdout } = await runShell(lintCmd, { cwd: lintDir, timeout: 60000 });
            await auditLog("sys-manage", { action, command: lintCmd, directory: lintDir }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: `Lint Results:\n${stdout || 'No issues found.'}` }] };
          } catch (err: any) {
            await auditLog("sys-manage", { action, command: lintCmd, directory: lintDir }, "ERROR", sessionId, err.message);
            const output = [err.stdout, err.stderr].filter(Boolean).map(String).join('\n---stderr---\n');
            return { content: [{ type: "text" as const, text: `Lint Issues (exit ${err.code}):\n${output}` }] };
          }
        }
        default:
          throw new Error(`Unsupported system action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("sys-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Sys Error: ${e.message}` }] };
    }
  });
}
