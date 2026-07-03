import { z } from "zod";
import { ENABLE_SECRETS } from "../config.js";
import { execFileP, runShell } from "../exec.js";
import { auditLog } from "../audit.js";
import type { Register } from "./types.js";

export function registerSecretManage(registerGuardedTool: Register, sessionId: string) {
  registerGuardedTool("secret-manage", {
    title: "macOS Keychain Manager",
    description: "Read, write, and delete secrets from the macOS Keychain via the security CLI.",
    inputSchema: {
      action: z.enum(["get", "set", "delete", "list"]).describe("Keychain operation"),
      service: z.string().optional().describe("Keychain service name"),
      account: z.string().optional().describe("Keychain account name"),
      value: z.string().optional().describe("Secret value (for 'set')")
    }
  }, async ({ action, service, account, value }) => {
    if (!ENABLE_SECRETS) {
      await auditLog("secret-manage", { action }, "BLOCKED", sessionId, "Secrets disabled.");
      return { content: [{ type: "text" as const, text: "ACCESS DENIED: Keychain access disabled. Set ENABLE_SECRETS=true to enable." }] };
    }
    try {
      switch (action) {
        case "get": {
          if (!service || !account) throw new Error("service and account required");
          const { stdout } = await execFileP("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
          await auditLog("secret-manage", { action, service, account }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout.trim() }] };
        }
        case "set": {
          if (!service || !account || value === undefined) throw new Error("service, account, and value required");
          await execFileP("security", ["add-generic-password", "-s", service, "-a", account, "-w", value, "-U"]);
          await auditLog("secret-manage", { action, service, account }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Secret set for ${service}/${account}` }] };
        }
        case "delete": {
          if (!service || !account) throw new Error("service and account required");
          await execFileP("security", ["delete-generic-password", "-s", service, "-a", account]);
          await auditLog("secret-manage", { action, service, account }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: `Secret deleted: ${service}/${account}` }] };
        }
        case "list": {
          const { stdout } = await runShell(`security dump-keychain | grep -E '"svce"|"acct"' | head -100`);
          await auditLog("secret-manage", { action }, "SUCCESS", sessionId);
          return { content: [{ type: "text" as const, text: stdout || "(no entries)" }] };
        }
        default: throw new Error(`Unknown secret action: ${action}`);
      }
    } catch (e: any) {
      await auditLog("secret-manage", { action }, "ERROR", sessionId, e.message);
      return { content: [{ type: "text" as const, text: `Secret Error: ${e.message}` }] };
    }
  });
}
