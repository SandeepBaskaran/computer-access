import { z } from "zod";
import os from "os";
import path from "path";
import { expandAndResolve } from "../security.js";
import { execFileP } from "../exec.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerWindowManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("window-manage", {
    title: "macOS Window Controller",
    description: "List, focus, resize, move windows and run AppleScript. Extends sys-manage with window-level control.",
    inputSchema: {
      action: z.enum(["list", "focus", "resize", "move", "screenshot-window", "applescript"]).describe("Window operation"),
      app: z.string().optional().describe("App name (for focus/resize/move)"),
      width: z.number().optional().describe("Width pixels (for resize)"),
      height: z.number().optional().describe("Height pixels (for resize)"),
      x: z.number().optional().describe("X position (for move)"),
      y: z.number().optional().describe("Y position (for move)"),
      script: z.string().optional().describe("AppleScript source (for applescript)"),
      path: z.string().optional().describe("Output path (for screenshot-window)")
    }
  }, async ({ action, app, width, height, x, y, script, path: filePath }) => {
    try {
      switch (action) {
        case "list": {
          const { stdout } = await execFileP("osascript", ["-e", 'tell application "System Events" to get {name, title} of every window of every process whose visible is true']);
          await auditLog("window-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout.trim() }] };
        }
        case "focus": {
          if (!app) throw new Error("app required");
          await execFileP("osascript", ["-e", `tell application ${JSON.stringify(app)} to activate`]);
          await auditLog("window-manage", { action, app }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Focused ${app}` }] };
        }
        case "resize": {
          if (!app || !width || !height) throw new Error("app, width, height required");
          await execFileP("osascript", ["-e", `tell application ${JSON.stringify(app)} to set bounds of front window to {0, 0, ${width}, ${height}}`]);
          await auditLog("window-manage", { action, app, width, height }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Resized ${app} to ${width}x${height}` }] };
        }
        case "move": {
          if (!app || x === undefined || y === undefined) throw new Error("app, x, y required");
          await execFileP("osascript", ["-e", `tell application ${JSON.stringify(app)} to set position of front window to {${x}, ${y}}`]);
          await auditLog("window-manage", { action, app, x, y }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Moved ${app} window to (${x}, ${y})` }] };
        }
        case "screenshot-window": {
          if (!app) throw new Error("app required");
          const target = filePath ? await expandAndResolve(filePath) : path.join(os.tmpdir(), `window_${Date.now()}.png`);
          try {
            const { stdout: winId } = await execFileP("osascript", ["-e", `tell application ${JSON.stringify(app)} to id of front window`]);
            await execFileP("screencapture", [`-l${winId.trim()}`, target]);
          } catch {
            await execFileP("screencapture", [target]);
          }
          await auditLog("window-manage", { action, app }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Screenshot saved to ${target}` }] };
        }
        case "applescript": {
          if (!script) throw new Error("script required");
          const { stdout } = await execFileP("osascript", ["-e", script]);
          await auditLog("window-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout.trim() || "[Done]" }] };
        }
        default: throw new Error(`Unknown window action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("window-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Window Error: ${e.message}` }] };
    }
  });
}
