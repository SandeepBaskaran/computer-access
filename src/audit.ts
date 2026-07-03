// ── Audit logging ───────────────────────────────────────────
// Append-only JSONL audit trail with size-based rotation.
import { appendFile, stat, rename } from "fs/promises";
import { AUDIT_LOG_PATH, AUDIT_LOG_MAX_BYTES } from "./config.js";

export type AuditStatus = "SUCCESS" | "BLOCKED" | "ERROR";

async function rotateIfNeeded() {
  try {
    const s = await stat(AUDIT_LOG_PATH);
    if (s.size >= AUDIT_LOG_MAX_BYTES) {
      await rename(AUDIT_LOG_PATH, `${AUDIT_LOG_PATH}.1`).catch(() => {});
    }
  } catch { /* no log yet */ }
}

export async function auditLog(
  tool: string,
  input: unknown,
  status: AuditStatus,
  sessionId?: string,
  errorMessage?: string,
  targetDir?: string,
): Promise<void> {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    session: sessionId || "SYSTEM",
    tool,
    input,
    status,
    ...(targetDir ? { cwd: targetDir } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
  }) + "\n";
  await rotateIfNeeded();
  await appendFile(AUDIT_LOG_PATH, entry).catch(e => console.error("Audit log failed:", e));
}

export { AUDIT_LOG_PATH };
