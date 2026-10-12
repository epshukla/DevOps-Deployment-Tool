import { describe, it, expect } from "vitest";
import {
  resolvePreviousImage,
  withPreviousImageLabel,
  readPreviousImage,
} from "../previous-image";
import type { ContainerInspection } from "../container-manager";

function inspection(
  image: string,
  labels: Record<string, string> = {},
): ContainerInspection {
  return { id: "abc", name: "deployx-myapp-blue", state: "running", image, labels };
}

describe("resolvePreviousImage", () => {
  it("returns null when nothing is being replaced", () => {
    expect(resolvePreviousImage(null, "myapp:v2")).toBeNull();
  });

  it("returns the outgoing image when it differs", () => {
    expect(resolvePreviousImage(inspection("myapp:v1"), "myapp:v2")).toBe("myapp:v1");
  });

  it("carries forward the outgoing label on a same-image redeploy", () => {
    const outgoing = inspection("myapp:v2", { "deployx.previousImage": "myapp:v1" });
    expect(resolvePreviousImage(outgoing, "myapp:v2")).toBe("myapp:v1");
  });

  it("returns null on a same-image redeploy with no recorded history", () => {
    expect(resolvePreviousImage(inspection("myapp:v2"), "myapp:v2")).toBeNull();
  });

  it("returns null when the outgoing image is unknown", () => {
    expect(resolvePreviousImage(inspection(""), "myapp:v2")).toBeNull();
  });
});

describe("withPreviousImageLabel", () => {
  it("adds the label without mutating the input", () => {
    const base = { "deployx.role": "app" };
    const result = withPreviousImageLabel(base, "myapp:v1");

    expect(result).toEqual({ "deployx.role": "app", "deployx.previousImage": "myapp:v1" });
    expect(base).toEqual({ "deployx.role": "app" });
  });

  it("omits the label when there is no previous image", () => {
    expect(withPreviousImageLabel({ a: "b" }, null)).toEqual({ a: "b" });
  });
});

describe("readPreviousImage", () => {
  it("reads the label or returns null", () => {
    expect(readPreviousImage(inspection("x", { "deployx.previousImage": "myapp:v1" }))).toBe("myapp:v1");
    expect(readPreviousImage(inspection("x"))).toBeNull();
    expect(readPreviousImage(null)).toBeNull();
  });
});
