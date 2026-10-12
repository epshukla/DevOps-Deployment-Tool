import { notFound } from "next/navigation";
import { requireUserWithOrg } from "@/lib/auth/session";
import { NewPipelineForm } from "./new-pipeline-form";

interface NewPipelinePageProps {
  readonly params: Promise<{ projectId: string }>;
}

export default async function NewPipelinePage({ params }: NewPipelinePageProps) {
  const { projectId } = await params;
  const { supabase, org } = await requireUserWithOrg();

  const { data: project } = await supabase
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!project) notFound();

  return <NewPipelineForm projectName={project.name as string} />;
}
