import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { authorizeCronRequest } from "@/lib/cron/auth";
import { dispatchDueSchedules } from "@/lib/cron/dispatch-schedules";
import { reapOrphans } from "@/lib/cron/reap-orphans";
import { evaluateAlerts } from "@/lib/cron/evaluate-alerts";
import { expirePublicUrls } from "@/lib/cron/expire-public-urls";
import { pruneRunnerMetrics } from "@/lib/cron/prune-runner-metrics";
import { expireDocuments } from "@/lib/cron/expire-documents";

/**
 * GET|POST /api/cron/tick
 *
 * The platform's single heartbeat, meant to be called once a minute
 * (Supabase pg_cron + pg_net, Vercel Cron on a plan that allows it, or any
 * external scheduler) with `Authorization: Bearer $CRON_SECRET`.
 *
 * 1. Dispatch due pipeline schedules
 * 2. Mark dead runners offline and time out runs they orphaned
 * 3. Evaluate alert rules and notify
 * 4. Clear expired temporary public URLs
 * 5. Prune runner metrics; apply document lifecycle (expiry, abandoned uploads)
 *
 * Each job is idempotent and isolated: one failing doesn't skip the others.
 */
async function tick(request: Request) {
  const denied = authorizeCronRequest(request);
  if (denied) return denied;

  const supabase = createServiceClient();
  const now = new Date();

  const [schedules, reaper, alerts, publicUrls, runnerMetrics, documents] = await Promise.allSettled([
    dispatchDueSchedules(supabase, now),
    reapOrphans(supabase, now),
    evaluateAlerts(supabase, now),
    expirePublicUrls(supabase, now),
    pruneRunnerMetrics(supabase, now),
    expireDocuments(supabase, now),
  ]);

  const summarize = <T,>(result: PromiseSettledResult<T>) =>
    result.status === "fulfilled"
      ? result.value
      : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };

  const body = {
    ran_at: now.toISOString(),
    schedules: summarize(schedules),
    reaper: summarize(reaper),
    alerts: summarize(alerts),
    public_urls: summarize(publicUrls),
    runner_metrics: summarize(runnerMetrics),
    documents: summarize(documents),
  };

  const failed = [schedules, reaper, alerts, publicUrls, runnerMetrics, documents].some((r) => r.status === "rejected");
  if (failed) console.error("[cron/tick] one or more jobs failed", body);

  return NextResponse.json(body, { status: failed ? 500 : 200 });
}

export const GET = tick;
export const POST = tick;
