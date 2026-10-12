import type { PipelineRunStatus } from "@deployx/shared";
import { StatusBadge } from "@/components/ui/status-badge";

interface ProjectCardProps {
  readonly id: string;
  readonly name: string;
  readonly git_repo_url: string;
  readonly last_pipeline_status: PipelineRunStatus | null;
  readonly last_deploy_time: string | null;
  readonly last_build_duration: string | null;
  readonly last_commit_sha: string | null;
}

/**
 * A project at a glance: identity on top, then the facts that matter —
 * last run status, last deploy, duration, commit — in a compact grid.
 */
export function ProjectCard({
  name,
  git_repo_url,
  last_pipeline_status,
  last_deploy_time,
  last_build_duration,
  last_commit_sha,
}: ProjectCardProps) {
  const repo = git_repo_url.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "");

  return (
    <div className="group flex h-full flex-col rounded-lg border border-outline-variant bg-surface-container-low p-4 transition-colors duration-150 hover:border-outline hover:bg-surface-container">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-mono text-[15px] font-semibold">{name}</h3>
          <p className="mt-0.5 truncate font-mono text-xs text-on-surface-variant" title={repo}>
            {repo}
          </p>
        </div>
        {last_pipeline_status ? (
          <StatusBadge status={last_pipeline_status} />
        ) : (
          <span className="shrink-0 text-xs text-on-surface-variant">No runs</span>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-outline-variant pt-3 text-xs">
        <div className="min-w-0">
          <dt className="text-on-surface-variant">Last deploy</dt>
          <dd className="mt-0.5 truncate">{last_deploy_time ?? "Never"}</dd>
        </div>
        <div>
          <dt className="text-on-surface-variant">Duration</dt>
          <dd className="mt-0.5 font-mono tabular-nums">{last_build_duration ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-on-surface-variant">Commit</dt>
          <dd className="mt-0.5 font-mono">{last_commit_sha ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}
