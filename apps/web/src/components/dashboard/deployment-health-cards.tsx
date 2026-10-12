import Link from "next/link";
import { Panel } from "@/components/ui/panel";
import { StatusBadge } from "@/components/ui/status-badge";

export interface DeploymentHealthRow {
  readonly id: string;
  readonly name: string;
  readonly project_id: string;
  readonly status: string;
  readonly health: string;
  readonly image: string;
  readonly uptime: string;
}

/**
 * Compact deployment list: project + image on the left, lifecycle/health
 * badges and uptime on the right. One row per deployment, whole row links.
 */
export function DeploymentHealthCards({
  deployments,
}: {
  readonly deployments: readonly DeploymentHealthRow[];
}) {
  return (
    <Panel title="Deployments" description="Latest per project · 24h uptime">
      {deployments.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm text-on-surface">Nothing deployed yet</p>
          <p className="mt-1 text-xs text-on-surface-variant">
            Add a <code className="font-mono">deploy:</code> block to a pipeline task.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant/60">
          {deployments.map((d) => (
            <li key={d.id}>
              <Link
                href={`/projects/${d.project_id}/deployments/${d.id}`}
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-container"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{d.name}</p>
                  <p className="truncate font-mono text-[11px] text-on-surface-variant" title={d.image}>
                    {d.image}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="flex items-center gap-1.5">
                    {d.status !== "active" && <StatusBadge status={d.status} />}
                    <StatusBadge status={d.health} />
                  </div>
                  <span className="font-mono text-[11px] tabular-nums text-on-surface-variant">
                    {d.uptime === "—" ? "no checks" : `${d.uptime} up`}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
