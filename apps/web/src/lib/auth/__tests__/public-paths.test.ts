import { describe, it, expect } from "vitest";
import { isPublicPath } from "../public-paths";

describe("isPublicPath", () => {
  it.each([
    "/login",
    "/auth/callback",
    "/invite/0123456789abcdef0123",
    "/invite",
  ])("allows %s without a session", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/settings",
    "/projects/p1",
    "/invites-admin",
    "/loginx",
    "/authority",
  ])("protects %s", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});
