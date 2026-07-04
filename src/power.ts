/**
 * macOS power assertion, held ONLY while jobs are running.
 *
 * A `caffeinate -i` child prevents idle system sleep while it lives; killing
 * it releases the assertion so the Mac sleeps normally when the bridge is
 * idle. Never asserts unconditionally.
 */
import { spawn, ChildProcess } from "child_process";

export class PowerAssertion {
  private proc: ChildProcess | null = null;
  private warned = false;

  /** Reconcile the assertion with the current job count. Idempotent. */
  ensure(activeJobs: number): void {
    if (activeJobs > 0 && !this.proc) {
      try {
        const p = spawn("caffeinate", ["-i"], { stdio: "ignore" });
        p.on("error", () => { // non-macOS or caffeinate missing — degrade quietly, once
          if (!this.warned) { this.warned = true; console.error("[POWER] caffeinate unavailable — sleep prevention disabled"); }
          this.proc = null;
        });
        p.on("exit", () => { if (this.proc === p) this.proc = null; });
        this.proc = p;
        console.error("[POWER] assertion HELD (jobs active — preventing idle sleep)");
      } catch { this.proc = null; }
    } else if (activeJobs === 0 && this.proc) {
      try { this.proc.kill(); } catch { /* already gone */ }
      this.proc = null;
      console.error("[POWER] assertion RELEASED (idle — normal sleep allowed)");
    }
  }

  isHeld(): boolean { return this.proc !== null && this.proc.exitCode === null; }
  pid(): number | undefined { return this.proc?.pid; }
  release(): void { this.ensure(0); }
}
