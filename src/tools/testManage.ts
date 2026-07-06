import { z } from "zod";
import { stat, readFile } from "fs/promises";
import path from "path";
import { ALLOWED_DIRS, ENABLE_RUN_COMMAND } from "../config.js";
import { isPathAllowed, expandAndResolve } from "../security.js";
import { execFileP } from "../exec.js";
import { auditLog } from "../audit.js";
import { activeSessions } from "../runtime.js";
import type { Register } from "./types.js";

export function registerTestManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("test-manage", {
    title: "Structured Test Runner",
    description: "Run test suites and return structured pass/fail data instead of raw terminal output.",
    inputSchema: {
      action: z.enum(["run", "run-file", "coverage"]).describe("Test operation"),
      path: z.string().optional().describe("Test file (for run-file)"),
      directory: z.string().optional().describe("Project directory"),
      runner: z.enum(["jest", "vitest", "pytest", "go", "cargo"]).optional().describe("Override test runner")
    }
  }, async ({ action, path: testFile, directory, runner }) => {
    if (!ENABLE_RUN_COMMAND) return { content: [{ type: "text" as const, text: "ACCESS DENIED: Exec disabled." }] };
    try {
      const targetDir = directory ? await expandAndResolve(directory) : ALLOWED_DIRS[0];
      if (!(await isPathAllowed(targetDir))) return { content: [{ type: "text" as const, text: "ACCESS DENIED." }] };

      const detected = runner || await (async () => {
        try {
          await stat(path.join(targetDir, "package.json"));
          const pkg = JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf-8"));
          if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) return "vitest";
          return "jest";
        } catch { /* not a node project */ }
        try { await stat(path.join(targetDir, "pytest.ini")); return "pytest"; } catch { /* */ }
        try { await stat(path.join(targetDir, "go.mod")); return "go"; } catch { /* */ }
        try { await stat(path.join(targetDir, "Cargo.toml")); return "cargo"; } catch { /* */ }
        return "jest";
      })();

      const coverage = action === "coverage";
      const runFile = action === "run-file" && testFile;
      let file: string;
      let argv: string[];
      switch (detected) {
        case "jest":
          file = "npx"; argv = ["jest", ...(coverage ? ["--coverage"] : []), ...(runFile ? [testFile!] : []), "--json"]; break;
        case "vitest":
          file = "npx"; argv = ["vitest", "run", ...(coverage ? ["--coverage"] : []), ...(runFile ? [testFile!] : [])]; break;
        case "pytest":
          file = "python"; argv = ["-m", "pytest", ...(runFile ? [testFile!] : []), coverage ? "--co" : "-v"]; break;
        case "go":
          file = "go"; argv = ["test", "./...", coverage ? "-cover" : "-v"]; break;
        case "cargo":
          file = "cargo"; argv = ["test"]; break;
        default:
          file = "npm"; argv = ["test"]; break;
      }

      const writeEvent = activeSessions.get(sessionId)?.writeEvent;
      writeEvent?.(`test: Running ${detected} tests...`);

      let raw: string;
      try {
        const { stdout, stderr } = await execFileP(file, argv, { cwd: targetDir, timeout: 120000 });
        raw = `${stdout}\n${stderr}`.trim();
      } catch (err: any) {
        // Test runners exit non-zero when tests fail — that's expected output, not a crash.
        raw = `${String(err.stdout || "")}\n${String(err.stderr || "")}`.trim() || err.message;
      }

      let structured = raw;
      if (detected === "jest" && !coverage) {
        try {
          const jsonStart = raw.indexOf("{");
          if (jsonStart >= 0) {
            const parsed = JSON.parse(raw.slice(jsonStart));
            const summary = {
              passed: parsed.numPassedTests, failed: parsed.numFailedTests,
              skipped: parsed.numPendingTests, total: parsed.numTotalTests,
              duration: parsed.testResults?.reduce((a: number, r: any) => a + (r.endTime - r.startTime), 0),
              failedTests: parsed.testResults?.flatMap((r: any) => r.testResults?.filter((t: any) => t.status === "failed").map((t: any) => ({ name: t.fullName, message: t.failureMessages?.join("\n").slice(0, 300) }))) ?? []
            };
            structured = JSON.stringify(summary, null, 2);
          }
        } catch { /* fall back to raw */ }
      }

      await auditLog("test-manage", { action, runner: detected }, "SUCCESS", sessionId, undefined, targetDir);
      return { content: [{ type: "text" as const, text: structured }] };
    } catch (e: any) {
      await auditLog("test-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Test Error: ${e.message}` }] };
    }
  });
}
