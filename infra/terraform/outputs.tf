output "supabase_url" {
  value = local.supabase_url
}

output "supabase_project_ref" {
  value = supabase_project.deployx.id
}

output "vercel_project_id" {
  value = vercel_project.web.id
}
