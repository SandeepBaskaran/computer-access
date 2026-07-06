import { z } from "zod";
import { writeFile } from "fs/promises";
import axios from "axios";
import { ENABLE_NET } from "../config.js";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { execFileP } from "../exec.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerNetManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("net-manage", {
    title: "Network & Research Manager",
    description: "HTTP requests, file downloads, web search, and port checks.",
    inputSchema: {
      action: z.enum(["http-request", "download", "web-search", "port-check"]).describe("Action to perform"),
      url: z.string().optional().describe("URL for request/download/search"),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("HTTP method"),
      headers: z.record(z.string()).optional().describe("HTTP headers"),
      body: z.any().optional().describe("Request body"),
      path: z.string().optional().describe("Path for download"),
      port: z.number().optional().describe("Port for check")
    }
  }, async ({ action, url, method = "GET", headers, body, path: filePath, port }) => {
    if (!ENABLE_NET) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Network tools disabled." }] };
    try {
      switch (action) {
        case "http-request": {
          if (!url) throw new Error("URL required");
          const res = await axios({ url, method, headers, data: body });
          await auditLog("net-manage", { action, url, method }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }] };
        }
        case "download": {
          if (!url || !filePath) throw new Error("URL and path required");
          const fullPath = await expandAndResolve(filePath);
          if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };
          const res = await axios({ url, method: "GET", responseType: "arraybuffer" });
          await writeFile(fullPath, Buffer.from(res.data as any));
          return { content: [{ type: "text" as const, text: `Downloaded to ${filePath}` }] };
        }
        case "web-search": {
          if (!url) throw new Error("Search query (url) required");
          const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(url)}`;
          const { data } = await axios.get(searchUrl);
          const titles = ((data as string).match(/result__a">([^<]+)/g) || []).slice(0, 5).map((t: string) => t.replace('result__a">', ''));
          await auditLog("net-manage", { action, query: url }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Search results for "${url}":\n` + (titles.join("\n") || "No results found.") }] };
        }
        case "port-check": {
          const targetPort = port || 80;
          try {
            const { stdout } = await execFileP("lsof", ["-i", `:${targetPort}`]);
            await auditLog("net-manage", { action, port: targetPort }, "SUCCESS", sessionId);
            return { content: [{ type: "text" as const, text: stdout.trim() ? `Port ${targetPort} is IN USE:\n${stdout}` : `Port ${targetPort} is FREE` }] };
          } catch (e: any) {
            // lsof exits 1 when nothing is listening.
            if (e.code === 1) return { content: [{ type: "text" as const, text: `Port ${targetPort} is FREE` }] };
            throw e;
          }
        }
        default:
          throw new Error(`Unsupported net action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("net-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Net Error: ${e.message}` }] };
    }
  });
}
