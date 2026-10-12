/**
 * Minimal thenable fake of the supabase-js query builder for unit tests.
 *
 * Every builder method is recorded and returns the same chain; awaiting the
 * chain calls `resolve(query)` so a test can answer based on the table, the
 * operation (select/insert/update/delete) and the filters actually applied.
 */

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface RecordedQuery {
  readonly table: string;
  readonly operation: "select" | "insert" | "update" | "delete" | "upsert";
  readonly payload: unknown;
  readonly calls: readonly RecordedCall[];
}

export interface QueryResult {
  readonly data?: unknown;
  readonly error?: { readonly message: string; readonly code?: string } | null;
  readonly count?: number | null;
}

export type Resolver = (query: RecordedQuery) => QueryResult;

const CHAIN_METHODS = [
  "select", "eq", "neq", "in", "is", "or", "lt", "lte", "gt", "gte", "like",
  "ilike", "order", "limit", "range", "match", "not", "filter",
] as const;

export function createFakeSupabase(resolve: Resolver) {
  const queries: RecordedQuery[] = [];

  function from(table: string) {
    const calls: RecordedCall[] = [];
    let operation: RecordedQuery["operation"] = "select";
    let payload: unknown = undefined;

    const finish = (): QueryResult => {
      const query: RecordedQuery = { table, operation, payload, calls: [...calls] };
      queries.push(query);
      const result = resolve(query);
      return { data: result.data ?? null, error: result.error ?? null, count: result.count ?? null };
    };

    const chain: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return chain;
      };
    }
    for (const op of ["insert", "update", "delete", "upsert"] as const) {
      chain[op] = (value?: unknown) => {
        operation = op;
        payload = value;
        return chain;
      };
    }
    chain.single = () => Promise.resolve(finish());
    chain.maybeSingle = () => Promise.resolve(finish());
    chain.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(finish()).then(onFulfilled, onRejected);
    return chain;
  }

  return { client: { from } as unknown as import("@supabase/supabase-js").SupabaseClient, queries };
}

/** Find the value passed to `.eq(column, value)` in a recorded query. */
export function eqValue(query: RecordedQuery, column: string): unknown {
  return query.calls.find((c) => c.method === "eq" && c.args[0] === column)?.args[1];
}
