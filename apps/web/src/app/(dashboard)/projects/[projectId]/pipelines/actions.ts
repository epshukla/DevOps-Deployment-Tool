"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUserWithOrg } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { parsePipelineYaml, tryParsePipelineYaml } from "@deployx/pipeline-engine";
import { hasMinRole } from "@deployx/shared";

export interface PipelineActionState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
  readonly success?: boolean;
}

/**
 * Create a new pipeline definition with an initial version.
 */
export async function createPipelineDefinition(
  projectId: string,
  _prev: PipelineActionState,
  formData: FormData,
): Promise<PipelineActionState> {
  const { supabase, user, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "developer")) {
    return { error: "You don't have permission to create pipelines" };
  }

  const name = (formData.get("name") as string | null)?.trim();
  const yamlSource = (formData.get("yaml_source") as string | null)?.trim();

  if (!name || name.length === 0) {
    return { fieldErrors: { name: ["Pipeline name is required"] } };
  }

  if (!yamlSource || yamlSource.length === 0) {
    return { fieldErrors: { yaml_source: ["Pipeline YAML is required"] } };
  }

  // Validate YAML
  const parseResult = tryParsePipelineYaml(yamlSource);
  if (!parseResult.success) {
    return { fieldErrors: { yaml_source: [parseResult.error] } };
  }

  // Create pipeline definition
  const { data: definition, error: defError } = await supabase
    .from("pipeline_definitions")
    .insert({
      project_id: projectId,
      name,
    })
    .select("id")
    .single();

  if (defError) {
    if (defError.code === "23505") {
      return { fieldErrors: { name: ["A pipeline with this name already exists in this project"] } };
    }
    return { error: "Failed to create pipeline definition" };
  }

  // Create version 1
  const { data: version, error: verError } = await supabase
    .from("pipeline_definition_versions")
    .insert({
      pipeline_definition_id: definition.id,
      version: 1,
      config_json: parseResult.data,
      yaml_source: yamlSource,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (verError) {
    return { error: "Failed to create pipeline version" };
  }

  // Update current_version_id
  await supabase
    .from("pipeline_definitions")
    .update({ current_version_id: version.id })
    .eq("id", definition.id);

  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}

/**
 * Trigger a pipeline run for a given pipeline definition. With a
 * `targetRunnerId` only that runner may pick the run up; otherwise any online
 * runner in the org can.
 */
export async function triggerPipelineRun(
  projectId: string,
  definitionId: string,
  targetRunnerId: string | null = null,
): Promise<{ error?: string; run_id?: string }> {
  const { supabase, user, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "developer")) {
    return { error: "You don't have permission to trigger pipelines" };
  }

  if (targetRunnerId) {
    const check = await checkRunnerInProjectOrg(supabase, projectId, targetRunnerId);
    if (check.error) return { error: check.error };
  }

  // Get the current version of the pipeline definition
  const { data: definition } = await supabase
    .from("pipeline_definitions")
    .select("id, current_version_id")
    .eq("id", definitionId)
    .single();

  if (!definition?.current_version_id) {
    return { error: "Pipeline definition has no version" };
  }

  // Get the project's git info
  const { data: project } = await supabase
    .from("projects")
    .select("default_branch, git_repo_url")
    .eq("id", projectId)
    .single();

  // Create pipeline run with status 'created'
  const { data: run, error: runError } = await supabase
    .from("pipeline_runs")
    .insert({
      pipeline_definition_id: definitionId,
      pipeline_version_id: definition.current_version_id,
      project_id: projectId,
      status: "created",
      trigger_type: "manual",
      git_branch: project?.default_branch ?? "main",
      created_by: user.id,
      target_runner_id: targetRunnerId,
    })
    .select("id")
    .single();

  if (runError) {
    return { error: "Failed to create pipeline run" };
  }

  // Transition to 'queued' so the runner can pick it up
  const { error: queueError } = await supabase
    .from("pipeline_runs")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("id", run.id);

  if (queueError) {
    return { error: "Failed to queue pipeline run" };
  }

  revalidatePath(`/projects/${projectId}`);

  return { run_id: run.id };
}

/**
 * Save a new version of a pipeline definition (edit flow). Increments the
 * version number and makes the new version current.
 */
