import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LogStreamer } from "../log-streamer";
import type { RunnerApiClient } from "../../api-client";

function createMockClient(): RunnerApiClient {
  return {
    sendLogs: vi.fn().mockResolvedValue(undefined),
  } as unknown as RunnerApiClient;
}

describe("LogStreamer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("buffers entries and flushes on shutdown", async () => {
    const client = createMockClient();
    const streamer = new LogStreamer({
      client,
      runId: "run-1",
      flushIntervalMs: 1000,
    });

    streamer.push({ level: "info", message: "line 1" });
    streamer.push({ level: "info", message: "line 2" });

    // Not flushed yet
    expect(client.sendLogs).not.toHaveBeenCalled();

    await streamer.shutdown();

    expect(client.sendLogs).toHaveBeenCalledTimes(1);
    expect(client.sendLogs).toHaveBeenCalledWith("run-1", [
      expect.objectContaining({ level: "info", message: "line 1" }),
      expect.objectContaining({ level: "info", message: "line 2" }),
    ]);
  });

  it("auto-flushes when batch size is reached", async () => {
    const client = createMockClient();
    const streamer = new LogStreamer({
      client,
      runId: "run-1",
      maxBatchSize: 3,
      flushIntervalMs: 60_000, // Long interval so timer doesn't fire
    });

    streamer.push({ level: "info", message: "1" });
    streamer.push({ level: "info", message: "2" });
    streamer.push({ level: "info", message: "3" }); // Triggers flush

    // flush() is called via void (fire-and-forget), need to wait for microtask
    await vi.advanceTimersByTimeAsync(0);

    expect(client.sendLogs).toHaveBeenCalledTimes(1);

    await streamer.shutdown();
  });

  it("flushes on timer interval", async () => {
    const client = createMockClient();
    const streamer = new LogStreamer({
      client,
      runId: "run-1",
      flushIntervalMs: 500,
    });

    streamer.push({ level: "info", message: "hello" });

    await vi.advanceTimersByTimeAsync(500);

    expect(client.sendLogs).toHaveBeenCalledTimes(1);

    await streamer.shutdown();
  });

  it("adds timestamp to entries without one", async () => {
    const client = createMockClient();
    const streamer = new LogStreamer({
      client,
      runId: "run-1",
      flushIntervalMs: 60_000,
    });

    streamer.push({ level: "info", message: "auto-ts" });
    await streamer.shutdown();

    const sentLogs = (client.sendLogs as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentLogs[0].timestamp).toBeDefined();
    expect(typeof sentLogs[0].timestamp).toBe("string");
  });

  it("preserves provided timestamp", async () => {
    const client = createMockClient();
    const streamer = new LogStreamer({
      client,
      runId: "run-1",
      flushIntervalMs: 60_000,
    });

    const ts = "2025-01-01T00:00:00.000Z";
    streamer.push({ level: "info", message: "custom-ts", timestamp: ts });
    await streamer.shutdown();

    const sentLogs = (client.sendLogs as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentLogs[0].timestamp).toBe(ts);
  });

  it("does not crash when sendLogs fails", async () => {
    const client = createMockClient();
    (client.sendLogs as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const streamer = new LogStreamer({
      client,
      runId: "run-1",
      flushIntervalMs: 60_000,
    });

    streamer.push({ level: "info", message: "will fail" });
    await streamer.shutdown();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Log flush failed"),
    );
  });

  it("does not flush when buffer is empty", async () => {
    const client = createMockClient();
    const streamer = new LogStreamer({
      client,
      runId: "run-1",
      flushIntervalMs: 60_000,
    });

    await streamer.shutdown();

    expect(client.sendLogs).not.toHaveBeenCalled();
  });
});

describe("secret masking", () => {
  it("masks registered secret values, longest first, ignoring very short ones", async () => {
    const { maskSecrets } = await import("../log-streamer");
    expect(maskSecrets("token=abcd1234 and abcd", ["abcd1234", "abcd"])).toBe("token=*** and ***");
    expect(maskSecrets("nothing here", ["secret"])).toBe("nothing here");
  });

  it("masks lines pushed after addMaskedValues", async () => {
    const { LogStreamer } = await import("../log-streamer");
    const sendLogs = vi.fn().mockResolvedValue(undefined);
    const streamer = new LogStreamer({ client: { sendLogs } as never, runId: "r", flushIntervalMs: 60_000 });
    streamer.addMaskedValues(["s3cr3t-value", "on", undefined]);
    streamer.push({ level: "info", message: "echo s3cr3t-value; flag on" });
    await streamer.flush();
    expect(sendLogs.mock.calls[0][1][0].message).toBe("echo ***; flag on");
    await streamer.shutdown?.();
  });
});
