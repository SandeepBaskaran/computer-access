import { z } from "zod";
import { readFile } from "fs/promises";
import * as xlsx from "xlsx";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { parse as csvParse } from "csv-parse/sync";
import { expandAndResolve, isPathAllowed } from "../security.js";
import { execFileP } from "../exec.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerDocManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("doc-manage", {
    title: "Document Intelligence",
    description: "Read PDF, Word, Spreadsheets, CSV, or preview Markdown.",
    inputSchema: {
      action: z.enum(["pdf", "docx", "spreadsheet", "csv", "markdown-preview"]).describe("Action to perform"),
      path: z.string().describe("Target file path")
    }
  }, async ({ action, path: filePath }) => {
    const fullPath = await expandAndResolve(filePath);
    if (!(await isPathAllowed(fullPath))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };

    try {
      switch (action) {
        case "spreadsheet": {
          const wb = xlsx.readFile(fullPath);
          const res: any = {};
          wb.SheetNames.forEach(n => res[n] = xlsx.utils.sheet_to_json(wb.Sheets[n]));
          await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
        }
        case "docx": {
          const { value } = await mammoth.extractRawText({ path: fullPath });
          await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: value }] };
        }
        case "csv": {
          const content = await readFile(fullPath, "utf-8");
          const records = csvParse(content, { columns: true, skip_empty_lines: true });
          await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }] };
        }
        case "markdown-preview": {
          await execFileP("open", [fullPath]);
          await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Opened ${filePath} for preview.` }] };
        }
        case "pdf": {
          const buf = await readFile(fullPath);
          const parser = new PDFParse({ data: buf });
          const data = await parser.getText();
          await auditLog("doc-manage", { action, path: filePath }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: data.text }] };
        }
        default:
          throw new Error(`Unsupported doc action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("doc-manage", { action }, "ERROR", sessionId, e.message, fullPath);
      return { content: [{ type: "text" as const, text: `Doc Error: ${e.message}` }] };
    }
  });
}
