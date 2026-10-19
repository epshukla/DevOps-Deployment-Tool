import { describe, it, expect } from "vitest";
import { expirePublicUrls } from "../expire-public-urls";
import { createFakeSupabase } from "../../__tests__/helpers/fake-supabase";

describe("expirePublicUrls", () => {
  it("clears only URLs whose expiry has passed", async () => {
    const { client, queries } = createFakeSupabase(() => ({ data: [{ id: "d1" }, { id: "d2" }] }));

    const result = await expirePublicUrls(client, new Date("2026-10-20T10:00:00Z"));

    expect(result).toEqual({ cleared: 2 });
    const q = queries[0];
    expect(q.operation).toBe("update");
    expect(q.payload).toEqual({ public_url: null, public_url_expires_at: null });
    expect(q.calls).toContainEqual({ method: "lte", args: ["public_url_expires_at", "2026-10-20T10:00:00.000Z"] });
  });

  it("reports errors without throwing", async () => {
    const { client } = createFakeSupabase(() => ({ error: { message: "nope" } }));
    expect(await expirePublicUrls(client)).toEqual({ cleared: 0, error: "nope" });
  });
});
