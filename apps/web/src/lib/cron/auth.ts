import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Authenticate a cron invocation (Vercel Cron, Supabase pg_cron/pg_net, or
 * any external scheduler) by `Authorization: Bearer <CRON_SECRET>`.
 * Returns an error response, or null when the caller is allowed.
 */
export function authorizeCronRequest(request: Request): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron] CRON_SECRET is not configured — refusing to run");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  // Compare fixed-length digests so neither length nor content leaks timing
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!presented || !timingSafeEqual(digest(presented), digest(cronSecret))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
