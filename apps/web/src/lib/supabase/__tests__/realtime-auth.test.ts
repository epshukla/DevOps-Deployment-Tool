import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeRealtime } from "../realtime-auth";

function fakeClient(getSession: () => Promise<unknown>) {
  const setAuth = vi.fn().mockResolvedValue(undefined);
  const client = { auth: { getSession }, realtime: { setAuth } } as unknown as SupabaseClient;
  return { client, setAuth };
}

describe("authorizeRealtime", () => {
  it("hands the session's access token to realtime before subscribing", async () => {
    const { client, setAuth } = fakeClient(async () => ({
      data: { session: { access_token: "user-jwt" } },
      error: null,
    }));

    await authorizeRealtime(client);

    expect(setAuth).toHaveBeenCalledWith("user-jwt");
  });

  it("leaves realtime alone when signed out", async () => {
    const { client, setAuth } = fakeClient(async () => ({ data: { session: null }, error: null }));
    await authorizeRealtime(client);
    expect(setAuth).not.toHaveBeenCalled();
  });

  it("never throws, so subscribing still goes ahead", async () => {
    const { client, setAuth } = fakeClient(async () => {
      throw new Error("storage unavailable");
    });
    await expect(authorizeRealtime(client)).resolves.toBeUndefined();
    expect(setAuth).not.toHaveBeenCalled();
  });
});
