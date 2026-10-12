type Accent = "primary" | "tertiary" | "secondary" | "info";

// Static class maps: Tailwind can only see class names that appear verbatim
const ACCENT_BAR: Record<Accent, string> = {
  primary: "from-primary/80",
  tertiary: "from-tertiary/80",
  secondary: "from-secondary/70",
  info: "from-info/80",
};

const ACCENT_ICON: Record<Accent, string> = {
  primary: "bg-primary/10 text-primary",
  tertiary: "bg-tertiary/10 text-tertiary",
  secondary: "bg-secondary/10 text-secondary",
  info: "bg-info/10 text-info",
};

interface StatCardProps {
  readonly label: string;
  readonly value: string;
  readonly icon: string;
  readonly accent: Accent;
  readonly trend?: { direction: "up" | "down"; value: string };
  /** Which direction is good news for this metric (colours the trend). */
  readonly goodWhen?: "up" | "down" | "either";
  /** Optional caption under the value, e.g. the comparison window. */
  readonly caption?: string;
}

function trendTone(
  direction: "up" | "down",
  goodWhen: "up" | "down" | "either",
): string {
  if (goodWhen === "either") return "text-on-surface-variant bg-surface-container-highest";
  return direction === goodWhen
    ? "text-tertiary bg-tertiary/10"
    : "text-error bg-error/10";
}

export function StatCard({
  label,
  value,
  icon,
  accent,
  trend,
  goodWhen = "either",
  caption = "vs previous 7 days",
}: StatCardProps) {
  return (
    <div className="group relative overflow-hidden rounded-xl bg-surface-container-low ring-1 ring-outline-variant/15 p-5 transition-colors hover:bg-surface-container">
      {/* Instrument-panel accent: a lit edge along the top */}
      <div
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${ACCENT_BAR[accent]} via-transparent to-transparent`}
      />
      <div className="flex items-start justify-between">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-on-surface-variant">
          {label}
        </span>
        <span
          aria-hidden="true"
          className={`material-symbols-outlined grid h-8 w-8 place-items-center rounded-lg text-[18px] ${ACCENT_ICON[accent]}`}
        >
          {icon}
        </span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="font-display text-4xl font-bold leading-none tracking-tight tabular-nums">
          {value}
        </div>
        {trend && (
          <div
            className={`flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold ${trendTone(trend.direction, goodWhen)}`}
            title={caption}
          >
            <span aria-hidden="true" className="material-symbols-outlined text-sm">
              {trend.direction === "up" ? "trending_up" : "trending_down"}
            </span>
            {trend.value}
          </div>
        )}
      </div>
      {trend && (
        <p className="mt-2 text-[10px] text-on-surface-variant/50">{caption}</p>
      )}
    </div>
  );
}
