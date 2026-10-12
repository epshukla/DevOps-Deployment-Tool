import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { authorizeCronRequest } from "@/lib/cron/auth";
import { dispatchDueSchedules } from "@/lib/cron/dispatch-schedules";

/**
 * GET /api/cron/schedules
 *
 * Dispatch due pipeline schedules only. Kept for existing scheduler configs;
 * new setups should call /api/cron/tick, which also runs the reaper and
 * alert evaluation.
 *
 * Authentication: Bearer token matching CRON_SECRET env var.
 */
export async function GET(request: Request) {
  const denied = authorizeCronRequest(request);
  if (denied) return denied;

  const result = await dispatchDueSchedules(createServiceClient());

  return NextResponse.json({
    processed: result.dispatched,
    total: result.due,
    ...(result.errors.length > 0 ? { errors: result.errors } : {}),
  });
}
