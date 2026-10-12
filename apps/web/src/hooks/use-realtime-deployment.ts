"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

// ── Types ───────────────────────────────────────────────────────

interface DeploymentData {
  readonly id: string;
  readonly project_id: string;
  readonly pipeline_run_id: string | null;
  readonly status: string;
  readonly strategy: string;
  readonly deploy_target: string;
  readonly current_revision_id: string | null;
  readonly health_status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RevisionData {
  readonly id: string;
  readonly deployment_id: string;
  readonly revision_number: number;
  readonly image_tag: string;
  readonly image_digest: string | null;
  readonly status: string;
  readonly rollback_reason: string | null;
  readonly created_at: string;
}

interface HealthCheckData {
  readonly id: string;
  readonly status: string;
  readonly response_time_ms: number | null;
  readonly status_code: number | null;
  readonly error_message: string | null;
  readonly checked_at: string;
}

interface HealingEventData {
  readonly id: string;
  readonly event_type: string;
  readonly attempt_number: number | null;
  readonly container_name: string | null;
  readonly details: Record<string, unknown> | null;
  readonly created_at: string;
}

interface UseRealtimeDeploymentOptions {
  readonly deploymentId: string;
  readonly initialDeployment: DeploymentData;
  readonly initialRevisions: readonly RevisionData[];
  readonly initialHealthChecks: readonly HealthCheckData[];
  readonly initialHealingEvents: readonly HealingEventData[];
  readonly enabled?: boolean;
}

interface UseRealtimeDeploymentResult {
  readonly deployment: DeploymentData;
  readonly revisions: readonly RevisionData[];
  readonly healthChecks: readonly HealthCheckData[];
  readonly healingEvents: readonly HealingEventData[];
}

const TERMINAL_STATUSES = new Set(["stopped", "rolled_back", "failed"]);
const MAX_HEALTH_CHECKS = 50;
const MAX_HEALING_EVENTS = 20;

/**
 * Subscribes to live updates for a single deployment: status/health changes,
 * new health checks, new healing events, revision inserts/updates, and a
 * broad refresh signal for approval changes (those tables aren't keyed by
 * deployment_id, so we can't filter them server-side).
 *
 * Mirrors the channel/cleanup pattern of useRealtimeRun.
 */
export function useRealtimeDeployment({
  deploymentId,
  initialDeployment,
  initialRevisions,
  initialHealthChecks,
  initialHealingEvents,
  enabled = true,
}: UseRealtimeDeploymentOptions): UseRealtimeDeploymentResult {
  const router = useRouter();
  const [deployment, setDeployment] = useState<DeploymentData>(initialDeployment);
  const [revisions, setRevisions] = useState<readonly RevisionData[]>(initialRevisions);
  const [healthChecks, setHealthChecks] = useState<readonly HealthCheckData[]>(initialHealthChecks);
  const [healingEvents, setHealingEvents] = useState<readonly HealingEventData[]>(initialHealingEvents);

  const shouldSubscribe = enabled && !TERMINAL_STATUSES.has(initialDeployment.status);

  useEffect(() => {
    if (!shouldSubscribe) return;

    const supabase = createClient();
    const channels: RealtimeChannel[] = [];

    // Channel 1: deployment status/health updates
    const deploymentChannel = supabase
      .channel(`deployment:${deploymentId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "deployments",
          filter: `id=eq.${deploymentId}`,
        },
        (payload) => {
          const updated = payload.new as Record<string, unknown>;
          setDeployment((prev) => ({
            ...prev,
            status: (updated.status as string) ?? prev.status,
            health_status: (updated.health_status as string) ?? prev.health_status,
            current_revision_id:
              (updated.current_revision_id as string | null) ?? prev.current_revision_id,
            updated_at: (updated.updated_at as string) ?? prev.updated_at,
          }));

          if (TERMINAL_STATUSES.has(updated.status as string)) {
            for (const ch of channels) supabase.removeChannel(ch);
          }
        },
      )
      .subscribe();
    channels.push(deploymentChannel);

    // Channel 2: new health check results
    const healthChannel = supabase
      .channel(`deployment-health:${deploymentId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "health_check_results",
          filter: `deployment_id=eq.${deploymentId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          if (!row.id) return;

          const entry: HealthCheckData = {
            id: row.id as string,
            status: (row.status as string) ?? "fail",
            response_time_ms: (row.response_time_ms as number | null) ?? null,
            status_code: (row.status_code as number | null) ?? null,
            error_message: (row.error_message as string | null) ?? null,
            checked_at: (row.checked_at as string) ?? new Date().toISOString(),
          };

          // Most-recent-first, capped — matches the initial server query.
          setHealthChecks((prev) => [entry, ...prev].slice(0, MAX_HEALTH_CHECKS));
        },
      )
      .subscribe();
    channels.push(healthChannel);

    // Channel 3: new healing events
    const healingChannel = supabase
      .channel(`deployment-healing:${deploymentId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "healing_events",
          filter: `deployment_id=eq.${deploymentId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          if (!row.id) return;

          const entry: HealingEventData = {
            id: row.id as string,
            event_type: (row.event_type as string) ?? "unknown",
            attempt_number: (row.attempt_number as number | null) ?? null,
            container_name: (row.container_name as string | null) ?? null,
            details: (row.details as Record<string, unknown> | null) ?? null,
            created_at: (row.created_at as string) ?? new Date().toISOString(),
          };

          setHealingEvents((prev) => [entry, ...prev].slice(0, MAX_HEALING_EVENTS));
        },
      )
      .subscribe();
    channels.push(healingChannel);

    // Channel 4: revision inserts/updates (e.g. rollback_reason being set)
    const revisionChannel = supabase
      .channel(`deployment-revisions:${deploymentId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "deployment_revisions",
          filter: `deployment_id=eq.${deploymentId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          if (!row.id) return;

          const entry: RevisionData = {
            id: row.id as string,
            deployment_id: (row.deployment_id as string) ?? deploymentId,
            revision_number: (row.revision_number as number) ?? 0,
            image_tag: (row.image_tag as string) ?? "",
            image_digest: (row.image_digest as string | null) ?? null,
            status: (row.status as string) ?? "pending",
            rollback_reason: (row.rollback_reason as string | null) ?? null,
            created_at: (row.created_at as string) ?? new Date().toISOString(),
          };

          setRevisions((prev) => {
            const existingIndex = prev.findIndex((r) => r.id === entry.id);
            const next =
              existingIndex >= 0
                ? prev.map((r, i) => (i === existingIndex ? entry : r))
                : [entry, ...prev];
            return [...next].sort((a, b) => b.revision_number - a.revision_number);
          });
        },
      )
      .subscribe();
    channels.push(revisionChannel);

    // Channel 5: approval tables aren't keyed by deployment_id, so we can't
    // filter server-side — a full page refresh on any change is acceptable
    // and keeps the (server-rendered) approval card consistent.
    const approvalChannel = supabase
      .channel(`deployment-approvals:${deploymentId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "deployment_approvals" },
        () => router.refresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "approval_votes" },
        () => router.refresh(),
      )
      .subscribe();
    channels.push(approvalChannel);

    return () => {
      for (const ch of channels) {
        supabase.removeChannel(ch);
      }
    };
  }, [deploymentId, shouldSubscribe, router]);

  return { deployment, revisions, healthChecks, healingEvents };
}
