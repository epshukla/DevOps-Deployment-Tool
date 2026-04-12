"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { CreateProjectSchema } from "@deployx/shared";
import { requireUserWithOrg } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";

export type ActionState = {
  readonly error?: string;
  readonly fieldErrors?: Record<string, string[]>;
};

export async function createProject(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase, user, org } = await requireUserWithOrg();

  // Parse and validate form data with Zod
  const raw = {
    name: formData.get("name"),
    git_repo_url: formData.get("git_repo_url"),
    default_branch: formData.get("default_branch") || "main",
    dockerfile_path: formData.get("dockerfile_path") || "./Dockerfile",
    build_context: formData.get("build_context") || ".",
    deploy_target: formData.get("deploy_target") || "docker_local",
  };

  const result = CreateProjectSchema.safeParse(raw);

  if (!result.success) {
    return {
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { name, git_repo_url, default_branch, dockerfile_path, build_context, deploy_target } =
    result.data;

  // Generate slug from project name
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");

  const { data: inserted, error } = await supabase.from("projects").insert({
    org_id: org.id,
    name,
    slug,
    git_repo_url,
    default_branch,
    dockerfile_path,
    build_context,
    deploy_target,
    created_by: user.id,
  }).select("id").single();

  if (error) {
    if (error.code === "23505") {
      return { error: "A project with this name already exists in your organization." };
    }
    return { error: error.message };
  }

  recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "create",
    resource_type: "project",
    resource_id: inserted?.id ?? "",
    details: { name, deploy_target },
  });

  revalidatePath("/projects");
  redirect("/projects");
}

export async function deleteProject(projectId: string): Promise<ActionState> {
  const { supabase, user, org } = await requireUserWithOrg();

  const { error } = await supabase.from("projects").delete().eq("id", projectId);

  if (error) {
    return { error: error.message };
  }

  recordAuditEvent(supabase, {
    org_id: org.id,
    user_id: user.id,
    action: "delete",
    resource_type: "project",
    resource_id: projectId,
  });

  revalidatePath("/projects");
  redirect("/projects");
}
