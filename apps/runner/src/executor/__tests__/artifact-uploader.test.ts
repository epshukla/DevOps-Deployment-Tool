import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadTaskArtifacts } from "../artifact-uploader";
import type { RunnerApiClient } from "../../api-client";
import type { LogStreamer } from "../../logging/log-streamer";

// Shrink the size limit so the test doesn't need 50MB files
vi.mock("@deployx/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@deployx/shared")>()),
  ARTIFACT_MAX_SIZE_BYTES: 64,
  ARTIFACT_MAX_FILES_PER_TASK: 3,
}));

describe("uploadTaskArtifacts", () => {
  let root: string;
  let workspace: string;
  let outside: string;
  let uploadArtifact: ReturnType<typeof vi.fn>;
  let logStreamer: LogStreamer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "artifacts-test-"));
    workspace = join(root, "ws");
    outside = join(root, "outside");
    await mkdir(join(workspace, "dist", "nested"), { recursive: true });
    await mkdir(outside);
    uploadArtifact = vi.fn(async (_runId: string, a: { filename: string }) => ({
      path: `org/proj/run-1/${a.filename}`,
    }));
    logStreamer = { push: vi.fn() } as unknown as LogStreamer;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function upload(patterns: string[]) {
    return uploadTaskArtifacts({
      client: { uploadArtifact } as unknown as RunnerApiClient,
      runId: "run-1",
      projectId: "proj-1",
      workspacePath: workspace,
      patterns,
      logStreamer,
      taskName: "build",
      taskRunId: "tr-1",
    });
  }

  function messages(): string[] {
    return vi.mocked(logStreamer.push).mock.calls.map(([e]) => e.message);
  }

  it("uploads files matched by a glob with their basename", async () => {
    await writeFile(join(workspace, "dist", "app.zip"), "zip");
    await writeFile(join(workspace, "dist", "nested", "lib.jar"), "jar");

    const summary = await upload(["dist/**/*.{zip,jar}"]);

    expect(summary).toEqual({ uploaded: 2, failed: 0, skipped: 0 });
    const filenames = uploadArtifact.mock.calls.map(([, a]) => a.filename).sort();
    expect(filenames).toEqual(["app.zip", "lib.jar"]);
    const [runId, payload] = uploadArtifact.mock.calls.find(([, a]) => a.filename === "app.zip")!;
    expect(runId).toBe("run-1");
    expect(payload.projectId).toBe("proj-1");
    expect(Buffer.from(payload.content).toString()).toBe("zip");
  });

  it("never uploads files that resolve outside the workspace", async () => {
    await writeFile(join(outside, "secret.log"), "secret");
    await symlink(join(outside, "secret.log"), join(workspace, "dist", "leak.log"));
    await symlink(outside, join(workspace, "linked"));

    // Symlinked files aren't matched; an explicit path through a symlinked
    // directory is matched but rejected by the realpath check
    const summary = await upload(["dist/*.log", "dist/leak.log", "linked/*.log", "**/*.log"]);

    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(summary).toEqual({ uploaded: 0, failed: 0, skipped: 1 });
    expect(messages().some((m) => m.includes("secret.log: resolves outside the workspace"))).toBe(true);
  });

  it("ignores traversal and absolute patterns", async () => {
    await writeFile(join(outside, "x.zip"), "x");

    await upload(["../outside/x.zip", `${outside}/x.zip`]);

    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(messages().filter((m) => m.includes("Ignoring pattern"))).toHaveLength(2);
  });

  it("skips disallowed extensions and oversized files", async () => {
    await writeFile(join(workspace, "dist", "run.sh"), "echo");
    await writeFile(join(workspace, "dist", "big.zip"), "x".repeat(65));
    await writeFile(join(workspace, "dist", "ok.zip"), "x".repeat(64));

    const summary = await upload(["dist/*"]);

    expect(uploadArtifact.mock.calls.map(([, a]) => a.filename)).toEqual(["ok.zip"]);
    expect(summary).toEqual({ uploaded: 1, failed: 0, skipped: 2 });
    expect(messages().some((m) => m.includes("extension not allowed"))).toBe(true);
    expect(messages().some((m) => m.includes("exceeds"))).toBe(true);
  });

  it("logs and continues when a single upload fails", async () => {
    await writeFile(join(workspace, "dist", "a.zip"), "a");
    await writeFile(join(workspace, "dist", "b.zip"), "b");
    uploadArtifact.mockRejectedValueOnce(new Error("API error 500: Upload failed"));

    const summary = await upload(["dist/*.zip"]);

    expect(uploadArtifact).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ uploaded: 1, failed: 1, skipped: 0 });
    expect(messages().some((m) => m.includes("API error 500"))).toBe(true);
  });

  it("warns when a pattern matches nothing", async () => {
    const summary = await upload(["dist/*.whl"]);

    expect(summary).toEqual({ uploaded: 0, failed: 0, skipped: 0 });
    expect(messages()).toContain('[artifacts:build] No files matched "dist/*.whl"');
  });

  it("enforces the per-task file cap and duplicate names", async () => {
    for (const name of ["a.zip", "b.zip", "c.zip", "d.zip"]) {
      await writeFile(join(workspace, "dist", name), name);
    }
    await writeFile(join(workspace, "dist", "nested", "a.zip"), "dup");

    const summary = await upload(["dist/*.zip", "dist/nested/*.zip"]);

    expect(uploadArtifact).toHaveBeenCalledTimes(3);
    expect(summary.skipped).toBe(2);
    expect(messages().some((m) => m.includes("per-task limit"))).toBe(true);
    expect(messages().some((m) => m.includes("already selected"))).toBe(true);
  });
});
