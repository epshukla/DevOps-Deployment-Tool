import { NextResponse } from "next/server";
import { HeartbeatSchema } from "@deployx/shared";
import { authenticateRunner } from "@/lib/auth/runner";

/**
 * POST /api/runner/heartbeat
 *
 * Called periodically by the runner (every HEARTBEAT_INTERVAL_MS = 10s).
 * Updates last_heartbeat_at and optionally system_info.
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRunner(request);
    if (!auth.ok) return auth.response;

    const { runner, supabase } = auth;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const parsed = HeartbeatSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const updates: Record<string, unknown> = {
      last_heartbeat_at: new Date().toISOString(),
      status: runner.current_job_id ? "busy" : "online",
    };

    if (parsed.data.system_info) {
      updates.system_info = parsed.data.system_info;
    }
    if (parsed.data.capabilities) {
      updates.capabilities = parsed.data.capabilities;
    }
    const metrics = parsed.data.metrics;
    if (metrics) {
      updates.metrics = metrics;
      updates.metrics_at = updates.last_heartbeat_at;
    }

    const { error } = await supabase
      .from("runner_registrations")
      .update(updates)
      .eq("id", runner.id);

    if (error) {
      return NextResponse.json(
        { error: "Failed to update heartbeat" },
        { status: 500 },
      );
    }

    // History for the usage charts; losing a sample isn't worth failing the heartbeat
    if (metrics) {
      const { error: historyError } = await supabase.from("runner_metrics").insert({
        runner_id: runner.id,
        org_id: runner.org_id,
        cpu_percent: metrics.cpu_percent,
        load_1m: metrics.load_1m,
        memory_used_mb: Math.round(metrics.memory_used_mb),
        memory_total_mb: Math.round(metrics.memory_total_mb),
        disk_used_gb: metrics.disk_used_gb,
        disk_total_gb: metrics.disk_total_gb,
        containers_running: metrics.containers_running,
        docker_cpu_percent: metrics.docker_cpu_percent,
        docker_memory_mb: metrics.docker_memory_mb === null ? null : Math.round(metrics.docker_memory_mb),
      });
      if (historyError) {
        console.error(`[api/runner/heartbeat] Failed to record metrics: ${historyError.message}`);
      }
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/runner/heartbeat] Unhandled error: ${message}`);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
