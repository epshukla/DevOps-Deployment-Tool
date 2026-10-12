/**
 * Instant feedback while a dashboard page renders on the server: a top-bar
 * placeholder, a header block and a few panels in the page's rhythm, with a
 * thin progress sweep along the top edge.
 */
export default function DashboardLoading() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading">
      <div className="fixed top-0 left-0 lg:left-56 right-0 h-0.5 overflow-hidden z-50">
        <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-info to-transparent animate-[loading-sweep_1.1s_ease-in-out_infinite]" />
      </div>

      <div className="h-14 px-4 md:px-6 flex items-center border-b border-outline-variant">
        <div className="h-3 w-40 rounded bg-surface-container-high animate-pulse" />
      </div>

      <div className="px-4 py-6 md:px-6 max-w-[1400px] mx-auto space-y-6">
        <div className="space-y-2">
          <div className="h-6 w-56 rounded bg-surface-container-high animate-pulse" />
          <div className="h-3 w-96 max-w-full rounded bg-surface-container animate-pulse" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 rounded-lg bg-surface-container-low border border-outline-variant animate-pulse"
              style={{ animationDelay: `${i * 80}ms` }}
            />
          ))}
        </div>
        <div className="h-72 rounded-lg bg-surface-container-low border border-outline-variant animate-pulse" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
