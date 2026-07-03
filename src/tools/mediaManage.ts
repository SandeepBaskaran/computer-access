import { z } from "zod";
import path from "path";
import mime from "mime-types";
import { ALLOWED_DIRS, ENABLE_FFMPEG } from "../config.js";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { execFileP, tokenizeArgs } from "../exec.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerMediaManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("media-manage", {
    title: "Media Processor",
    description: "Transcode video, convert images, extract audio, or read metadata via FFmpeg/FFprobe.",
    inputSchema: {
      action: z.enum(["transcode", "convert-image", "extract-audio", "metadata"]).describe("Action to perform"),
      args: z.string().optional().describe("FFmpeg args"),
      input: z.string().optional().describe("Input path"),
      output: z.string().optional().describe("Output path"),
      directory: z.string().optional()
    }
  }, async ({ action, args, input, output, directory }) => {
    const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];
    if (!ENABLE_FFMPEG) return { content: [{ type: "text" as const, text: "Error: FFmpeg disabled." }] };
    if (!(await isPathAllowed(targetDir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };

    try {
      // Validate input/output paths against the sandbox (previously only cwd was checked).
      for (const p of [input, output]) {
        if (p) {
          const full = await expandAndResolve(path.isAbsolute(p) ? p : path.join(targetDir, p));
          if (!(await isPathAllowed(full))) return { content: [{ type: "text" as const, text: `ACCESS DENIED: ${p}` }] };
        }
      }

      switch (action) {
        case "transcode": {
          if (!args) throw new Error("Args required for transcode");
          const { stderr } = await execFileP("ffmpeg", ["-y", ...tokenizeArgs(args)], { cwd: targetDir, timeout: 120000 });
          await auditLog("media-manage", { action, args }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stderr }] };
        }
        case "convert-image": {
          if (!input || !output) throw new Error("Input and output paths required");
          await execFileP("ffmpeg", ["-y", "-i", input, output], { cwd: targetDir });
          await auditLog("media-manage", { action, input, output }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Converted to ${output}` }] };
        }
        case "extract-audio": {
          if (!input || !output) throw new Error("Input and output paths required");
          await execFileP("ffmpeg", ["-y", "-i", input, "-vn", "-acodec", "libmp3lame", output], { cwd: targetDir });
          await auditLog("media-manage", { action, input, output }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Audio extracted to ${output}` }] };
        }
        case "metadata": {
          if (!input) throw new Error("Input path required");
          const mimeType = mime.lookup(input);
          if (mimeType && (mimeType.startsWith("application/") || mimeType.startsWith("text/"))) {
            if (!mimeType.includes("image") && !mimeType.includes("video") && !mimeType.includes("audio")) {
              return { content: [{ type: "text" as const, text: `Error: ${input} is a ${mimeType} file. Metadata extraction is only supported for media containers (audio/video/images). Use doc-manage for text files.` }] };
            }
          }
          const { stdout } = await execFileP("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input], { cwd: targetDir });
          await auditLog("media-manage", { action, input }, "SUCCESS", sessionId, undefined, targetDir);
          return { content: [{ type: "text" as const, text: stdout }] };
        }
        default:
          throw new Error(`Unsupported media action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("media-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Media Error: ${String(e.stderr || e.message)}` }] };
    }
  });
}
