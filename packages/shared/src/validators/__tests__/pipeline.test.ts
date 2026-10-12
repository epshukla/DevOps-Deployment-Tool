import { describe, it, expect } from "vitest";
import { TaskConfigSchema, isSafeArtifactPattern } from "../pipeline";

const baseTask = {
  steps: [{ name: "build", command: "npm run build" }],
};

describe("TaskConfigSchema.artifacts", () => {
  it("is optional", () => {
    const result = TaskConfigSchema.safeParse(baseTask);
    expect(result.success).toBe(true);
    expect(result.success && result.data.artifacts).toBeUndefined();
  });

  it("accepts relative paths and globs", () => {
    const result = TaskConfigSchema.safeParse({
      ...baseTask,
      artifacts: ["dist/app.tar.gz", "build/**/*.jar", "./logs/*.log", "release-?.zip"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 20 entries", () => {
    const artifacts = Array.from({ length: 21 }, (_, i) => `dist/a${i}.zip`);
    expect(TaskConfigSchema.safeParse({ ...baseTask, artifacts }).success).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(TaskConfigSchema.safeParse({ ...baseTask, artifacts: [""] }).success).toBe(false);
  });

  it.each([
    "/etc/passwd",
    "\\\\server\\share\\x.zip",
    "C:\\build\\out.zip",
    "c:/build/out.zip",
    "../secrets.tar.gz",
    "dist/../../outside.zip",
    "dist\\..\\..\\outside.zip",
    "..",
    "~/.ssh/id_rsa",
    "!dist/*.zip",
    "dist/\0.zip",
  ])("rejects unsafe pattern %j", (pattern) => {
    expect(isSafeArtifactPattern(pattern)).toBe(false);
    expect(TaskConfigSchema.safeParse({ ...baseTask, artifacts: [pattern] }).success).toBe(false);
  });

  it.each(["dist/app.zip", "a..b/file.log", "dist/v1..2.tar.gz", "**/*.whl"])(
    "accepts safe pattern %j",
    (pattern) => {
      expect(isSafeArtifactPattern(pattern)).toBe(true);
    },
  );
});
