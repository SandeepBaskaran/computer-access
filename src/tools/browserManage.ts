import { z } from "zod";
import os from "os";
import path from "path";
import { ENABLE_BROWSER } from "../config.js";
import { expandAndResolve } from "../security.js";
import { auditLog } from "../audit.js";
import { getBrowser, activeSessions } from "../runtime.js";
import type { Register } from "./types.js";

export function registerBrowserManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("browser-manage", {
    title: "Web Browser Controller",
    description: "Control a headless browser to navigate, click, type, and scrape content.",
    inputSchema: {
      action: z.enum(["navigate", "click", "type", "screenshot-page", "get-text", "get-html", "evaluate", "wait", "pdf"]).describe("Action to perform"),
      url: z.string().optional().describe("URL to navigate to"),
      selector: z.string().optional().describe("CSS selector for elements"),
      text: z.string().optional().describe("Text to type"),
      script: z.string().optional().describe("JS to evaluate"),
      path: z.string().optional().describe("Path for screenshot/PDF")
    }
  }, async ({ action, url, selector, text, script, path: filePath }) => {
    if (!ENABLE_BROWSER) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Browser tools disabled." }] };
    try {
      const b = await getBrowser();
      const session = activeSessions.get(sessionId);
      if (!session) throw new Error("Session lost");
      if (!session.page || session.page.isClosed()) session.page = await b.newPage();
      const page = session.page;

      switch (action) {
        case "navigate": {
          if (!url) throw new Error("URL required");
          await page.goto(url, { waitUntil: "networkidle2" });
          await auditLog("browser-manage", { action, url }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Navigated to ${url}` }] };
        }
        case "click": {
          if (!selector) throw new Error("Selector required");
          await page.click(selector);
          await auditLog("browser-manage", { action, selector }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Clicked ${selector}` }] };
        }
        case "type": {
          if (!selector || !text) throw new Error("Selector and text required");
          await page.type(selector, text);
          await auditLog("browser-manage", { action, selector }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Typed into ${selector}` }] };
        }
        case "get-text": {
          const content = await page.evaluate(() => document.body.innerText);
          await auditLog("browser-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: content }] };
        }
        case "get-html": {
          const html = await page.content();
          await auditLog("browser-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: html }] };
        }
        case "screenshot-page": {
          const target = filePath ? await expandAndResolve(filePath) : path.join(os.tmpdir(), `browser_${Date.now()}.png`);
          await page.screenshot({ path: target as `${string}.png`, fullPage: true });
          await auditLog("browser-manage", { action, target }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Screenshot saved to ${target}` }] };
        }
        case "pdf": {
          const target = filePath ? await expandAndResolve(filePath) : path.join(os.tmpdir(), `page_${Date.now()}.pdf`);
          await page.pdf({ path: target as `${string}.pdf`, format: "A4" });
          await auditLog("browser-manage", { action, target }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `PDF saved to ${target}` }] };
        }
        case "wait": {
          if (selector) await page.waitForSelector(selector);
          else await new Promise(r => setTimeout(r, 2000));
          await auditLog("browser-manage", { action, selector }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: "Wait complete." }] };
        }
        case "evaluate": {
          if (!script) throw new Error("Script required");
          const result = await page.evaluate(script);
          await auditLog("browser-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        }
        default:
          throw new Error(`Unsupported browser action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("browser-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Browser Error: ${e.message}` }] };
    }
  });
}
