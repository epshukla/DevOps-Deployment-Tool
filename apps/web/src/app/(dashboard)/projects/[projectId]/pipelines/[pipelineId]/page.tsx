import { notFound } from "next/navigation";
import { requireUserWithOrg } from "@/lib/auth/session";
import { PipelineDetailClient } from "./pipeline-detail-client";

interface PageProps {
  readonly params: Promise<{ projectId: string; pipelineId: string }>;
}

export default async function PipelineDetailPage({ params }: PageProps) {
  const { projectId, pipelineId } = await params;
  const { supabase, role } = await requireUserWithOrg();

  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", projectId)
    .single();

  if (!project) notFound();

  const { data: definition } = await supabase
    .from("pipeline_definitions")
    .select("id, name, current_version_id, project_id")
    .eq("id", pipelineId)
    .eq("project_id", projectId)
    .single();

  if (!definition) notFound();

  const { data: versions } = await supabase
    .from("pipeline_definition_versions")
    .select("id, version, created_at, created_by, yaml_source")
    .eq("pipeline_definition_id", pipelineId)
    .order("version", { ascending: false });

  const versionList = versions ?? [];

  // Resolve author display names for the version history (best-effort —
  // a two-step lookup instead of a relational embed, since there's no
  // guaranteed FK path from pipeline_definition_versions to user_profiles).
  const authorIds = [...new Set(versionList.map((v) => v.created_by as string))];
  const { data: authorProfiles } = authorIds.length > 0
    ? await supabase
        .from("user_profiles")
        .select("id, display_name")
        .in("id", authorIds)
    : { data: [] };
  const authorNameById = new Map(
    (authorProfiles ?? []).map((p) => [p.id as string, p.display_name as string]),
  );

  const { data: recentRuns } = await supabase
    .from("pipeline_runs")
    .select("id, status, trigger_type, git_branch, git_sha, duration_ms, created_at")
    .eq("pipeline_definition_id", pipelineId)
    .order("created_at", { ascending: false })
    .limit(10);

  return (
    <PipelineDetailClient
      project={project}
      definition={definition}
      versions={versionList.map((v) => ({
        id: v.id,
        version: v.version,
        created_at: v.created_at,
        created_by: v.created_by,
        created_by_name: authorNameById.get(v.created_by as string) ?? null,
        yaml_source: v.yaml_source,
      }))}
      recentRuns={recentRuns ?? []}
      currentRole={role}
    />
  );
}
