import { describe, it, expect } from "vitest";
import { resolveBuildPaths, parseRegistry } from "../image-builder";

describe("resolveBuildPaths", () => {
  const ws = "/tmp/deployx-ws";

  it("returns workspace-relative paths", () => {
    expect(resolveBuildPaths(ws, "Dockerfile", ".")).toEqual({ dockerfile: "Dockerfile", context: "." });
    expect(resolveBuildPaths(ws, "./docker/api.Dockerfile", "services/api")).toEqual({
      dockerfile: "docker/api.Dockerfile",
      context: "services/api",
    });
  });

  it("defaults empty values", () => {
    expect(resolveBuildPaths(ws, "", "")).toEqual({ dockerfile: "Dockerfile", context: "." });
  });

  it.each([
    ["../Dockerfile", "."],
    ["Dockerfile", "../.."],
    ["/etc/Dockerfile", "."],
    ["docker/../../x", "."],
  ])("rejects %s / %s escaping the workspace", (dockerfile, context) => {
    expect(resolveBuildPaths(ws, dockerfile, context)).toBeNull();
  });
});

describe("parseRegistry", () => {
  it("returns null when unset or blank", () => {
    expect(parseRegistry(undefined)).toBeNull();
    expect(parseRegistry("   ")).toBeNull();
  });

  it("splits host and namespace and trims trailing slashes", () => {
    expect(parseRegistry("ghcr.io/acme/team/")).toEqual({
      prefix: "ghcr.io/acme/team",
      host: "ghcr.io",
      namespace: "acme/team",
    });
  });

  it("handles a bare host with port", () => {
    expect(parseRegistry("registry.local:5000")).toEqual({
      prefix: "registry.local:5000",
      host: "registry.local:5000",
      namespace: "",
    });
  });
});
