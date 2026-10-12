import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForApproval } from "../approval-gate";
import type { RunnerApiClient } from "../../api-client";
import type { LogStreamer } from "../../logging/log-streamer";

function setup(getApprovalStatus: ReturnType<typeof vi.fn>) {
  const controller = new AbortController();
  const logStreamer = { push: vi.fn() } as unknown as LogStreamer;
  const promise = waitForApproval({
    client: { getApprovalStatus } as unknown as RunnerApiClient,
    runId: "run-1",
    taskName: "deploy",
    signal: controller.signal,
    logStreamer,
    taskRunId: "tr-1",
    intervalMs: 5000,
  });
  return { controller, logStreamer, promise };
}

describe("waitForApproval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls until approved", async () => {
    const getApprovalStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "approved" });
    const { promise } = setup(getApprovalStatus);

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).resolves.toBe("approved");
    expect(getApprovalStatus).toHaveBeenCalledTimes(3);
    expect(getApprovalStatus).toHaveBeenCalledWith("run-1", "deploy");
  });

  it("returns rejected", async () => {
    const { promise } = setup(vi.fn().mockResolvedValue({ status: "rejected" }));
    await expect(promise).resolves.toBe("rejected");
  });

  it("waits the poll interval between checks", async () => {
    const getApprovalStatus = vi.fn().mockResolvedValue({ status: "pending" });
    const { controller, promise } = setup(getApprovalStatus);

    await vi.advanceTimersByTimeAsync(4999);
    expect(getApprovalStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getApprovalStatus).toHaveBeenCalledTimes(2);

    controller.abort();
    await promise;
  });

  it("logs transient errors and keeps polling", async () => {
    const getApprovalStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("API error 502: Bad Gateway"))
      .mockResolvedValueOnce({ status: "approved" });
    const { logStreamer, promise } = setup(getApprovalStatus);

    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toBe("approved");
    expect(logStreamer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("API error 502"),
        task_run_id: "tr-1",
      }),
    );
  });

  it("stops waiting immediately when the run is cancelled", async () => {
    const getApprovalStatus = vi.fn().mockResolvedValue({ status: "pending" });
    const { controller, promise } = setup(getApprovalStatus);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(promise).resolves.toBe("cancelled");
    expect(getApprovalStatus).toHaveBeenCalledTimes(1);
  });
});
