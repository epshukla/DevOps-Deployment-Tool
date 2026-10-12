import { RUN_CANCEL_POLL_INTERVAL_MS } from "@deployx/shared";
import type { RunnerApiClient } from "../api-client";

export interface CancellationWatcherOptions {
  readonly client: RunnerApiClient;
  readonly runId: string;
  readonly intervalMs?: number;
}

/**
 * Polls the control plane for run cancellation while a pipeline executes
 * and exposes the result as an AbortSignal, so in-flight steps can be
 * killed instead of only checking between DAG groups.
 *
 * Poll failures are logged and polling continues (fail-open: a flaky
 * control plane must not abort a healthy run).
 */
export class CancellationWatcher {
  private readonly client: RunnerApiClient;
  private readonly runId: string;
  private readonly intervalMs: number;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(options: CancellationWatcherOptions) {
    this.client = options.client;
    this.runId = options.runId;
    this.intervalMs = options.intervalMs ?? RUN_CANCEL_POLL_INTERVAL_MS;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  start(): void {
    if (this.timer || this.cancelled) return;
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Checks the run status now (sharing any poll already in flight).
   * Resolves true if the run is cancelled.
   */
  check(): Promise<boolean> {
    if (this.cancelled) return Promise.resolve(true);
    if (!this.inFlight) {
      this.inFlight = this.poll().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async poll(): Promise<boolean> {
    try {
      const { status } = await this.client.getRunStatus(this.runId);
      if (status === "cancelled" && !this.cancelled) {
        console.log(`Run ${this.runId} cancelled by user — aborting in-flight work`);
        this.stop();
        this.controller.abort();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to check run status for cancellation: ${msg} — will retry`);
    }
    return this.cancelled;
  }
}
