/**
 * Instant feedback while a dashboard page renders on the server: a top-bar
 * placeholder, a header block and a few panels in the page's rhythm, with an
 * ignition-orange progress sweep along the top edge.
 */
export default function DashboardLoading() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading">
      <div className="fixed top-0 left-[240px] right-0 h-0.5 overflow-hidden z-50">
        <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent animate-[loading-sweep_1.1s_ease-in-out_infinite]" />
      </div>

      <div className="h-14 px-8 flex items-center">
        <div className="h-3 w-40 rounded bg-surface-container-high animate-pulse" />
      </div>

      <div className="p-8 max-w-[1400px] mx-auto space-y-6">
        <div className="space-y-2">
          <div className="h-7 w-64 rounded bg-surface-container-high animate-pulse" />
          <div className="h-3 w-96 max-w-full rounded bg-surface-container animate-pulse" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 rounded-xl bg-surface-container-low ring-1 ring-outline-variant/10 animate-pulse"
              style={{ animationDelay: `${i * 80}ms` }}
            />
          ))}
        </div>
        <div className="h-72 rounded-xl bg-surface-container-low ring-1 ring-outline-variant/10 animate-pulse" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
