/**
 * Wake detection via monotonic-clock gap.
 *
 * Sleep freezes the process: a 15s interval that suddenly observes a much
 * larger wall-clock delta means the machine slept and woke. (This is the
 * dependency-free fallback for IORegisterForSystemPower / NSWorkspace
 * didWakeNotification, which need native bindings.)
 */
export class WakeDetector {
  private timer: NodeJS.Timeout | null = null;
  private lastTick = Date.now();

  constructor(
    private gapMs: number,
    private onWake: (gapMs: number) => void,
    private intervalMs = 15000,
  ) {}

  /** Pure decision logic — exposed for testing. */
  static isWakeGap(expectedIntervalMs: number, observedDeltaMs: number, gapThresholdMs: number): boolean {
    return observedDeltaMs - expectedIntervalMs > gapThresholdMs;
  }

  start(): void {
    this.lastTick = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const delta = now - this.lastTick;
      this.lastTick = now;
      if (WakeDetector.isWakeGap(this.intervalMs, delta, this.gapMs)) {
        console.error(`[WAKE] detected wake from sleep (clock gap ${Math.round(delta / 1000)}s)`);
        this.onWake(delta);
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
