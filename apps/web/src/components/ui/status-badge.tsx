/**
 * One status vocabulary for the whole app (design-system/deployx/MASTER.md):
 * every status shows an icon AND a word, never colour alone.
 *
 * Tones: go (green) · fail (red) · run (blue, animated) · hold (amber) · idle (grey)
 */

type Tone = "go" | "fail" | "run" | "hold" | "idle";

interface StatusSpec {
  readonly tone: Tone;
  readonly icon: string;
  readonly label: string;
}

const SPECS: Readonly<Record<string, StatusSpec>> = {
  // pipeline / task / step runs
  success: { tone: "go", icon: "check_circle", label: "Succeeded" },
  failed: { tone: "fail", icon: "cancel", label: "Failed" },
  running: { tone: "run", icon: "progress_activity", label: "Running" },
  queued: { tone: "idle", icon: "schedule", label: "Queued" },
  created: { tone: "idle", icon: "radio_button_unchecked", label: "Created" },
  pending: { tone: "idle", icon: "radio_button_unchecked", label: "Pending" },
  cancelled: { tone: "idle", icon: "block", label: "Cancelled" },
  skipped: { tone: "idle", icon: "redo", label: "Skipped" },
  timed_out: { tone: "fail", icon: "timer_off", label: "Timed out" },
  awaiting_approval: { tone: "hold", icon: "front_hand", label: "Awaiting approval" },
  // deployments
  deploying: { tone: "run", icon: "progress_activity", label: "Deploying" },
  active: { tone: "go", icon: "radio_button_checked", label: "Active" },
  draining: { tone: "hold", icon: "hourglass_bottom", label: "Draining" },
  stopped: { tone: "idle", icon: "stop_circle", label: "Stopped" },
  rolled_back: { tone: "hold", icon: "undo", label: "Rolled back" },
  // health
  healthy: { tone: "go", icon: "favorite", label: "Healthy" },
  degraded: { tone: "hold", icon: "warning", label: "Degraded" },
  unhealthy: { tone: "fail", icon: "heart_broken", label: "Unhealthy" },
  unknown: { tone: "idle", icon: "help", label: "Unknown" },
  // runners
  online: { tone: "go", icon: "wifi", label: "Online" },
  busy: { tone: "run", icon: "progress_activity", label: "Busy" },
  offline: { tone: "idle", icon: "wifi_off", label: "Offline" },
};

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  go: "text-tertiary bg-tertiary/10 ring-tertiary/20",
  fail: "text-error bg-error/10 ring-error/20",
  run: "text-info bg-info/10 ring-info/20",
  hold: "text-warning bg-warning/10 ring-warning/20",
  idle: "text-on-surface-variant bg-surface-container-highest/60 ring-outline-variant",
};

export function statusSpec(status: string): StatusSpec {
  return (
    SPECS[status] ?? {
      tone: "idle",
      icon: "radio_button_unchecked",
      label: status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
    }
  );
}

export function StatusBadge({
  status,
  size = "sm",
  label,
}: {
  readonly status: string;
  readonly size?: "sm" | "md";
  /** Override the default word (e.g. "Passed" for a health check). */
  readonly label?: string;
}) {
  const spec = statusSpec(status);
  const sizing =
    size === "md" ? "h-6 gap-1.5 px-2 text-xs" : "h-5 gap-1 px-1.5 text-[11px]";
  const iconSize = size === "md" ? "text-[14px]" : "text-[13px]";

  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md font-medium ring-1 ring-inset ${sizing} ${TONE_CLASS[spec.tone]}`}
    >
      <span
        aria-hidden="true"
        className={`material-symbols-outlined ${iconSize} leading-none ${
          spec.tone === "run" ? "animate-spin motion-reduce:animate-none" : ""
        }`}
        style={{ fontVariationSettings: "'FILL' 1, 'wght' 500" }}
      >
        {spec.icon}
      </span>
      {label ?? spec.label}
    </span>
  );
}
