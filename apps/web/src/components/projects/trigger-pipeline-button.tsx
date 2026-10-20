"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { usePermissions } from "@/components/layout/user-context";
import { GatedLink } from "@/components/ui/gated-link";
import { triggerPipelineRun } from "@/app/(dashboard)/projects/[projectId]/pipelines/actions";
import type { RunnerOption } from "@/lib/runner-options";

const ANY_RUNNER = "";

const STATUS_LABEL: Record<RunnerOption["status"], string> = {
  online: "online",
  busy: "busy",
  offline: "offline",
};

interface PipelineChoice {
  readonly id: string;
  readonly name: string;
  readonly current_version_id: string | null;
}

/**
 * "Trigger Pipeline" with a small popover to pick the pipeline (when there
 * is more than one) and the runner to run it on. Opens the new run's page.
 */
export function TriggerPipelineButton({
  projectId,
  pipelines,
  runners,
  label = "Trigger Pipeline",
}: {
  readonly projectId: string;
  readonly pipelines: readonly PipelineChoice[];
  readonly runners: readonly RunnerOption[];
  readonly label?: string;
}) {
  const router = useRouter();
  const { canEdit, readOnlyReason } = usePermissions();
  const runnable = pipelines.filter((p) => p.current_version_id);
  const [open, setOpen] = useState(false);
  const [pipelineId, setPipelineId] = useState(runnable[0]?.id ?? "");
  const [runnerId, setRunnerId] = useState(ANY_RUNNER);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (runnable.length === 0) {
    return (
      <GatedLink
        href={`/projects/${projectId}/pipelines/new`}
        allowed={canEdit}
        reason={readOnlyReason}
        className="bg-primary hover:bg-primary/90 text-on-primary px-4 py-2 rounded-md text-sm font-semibold flex items-center gap-2 transition-all"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-lg">add</span>
        Create Pipeline
      </GatedLink>
    );
  }

  const selectedRunner = runners.find((r) => r.id === runnerId);
  const anyOnline = runners.some((r) => r.status !== "offline");
  const waitHint = selectedRunner
    ? selectedRunner.status === "offline"
      ? `${selectedRunner.name} is offline — the run will wait in the queue until it's back.`
      : null
    : anyOnline
      ? null
      : "No runner is online — the run will wait in the queue until one connects.";

  const run = () => {
    setError(null);
    startTransition(async () => {
      const result = await triggerPipelineRun(projectId, pipelineId, runnerId || null);
      if (result.error || !result.run_id) {
        setError(result.error ?? "Failed to trigger the pipeline");
        return;
      }
      setOpen(false);
      router.push(`/projects/${projectId}/runs/${result.run_id}`);
    });
  };

  const selectClass =
    "w-full bg-surface-container-lowest border border-outline-variant rounded-md px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!canEdit || isPending}
        title={readOnlyReason}
        aria-expanded={open}
        className="bg-primary hover:bg-primary/90 text-on-primary px-4 py-2 rounded-md text-sm font-semibold flex items-center gap-2 transition-all disabled:opacity-50"
      >
        <span aria-hidden="true" className={`material-symbols-outlined text-lg ${isPending ? "animate-spin" : ""}`}>
          {isPending ? "progress_activity" : "bolt"}
        </span>
        {isPending ? "Triggering..." : label}
        <span aria-hidden="true" className="material-symbols-outlined text-base -mr-1">expand_more</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Trigger pipeline"
          className="absolute right-0 mt-2 w-80 bg-surface-container rounded-lg shadow-2xl border border-outline-variant z-30 p-4 space-y-3"
        >
          {runnable.length > 1 && (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-on-surface-variant">Pipeline</span>
              <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className={selectClass}>
                {runnable.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-xs font-semibold text-on-surface-variant">Run on</span>
            <select value={runnerId} onChange={(e) => setRunnerId(e.target.value)} className={selectClass}>
              <option value={ANY_RUNNER}>Any available runner</option>
              {runners.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} — {STATUS_LABEL[r.status]}
                </option>
              ))}
            </select>
          </label>

          {waitHint && (
            <p className="flex gap-1.5 text-xs text-warning">
              <span aria-hidden="true" className="material-symbols-outlined text-[16px]">schedule</span>
              {waitHint}
            </p>
          )}
          {error && <p className="text-xs text-error">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface rounded-md"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={run}
              disabled={isPending || !pipelineId}
              className="px-3 py-1.5 text-sm font-semibold rounded-md bg-accent text-on-accent hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">play_arrow</span>
              Run
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
