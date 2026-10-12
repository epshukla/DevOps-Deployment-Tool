import { describe, it, expect } from "vitest";
import {
  safeRedirectPath,
  buildAuthCallbackUrl,
  buildLoginPath,
} from "../safe-redirect";

describe("safeRedirectPath", () => {
  it.each([
    ["/", "/"],
    ["/invite/abc123", "/invite/abc123"],
    ["/projects/p1?tab=runs#latest", "/projects/p1?tab=runs#latest"],
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
  ])("keeps safe relative path %s", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  it.each([
    ["absolute https URL", "https://evil.com"],
    ["absolute http URL", "http://evil.com/invite/x"],
    ["javascript: URL", "javascript:alert(1)"],
    ["data: URL", "data:text/html,<script>alert(1)</script>"],
    ["protocol-relative", "//evil.com"],
    ["protocol-relative with path", "//evil.com/invite/x"],
    ["slash-backslash", "/\\evil.com"],
    ["double backslash", "\\\\evil.com"],
    ["backslash later in path", "/foo/..\\\\evil.com"],
    ["tab smuggling", "/\t/evil.com"],
    ["newline smuggling", "/\n/evil.com"],
    ["bare host", "evil.com"],
    ["relative without slash", "invite/x"],
    ["empty string", ""],
    ["whitespace prefix", " /invite"],
  ])("rejects %s", (_label, input) => {
    expect(safeRedirectPath(input)).toBe("/");
  });

  it("rejects null and undefined", () => {
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
  });

  it("rejects overly long values", () => {
    expect(safeRedirectPath(`/${"a".repeat(3000)}`)).toBe("/");
  });

  it("uses the provided fallback", () => {
    expect(safeRedirectPath("//evil.com", "/settings")).toBe("/settings");
  });

  it("normalises dot segments without leaving the origin", () => {
    expect(safeRedirectPath("/a/../../b")).toBe("/b");
  });
});

describe("buildAuthCallbackUrl", () => {
  const origin = "https://deployx.example";

  it("omits next when it is the root", () => {
    expect(buildAuthCallbackUrl(origin)).toBe(`${origin}/auth/callback`);
    expect(buildAuthCallbackUrl(origin, "/")).toBe(`${origin}/auth/callback`);
  });

  it("encodes a safe next path", () => {
    expect(buildAuthCallbackUrl(origin, "/invite/abc?x=1")).toBe(
      `${origin}/auth/callback?next=%2Finvite%2Fabc%3Fx%3D1`,
    );
  });

  it("drops an unsafe next", () => {
    expect(buildAuthCallbackUrl(origin, "//evil.com")).toBe(
      `${origin}/auth/callback`,
    );
  });
});

describe("buildLoginPath", () => {
  it("returns /login for the root or unsafe targets", () => {
    expect(buildLoginPath("/")).toBe("/login");
    expect(buildLoginPath("https://evil.com")).toBe("/login");
  });

  it("carries a safe next", () => {
    expect(buildLoginPath("/invite/tok")).toBe("/login?next=%2Finvite%2Ftok");
  });
});
