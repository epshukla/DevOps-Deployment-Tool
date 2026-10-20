import { notFound, redirect } from "next/navigation";
import { hasMinRole } from "@deployx/shared";
import { requireUserWithOrg } from "@/lib/auth/session";
import { NewPipelineForm } from "./new-pipeline-form";

interface NewPipelinePageProps {
  readonly params: Promise<{ projectId: string }>;
}

export default async function NewPipelinePage({ params }: NewPipelinePageProps) {
  const { projectId } = await params;
  const { supabase, org, role } = await requireUserWithOrg();
  // Viewers can't create pipelines; send them back to the project
  if (!hasMinRole(role, "developer")) redirect(`/projects/${projectId}`);

  const { data: project } = await supabase
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!project) notFound();

  return <NewPipelineForm projectName={project.name as string} />;
}