export async function updatePipelineDefinitionVersion(
  projectId: string,
  pipelineId: string,
  _prev: PipelineActionState,
  formData: FormData,
): Promise<PipelineActionState> {
  const { supabase, user, org, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "developer")) {
    return { error: "You don't have permission to edit pipelines" };
  }

  const yamlSource = (formData.get("yaml_source") as string | null)?.trim();

  if (!yamlSource || yamlSource.length === 0) {
    return { fieldErrors: { yaml_source: ["Pipeline YAML is required"] } };
  }

  const parseResult = tryParsePipelineYaml(yamlSource);
  if (!parseResult.success) {
    return { fieldErrors: { yaml_source: [parseResult.error] } };
  }

  const { data: definition } = await supabase
    .from("pipeline_definitions")
    .select("id")
    .eq("id", pipelineId)
    .eq("project_id", projectId)
    .single();

  if (!definition) {
    return { error: "Pipeline definition not found" };
  }

  const { data: latestVersion } = await supabase
    .from("pipeline_definition_versions")
    .select("version")
    .eq("pipeline_definition_id", pipelineId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (latestVersion?.version ?? 0) + 1;

  const { data: version, error: verError } = await supabase
    .from("pipeline_definition_versions")
    .insert({
      pipeline_definition_id: pipelineId,
      version: nextVersion,
      config_json: parseResult.data,
      yaml_source: yamlSource,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (verError || !version) {
    return { error: "Failed to save pipeline version" };
  }

  const { error: updateError } = await supabase
    .from("pipeline_definitions")
    .update({ current_version_id: version.id, updated_at: new Date().toISOString() })
    .eq("id", pipelineId);

  if (updateError) {
    return { error: "Failed to update pipeline definition" };
  }

  recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "update",
    resource_type: "pipeline_definition",
    resource_id: pipelineId,
    details: { version: nextVersion },
  });

  revalidatePath(`/projects/${projectId}/pipelines/${pipelineId}`);
  revalidatePath(`/projects/${projectId}`);

  return { success: true };
}

/**
 * Restore an older pipeline version by copying its YAML/config into a
 * brand-new version at the top of history, and making it current.
 */
export async function restorePipelineVersion(
  projectId: string,
  pipelineId: string,
  versionId: string,
): Promise<{ error?: string; success?: boolean }> {
  const { supabase, user, org, role } = await requireUserWithOrg();

  if (!hasMinRole(role, "developer")) {
    return { error: "You don't have permission to restore pipeline versions" };
  }

  const { data: definition } = await supabase
    .from("pipeline_definitions")
    .select("id")
    .eq("id", pipelineId)
    .eq("project_id", projectId)
    .single();

  if (!definition) {
    return { error: "Pipeline definition not found" };
  }

  const { data: sourceVersion } = await supabase
    .from("pipeline_definition_versions")
    .select("version, config_json, yaml_source")
    .eq("id", versionId)
    .eq("pipeline_definition_id", pipelineId)
    .single();

  if (!sourceVersion) {
    return { error: "Pipeline version not found" };
  }

  const { data: latestVersion } = await supabase
    .from("pipeline_definition_versions")
    .select("version")
    .eq("pipeline_definition_id", pipelineId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (latestVersion?.version ?? 0) + 1;

  const { data: newVersion, error: verError } = await supabase
    .from("pipeline_definition_versions")
    .insert({
      pipeline_definition_id: pipelineId,
      version: nextVersion,
      config_json: sourceVersion.config_json,
      yaml_source: sourceVersion.yaml_source,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (verError || !newVersion) {
    return { error: "Failed to restore pipeline version" };
  }

  const { error: updateError } = await supabase
    .from("pipeline_definitions")
    .update({ current_version_id: newVersion.id, updated_at: new Date().toISOString() })
    .eq("id", pipelineId);

  if (updateError) {
    return { error: "Failed to update pipeline definition" };
  }

  recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "update",
    resource_type: "pipeline_definition",
    resource_id: pipelineId,
    details: { restored_from_version: sourceVersion.version, new_version: nextVersion },
  });

  revalidatePath(`/projects/${projectId}/pipelines/${pipelineId}`);
  revalidatePath(`/projects/${projectId}`);

  return { success: true };
}

/** The chosen runner must be registered in the same org as the project. */
async function checkRunnerInProjectOrg(
  supabase: Awaited<ReturnType<typeof requireUserWithOrg>>["supabase"],
  projectId: string,
  runnerId: string,
): Promise<{ error?: string }> {
  const [{ data: project }, { data: runner }] = await Promise.all([
    supabase.from("projects").select("org_id").eq("id", projectId).maybeSingle(),
    supabase.from("runner_registrations").select("org_id").eq("id", runnerId).maybeSingle(),
  ]);
  if (!project || !runner || runner.org_id !== project.org_id) {
    return { error: "That runner isn't available for this project" };
  }
  return {};
}
