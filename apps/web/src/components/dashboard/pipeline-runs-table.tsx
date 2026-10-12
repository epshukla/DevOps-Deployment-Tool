import Link from "next/link";
import { Panel } from "@/components/ui/panel";
import { StatusBadge } from "@/components/ui/status-badge";

export interface PipelineRunRow {
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly project_id: string;
  readonly branch: string;
  readonly commit: string | null;
  readonly trigger: string | null;
  readonly status: string;
  readonly duration: string;
  readonly started: string;
  readonly startedTitle: string;
}

const TRIGGER_ICON: Readonly<Record<string, string>> = {
  manual: "touch_app",
  webhook: "commit",
  schedule: "schedule",
};

/**
 * Recent runs as a dense table (36px rows, sticky header). Every cell links
 * to the run, so the whole row is clickable and keyboard reachable once.
 */
export function PipelineRunsTable({ runs }: { readonly runs: readonly PipelineRunRow[] }) {
  return (
    <Panel
      title="Recent runs"
      actions={
        <Link
          href="/projects"
          className="text-xs text-on-surface-variant transition-colors hover:text-on-surface"
        >
          All projects →
        </Link>
      }
    >
      {runs.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm text-on-surface">No runs yet</p>
          <p className="mt-1 text-xs text-on-surface-variant">
            Create a project, add a pipeline, then trigger it or push to GitHub.
          </p>
        </div>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
            <thead className="sticky top-0 z-10 bg-surface-container-low">
              <tr className="border-b border-outline-variant text-xs text-on-surface-variant">
                <th scope="col" className="h-8 px-4 font-normal">Status</th>
                <th scope="col" className="h-8 px-3 font-normal">Pipeline</th>
                <th scope="col" className="h-8 px-3 font-normal">Project</th>
                <th scope="col" className="h-8 px-3 font-normal">Branch</th>
                <th scope="col" className="h-8 px-3 font-normal">Commit</th>
                <th scope="col" className="h-8 px-3 text-right font-normal">Duration</th>
                <th scope="col" className="h-8 px-4 text-right font-normal">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const href = `/projects/${run.project_id}/runs/${run.id}`;
                const cell = "flex h-9 items-center";
                return (
                  <tr
                    key={run.id}
                    className="border-b border-outline-variant/60 transition-colors last:border-b-0 hover:bg-surface-container"
                  >
                    <td className="p-0 pl-4">
                      <Link href={href} className={cell}>
                        <StatusBadge status={run.status} />
                      </Link>
                    </td>
                    <td className="p-0 px-3">
                      <Link href={href} className={`${cell} font-mono font-medium`} tabIndex={-1}>
                        <span className="truncate">{run.name}</span>
                      </Link>
                    </td>
                    <td className="p-0 px-3">
                      <Link href={href} className={`${cell} text-on-surface-variant`} tabIndex={-1}>
                        <span className="truncate">{run.project}</span>
                      </Link>
                    </td>
                    <td className="p-0 px-3">
                      <Link href={href} className={`${cell} gap-1 font-mono text-xs text-on-surface-variant`} tabIndex={-1}>
                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">call_split</span>
                        <span className="max-w-[140px] truncate">{run.branch}</span>
                      </Link>
                    </td>
                    <td className="p-0 px-3">
                      <Link href={href} className={`${cell} gap-1.5 font-mono text-xs text-on-surface-variant`} tabIndex={-1}>
                        {run.trigger && (
                          <span
                            aria-hidden="true"
                            title={run.trigger}
                            className="material-symbols-outlined text-[14px]"
                          >
                            {TRIGGER_ICON[run.trigger] ?? "bolt"}
                          </span>
                        )}
                        {run.commit ?? "—"}
                      </Link>
                    </td>
                    <td className="p-0 px-3">
                      <Link href={href} className={`${cell} justify-end font-mono text-xs tabular-nums`} tabIndex={-1}>
                        {run.duration}
                      </Link>
                    </td>
                    <td className="p-0 pr-4">
                      <Link
                        href={href}
                        className={`${cell} justify-end whitespace-nowrap text-xs text-on-surface-variant`}
                        tabIndex={-1}
                        title={run.startedTitle}
                      >
                        {run.started}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
