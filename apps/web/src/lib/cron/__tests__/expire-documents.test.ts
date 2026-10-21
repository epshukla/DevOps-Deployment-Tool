import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expireDocuments } from "../expire-documents";
import { createFakeSupabase, type RecordedQuery } from "../../__tests__/helpers/fake-supabase";

function withStorage(resolve: (q: RecordedQuery) => { data?: unknown; error?: { message: string } }) {
  const fake = createFakeSupabase(resolve);
  const remove = vi.fn().mockResolvedValue({ error: null });
  const client = {
    from: fake.client.from.bind(fake.client),
    storage: { from: () => ({ remove }) },
  } as unknown as SupabaseClient;
  return { client, queries: fake.queries, remove };
}

const hasCall = (q: RecordedQuery, method: string, column: string) =>
  q.calls.some((c) => c.method === method && c.args[0] === column);

describe("expireDocuments", () => {
  it("removes every version of an expired path, objects first", async () => {
    const { client, queries, remove } = withStorage((q) => {
      if (q.operation === "select" && hasCall(q, "lte", "expires_at")) {
        return { data: [{ id: "v2", project_id: "p", path: "a.pdf", storage_key: "o/p/v2" }] };
      }
      if (q.operation === "select" && hasCall(q, "eq", "path")) {
        return {
          data: [
            { id: "v1", project_id: "p", path: "a.pdf", storage_key: "o/p/v1" },
            { id: "v2", project_id: "p", path: "a.pdf", storage_key: "o/p/v2" },
          ],
        };
      }
      return { data: [] };
    });

    const result = await expireDocuments(client, new Date("2026-10-21T00:00:00Z"));

    expect(result).toEqual({ expired: 1, abandoned: 0 });
    expect(remove).toHaveBeenCalledWith(["o/p/v1", "o/p/v2"]);
    const del = queries.find((q) => q.operation === "delete");
    expect(del?.calls).toContainEqual({ method: "in", args: ["id", ["v1", "v2"]] });
  });

  it("clears uploads that were never finalized", async () => {
    const { client, remove } = withStorage((q) => {
      if (q.operation === "select" && hasCall(q, "eq", "status")) {
        return { data: [{ id: "x", project_id: "p", path: "b", storage_key: "o/p/x" }] };
      }
      return { data: [] };
    });

    const result = await expireDocuments(client, new Date("2026-10-21T00:00:00Z"));

    expect(result.abandoned).toBe(1);
    expect(remove).toHaveBeenCalledWith(["o/p/x"]);
  });

  it("reports query errors without throwing", async () => {
    const { client } = withStorage(() => ({ error: { message: "down" } }));
    expect(await expireDocuments(client)).toEqual({ expired: 0, abandoned: 0, error: "down" });
  });
});
