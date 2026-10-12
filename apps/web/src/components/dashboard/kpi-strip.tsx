interface Kpi {
  readonly label: string;
  readonly value: string;
  readonly trend?: { readonly direction: "up" | "down"; readonly value: string };
  /** Which direction is good news (colours the delta); "either" = neutral. */
  readonly goodWhen?: "up" | "down" | "either";
  readonly hint?: string;
}

function deltaTone(direction: "up" | "down", goodWhen: Kpi["goodWhen"]): string {
  if (!goodWhen || goodWhen === "either") return "text-on-surface-variant";
  return direction === goodWhen ? "text-tertiary" : "text-error";
}

/**
 * KPI strip: one panel split into cells instead of floating stat cards
 * (Data-Dense Dashboard pattern). Deltas carry an arrow and a sign, so the
 * meaning never depends on colour alone.
 */
export function KpiStrip({ items }: { readonly items: readonly Kpi[] }) {
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low lg:grid-cols-4">
      {items.map((kpi, i) => (
        <div
          key={kpi.label}
          className={`px-4 py-3.5 ${i % 2 === 1 ? "border-l border-outline-variant" : ""} ${
            i >= 2 ? "border-t border-outline-variant lg:border-t-0" : ""
          } ${i === 2 ? "lg:border-l" : ""}`}
        >
          <dt className="text-xs text-on-surface-variant">{kpi.label}</dt>
          <dd className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums">{kpi.value}</span>
            {kpi.trend && (
              <span
                className={`font-mono text-xs tabular-nums ${deltaTone(kpi.trend.direction, kpi.goodWhen)}`}
                title={kpi.hint ?? "vs previous 7 days"}
              >
                {kpi.trend.direction === "up" ? "↑" : "↓"} {kpi.trend.value.replace(/^[+-]/, "")}
              </span>
            )}
          </dd>
          {kpi.hint && <p className="mt-0.5 text-[11px] text-on-surface-variant/70">{kpi.hint}</p>}
        </div>
      ))}
    </dl>
  );
}
