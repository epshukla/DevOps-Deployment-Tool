import { describe, it, expect } from "vitest";
import {
  isPlausibleInviteToken,
  invitePath,
  inviteUrl,
  isInviteExpired,
  parseInvitePreview,
} from "../invite-links";
import { sendInviteEmail, inviteErrorMessage } from "../invites";

const TOKEN = "a".repeat(48);

describe("isPlausibleInviteToken", () => {
  it("accepts a 48-char hex token", () => {
    expect(isPlausibleInviteToken("0123456789abcdef".repeat(3))).toBe(true);
  });

  it.each([
    ["too short", "abc"],
    ["too long", "a".repeat(129)],
    ["path traversal", "../../etc/passwd"],
    ["sql-ish", "' or 1=1 --"],
    ["empty", ""],
  ])("rejects %s", (_label, token) => {
    expect(isPlausibleInviteToken(token)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isPlausibleInviteToken(undefined)).toBe(false);
    expect(isPlausibleInviteToken(42)).toBe(false);
  });
});

describe("invitePath / inviteUrl", () => {
  it("builds the landing page path", () => {
    expect(invitePath(TOKEN)).toBe(`/invite/${TOKEN}`);
  });

  it("joins origin and path without double slashes", () => {
    expect(inviteUrl("https://app.example/", TOKEN)).toBe(
      `https://app.example/invite/${TOKEN}`,
    );
  });
});

describe("isInviteExpired", () => {
  const now = new Date("2026-10-12T12:00:00Z");

  it("is false for a future expiry", () => {
    expect(isInviteExpired("2026-10-19T12:00:00Z", now)).toBe(false);
  });

  it("is true at or after expiry", () => {
    expect(isInviteExpired("2026-10-12T12:00:00Z", now)).toBe(true);
    expect(isInviteExpired("2026-10-01T00:00:00Z", now)).toBe(true);
  });

  it("treats an unparseable date as expired", () => {
    expect(isInviteExpired("not-a-date", now)).toBe(true);
  });
});

describe("parseInvitePreview", () => {
  const row = {
    org_name: "Acme",
    role: "developer",
    email: "al•••@acme.dev",
    expires_at: "2026-10-19T12:00:00+00:00",
    status: "pending",
  };

  it("reads the first row of a set-returning RPC result", () => {
    expect(parseInvitePreview([row])).toEqual(row);
  });

  it("accepts a single object", () => {
    expect(parseInvitePreview(row)).toEqual(row);
  });

  it.each([
    ["null", null],
    ["empty array", []],
    ["unknown status", [{ ...row, status: "revoked" }]],
    ["missing org name", [{ ...row, org_name: undefined }]],
  ])("returns null for %s", (_label, data) => {
    expect(parseInvitePreview(data)).toBeNull();
  });
});

describe("sendInviteEmail", () => {
  it("is a documented no-op until email is configured", async () => {
    const result = await sendInviteEmail({
      email: "a@b.dev",
      orgName: "Acme",
      role: "viewer",
      token: TOKEN,
      expiresAt: "2026-10-19T12:00:00Z",
    });
    expect(result).toEqual({ sent: false, reason: "email not configured" });
  });
});

describe("inviteErrorMessage", () => {
  it.each([
    ["invite_expired", /expired/],
    ["invite_already_accepted", /already been used/],
    ["invite_not_found", /invalid or has been cancelled/],
    ["invite_email_mismatch", /not addressed to your email/],
    ["not_authenticated", /sign in/],
  ])("maps %s", (code, pattern) => {
    expect(inviteErrorMessage({ message: code })).toMatch(pattern);
  });

  it("falls back for unknown or missing errors without leaking details", () => {
    expect(inviteErrorMessage({ message: "relation does not exist" })).toBe(
      "Something went wrong. Please try again.",
    );
    expect(inviteErrorMessage(null)).toBe("Something went wrong. Please try again.");
  });
});
