import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────

const { mockSupabase, mockSwitchActiveOrg, mockRedirect, mockRevalidatePath } =
  vi.hoisted(() => ({
    mockSupabase: {
      auth: { getUser: vi.fn() },
      rpc: vi.fn(),
    },
    mockSwitchActiveOrg: vi.fn(),
    mockRedirect: vi.fn((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    }),
    mockRevalidatePath: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabase),
}));

vi.mock("@/lib/auth/org-actions", () => ({
  switchActiveOrg: mockSwitchActiveOrg,
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

import { acceptInviteLink, declineInviteLink } from "../actions";

const TOKEN = "0123456789abcdef".repeat(3);

function signedIn() {
  mockSupabase.auth.getUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "dev@acme.dev" } },
  });
}

// ── acceptInviteLink ───────────────────────────────────────────

describe("acceptInviteLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    signedIn();
    mockSwitchActiveOrg.mockResolvedValue({});
  });

  it("redeems the token, switches into the org and redirects home", async () => {
    mockSupabase.rpc.mockResolvedValue({ data: "org-9", error: null });

    await expect(acceptInviteLink(TOKEN)).rejects.toThrow("NEXT_REDIRECT:/");

    expect(mockSupabase.rpc).toHaveBeenCalledWith("accept_org_invite", {
      p_token: TOKEN,
    });
    expect(mockSwitchActiveOrg).toHaveBeenCalledWith("org-9");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("still redirects when switching the active org fails", async () => {
    mockSupabase.rpc.mockResolvedValue({ data: "org-9", error: null });
    mockSwitchActiveOrg.mockResolvedValue({ error: "nope" });

    await expect(acceptInviteLink(TOKEN)).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("rejects a malformed token without calling the database", async () => {
    const result = await acceptInviteLink("../../etc");

    expect(result.error).toMatch(/invalid/);
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it("asks a signed-out caller to sign in", async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } });

    const result = await acceptInviteLink(TOKEN);

    expect(result.error).toMatch(/sign in/i);
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["invite_expired", /expired/],
    ["invite_already_accepted", /already been used/],
    ["invite_not_found", /invalid/],
  ])("maps RPC error %s to a friendly message", async (code, pattern) => {
    mockSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: code, code: "P0001" },
    });

    const result = await acceptInviteLink(TOKEN);

    expect(result.error).toMatch(pattern);
    expect(mockSwitchActiveOrg).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("treats a missing org id as a failure", async () => {
    mockSupabase.rpc.mockResolvedValue({ data: null, error: null });

    const result = await acceptInviteLink(TOKEN);

    expect(result.error).toBeDefined();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ── declineInviteLink ──────────────────────────────────────────

describe("declineInviteLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    signedIn();
  });

  it("deletes the invite through the RPC", async () => {
    mockSupabase.rpc.mockResolvedValue({ data: null, error: null });

    const result = await declineInviteLink(TOKEN);

    expect(result).toEqual({ success: true });
    expect(mockSupabase.rpc).toHaveBeenCalledWith("decline_org_invite", {
      p_token: TOKEN,
    });
  });

  it("surfaces RPC errors", async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "invite_already_accepted" },
    });

    const result = await declineInviteLink(TOKEN);

    expect(result.error).toMatch(/already been used/);
  });

  it("requires a session", async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } });

    const result = await declineInviteLink(TOKEN);

    expect(result.error).toMatch(/sign in/i);
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });
});
