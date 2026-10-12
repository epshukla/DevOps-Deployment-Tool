import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CancellationWatcher } from "../cancellation-watcher";
import type { RunnerApiClient } from "../../api-client";

function createClient(getRunStatus: ReturnType<typeof vi.fn>): RunnerApiClient {
  return { getRunStatus } as unknown as RunnerApiClient;
}

describe("CancellationWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls on the interval and aborts its signal when the run is cancelled", async () => {
    const getRunStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "cancelled" });
    const watcher = new CancellationWatcher({
      client: createClient(getRunStatus),
      runId: "run-1",
      intervalMs: 3000,
    });
    const onAbort = vi.fn();
    watcher.signal.addEventListener("abort", onAbort);

    watcher.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(watcher.cancelled).toBe(false);

    await vi.advanceTimersByTimeAsync(3000);
    expect(watcher.cancelled).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(getRunStatus).toHaveBeenCalledWith("run-1");

    // Stops polling once cancelled
    await vi.advanceTimersByTimeAsync(9000);
    expect(getRunStatus).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("keeps polling (and stays un-cancelled) through transient errors", async () => {
    const getRunStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ status: "cancelled" });
    const watcher = new CancellationWatcher({
      client: createClient(getRunStatus),
      runId: "run-1",
      intervalMs: 1000,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.cancelled).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("ECONNRESET"));

    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.cancelled).toBe(true);
    watcher.stop();
  });

  it("check() polls immediately and shares an in-flight request", async () => {
    const getRunStatus = vi.fn().mockResolvedValue({ status: "cancelled" });
    const watcher = new CancellationWatcher({ client: createClient(getRunStatus), runId: "r" });

    const [a, b] = await Promise.all([watcher.check(), watcher.check()]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(getRunStatus).toHaveBeenCalledTimes(1);
    // Once cancelled, no further requests
    await watcher.check();
    expect(getRunStatus).toHaveBeenCalledTimes(1);
  });

  it("stop() halts polling", async () => {
    const getRunStatus = vi.fn().mockResolvedValue({ status: "running" });
    const watcher = new CancellationWatcher({
      client: createClient(getRunStatus),
      runId: "r",
      intervalMs: 1000,
    });

    watcher.start();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(getRunStatus).not.toHaveBeenCalled();
  });
});
