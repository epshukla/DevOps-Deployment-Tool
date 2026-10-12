"use client";

import { useEffect, useState, useTransition } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { useRouter } from "next/navigation";
import { hasMinRole } from "@deployx/shared";
import { formatDateShort } from "@/lib/format-date";
import { getRunnerDisplayStatus, formatLastSeen } from "@/lib/runner-status";
import { revokeRunner } from "./actions";

interface RunnerRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly current_job_id: string | null;
  readonly last_heartbeat_at: string | null;
  readonly system_info: { os?: string; arch?: string } | null;
  readonly capabilities: readonly string[];
  readonly created_at: string;
}

interface RunnersTableProps {
  readonly runners: readonly RunnerRow[];
  readonly currentRole: string;
}


// Recompute derived status/last-seen periodically so the table doesn't
// silently go stale between page loads.
const TICK_INTERVAL_MS = 10_000;

export function RunnersTable({ runners, currentRole }: RunnersTableProps) {
  const [now, setNow] = useState(() => new Date());
  const [revokeTarget, setRevokeTarget] = useState<RunnerRow | null>(null);
  const [needsForce, setNeedsForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const canRevoke = hasMinRole(currentRole, "admin");

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const openRevoke = (runner: RunnerRow) => {
    setRevokeTarget(runner);
    setNeedsForce(false);
    setError(null);
  };

  const closeRevoke = () => {
    setRevokeTarget(null);
    setNeedsForce(false);
    setError(null);
  };

  const handleRevoke = (force: boolean) => {
    if (!revokeTarget) return;
    setError(null);
    startTransition(async () => {
      const result = await revokeRunner(revokeTarget.id, force);
      if (result.busy) {
        setNeedsForce(true);
        setError(result.error ?? null);
      } else if (result.error) {
        setError(result.error);
      } else {
        setRevokeTarget(null);
        setNeedsForce(false);
        router.refresh();
      }
    });
  };

  if (runners.length === 0) {
    return (
      <div className="bg-surface-container-low rounded-lg overflow-hidden">
        <div className="px-6 py-12 text-center">
          <span aria-hidden="true" className="material-symbols-outlined text-4xl text-on-surface-variant/30 mb-3 block">
            memory
          </span>
          <p className="text-sm text-on-surface-variant">No runners registered</p>
          <p className="text-xs text-on-surface-variant/60 mt-1">
            Click &quot;Register Runner&quot; to get started
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="bg-surface-container-low rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface-container text-on-surface-variant uppercase text-xs font-bold tracking-widest">
                <th className="px-6 py-4">Name</th>
                <th className="px-6 py-4 text-center">Status</th>
                <th className="px-6 py-4">Last Heartbeat</th>
                <th className="px-6 py-4">System</th>
                <th className="px-6 py-4">Capabilities</th>
                <th className="px-6 py-4">Registered</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="text-sm divide-y divide-outline-variant/10">
              {runners.map((runner) => {
                const displayStatus = getRunnerDisplayStatus(
                  runner.status,
                  runner.last_heartbeat_at,
                  now,
                );
                return (
                  <tr key={runner.id} className="hover:bg-surface-container transition-colors">
                    <td className="px-6 py-4 font-semibold text-on-surface">{runner.name}</td>
                    <td className="px-6 py-4 text-center">
                      <StatusBadge status={displayStatus} />
                    </td>
                    <td className="px-6 py-4 text-xs text-on-surface-variant font-mono">
                      {formatLastSeen(runner.last_heartbeat_at, now)}
                    </td>
                    <td className="px-6 py-4 text-xs text-on-surface-variant">
                      {runner.system_info
                        ? `${runner.system_info.os ?? "?"} ${runner.system_info.arch ?? "?"}`
                        : "—"}
                    </td>
                    <td className="px-6 py-4">
                      {runner.capabilities.length > 0 ? (
                        <div className="flex flex-wrap gap-1 max-w-[200px]">
                          {runner.capabilities.map((cap) => (
                            <span
                              key={cap}
                              className="px-1.5 py-0.5 rounded-sm text-[11px] font-mono bg-surface-container-highest text-on-surface-variant"
                            >
                              {cap}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-on-surface-variant/40">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-xs text-on-surface-variant">
                      {formatDateShort(runner.created_at)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {canRevoke ? (
                        <button
                          onClick={() => openRevoke(runner)}
                          className="text-xs font-medium text-error hover:bg-error/10 px-3 py-1.5 rounded transition-colors"
                        >
                          Revoke
                        </button>
                      ) : (
                        <span
                          className="text-xs text-on-surface-variant/30"
                          title="Admin permissions required to revoke runners"
                        >
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {revokeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeRevoke} />
          <div className="relative bg-surface-container rounded-lg shadow-2xl border border-outline-variant/10 w-full max-w-md p-8">
            <h3 className="text-xl font-semibold text-on-surface mb-2">Revoke Runner</h3>

            {error && (
              <div className="bg-error/10 border border-error/30 rounded-md p-3 text-xs text-error mb-4">
                {error}
              </div>
            )}

            {needsForce ? (
              <p className="text-sm text-on-surface-variant mb-6">
                <span className="font-bold text-error">
                  &quot;{revokeTarget.name}&quot; is currently busy with a job.
                </span>{" "}
                Revoking now will invalidate its token immediately and abandon that job. Are you
                sure you want to force revoke it?
              </p>
            ) : (
              <p className="text-sm text-on-surface-variant mb-6">
                This permanently deletes the registration for{" "}
                <span className="font-bold text-on-surface">&quot;{revokeTarget.name}&quot;</span>{" "}
                and invalidates its token. This cannot be undone.
              </p>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeRevoke}
                disabled={isPending}
                className="px-4 py-2 text-sm font-medium text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => handleRevoke(needsForce)}
                className="flex items-center gap-2 px-6 py-2 bg-error text-on-error text-sm font-bold rounded-md hover:bg-primary-container disabled:opacity-50 transition-all"
              >
                {isPending && (
                  <span aria-hidden="true" className="material-symbols-outlined text-sm animate-spin">
                    progress_activity
                  </span>
                )}
                {needsForce ? "Force Revoke" : "Revoke"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
