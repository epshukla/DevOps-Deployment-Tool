"use client";

import {
  colorForRevision,
  colorsFromLatestCutover,
  isCutoverOrDrainEvent,
  type DeploymentColor,
} from "@/lib/blue-green";
import { formatDate } from "@/lib/format-date";

interface RevisionData {
  readonly id: string;
  readonly revision_number: number;
  readonly image_tag: string;
  readonly created_at: string;
}

interface HealingEvent {
  readonly id: string;
  readonly event_type: string;
  readonly created_at: string;
  readonly details?: Record<string, unknown> | null;
}

interface BlueGreenProgressCardProps {
  readonly revisions: readonly RevisionData[];
  readonly healingEvents: readonly HealingEvent[];
}

const COLOR_STYLE: Record<DeploymentColor, { dot: string; text: string; label: string }> = {
  blue: { dot: "bg-info", text: "text-info", label: "Blue" },
  green: { dot: "bg-tertiary", text: "text-tertiary", label: "Green" },
};

export function BlueGreenProgressCard({ revisions, healingEvents }: BlueGreenProgressCardProps) {
  if (revisions.length === 0) return null;

  // Page query orders revisions by revision_number descending, but sort
  // defensively since the realtime hook may append out of order.
  const sorted = [...revisions].sort((a, b) => b.revision_number - a.revision_number);
  const active = sorted[0];
  const previous = sorted[1] ?? null;

  // Prefer the colors the runner actually used; derive for older deployments
  const recorded = colorsFromLatestCutover(healingEvents);
  const activeColor = recorded?.active ?? colorForRevision(active.revision_number);
  const previousColor =
    recorded?.previous ?? (previous ? colorForRevision(previous.revision_number) : null);

  const transitionEvents = healingEvents.filter((e) => isCutoverOrDrainEvent(e.event_type));

  return (
    <div className="bg-surface-container-low rounded-lg border border-outline-variant overflow-hidden">
      <div className="px-6 py-4 border-b border-outline-variant/10">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-sm text-primary">swap_horiz</span>
          <h3 className="text-sm font-bold text-on-surface">Blue-Green Cutover</h3>
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex items-center gap-3 bg-surface-container-highest/40 rounded-lg p-3">
            <span className={`w-3 h-3 rounded-full shrink-0 ${COLOR_STYLE[activeColor].dot}`} />
            <div className="min-w-0">
              <p className="text-xs uppercase font-bold text-on-surface-variant">
                Active — <span className={COLOR_STYLE[activeColor].text}>{COLOR_STYLE[activeColor].label}</span>
              </p>
              <p className="text-xs font-mono text-on-surface truncate">{active.image_tag}</p>
            </div>
          </div>

          {previous && previousColor ? (
            <div className="flex items-center gap-3 bg-surface-container-highest/15 rounded-lg p-3 opacity-80">
              <span className={`w-3 h-3 rounded-full shrink-0 ${COLOR_STYLE[previousColor].dot}`} />
              <div className="min-w-0">
                <p className="text-xs uppercase font-bold text-on-surface-variant">
                  Previous —{" "}
                  <span className={COLOR_STYLE[previousColor].text}>{COLOR_STYLE[previousColor].label}</span>
                </p>
                <p className="text-xs font-mono text-on-surface-variant truncate">{previous.image_tag}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 bg-surface-container-highest/10 rounded-lg p-3 opacity-50">
              <p className="text-xs text-on-surface-variant">No previous revision yet</p>
            </div>
          )}
        </div>

        {transitionEvents.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-on-surface-variant">
              Cutover Timeline
            </p>
            {transitionEvents.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-xs text-on-surface-variant">
                <span aria-hidden="true" className="material-symbols-outlined text-sm text-primary">arrow_forward</span>
                <span className="capitalize">{e.event_type.replace(/_/g, " ")}</span>
                <span className="text-on-surface-variant/50 ml-auto font-mono">
                  {formatDate(e.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
