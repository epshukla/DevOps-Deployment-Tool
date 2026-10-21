variable "project_name" {
  type    = string
  default = "deployx"
}

variable "app_url" {
  description = "Public URL of the web app, e.g. https://deployx-chi.vercel.app"
  type        = string
}

variable "github_repo" {
  description = "owner/name of the repository Vercel builds"
  type        = string
  default     = "epshukla/DevOps-Deployment-Tool"
}

# Supabase
variable "supabase_access_token" {
  description = "Supabase personal access token (dashboard → Account → Access Tokens)"
  type        = string
  sensitive   = true
}

variable "supabase_org_id" {
  type = string
}

variable "supabase_region" {
  type    = string
  default = "ap-southeast-1" # Singapore, next to Vercel sin1
}

variable "supabase_db_password" {
  type      = string
  sensitive = true
}

variable "github_oauth_client_id" {
  type = string
}

variable "github_oauth_client_secret" {
  type      = string
  sensitive = true
}

# Vercel
variable "vercel_api_token" {
  type      = string
  sensitive = true
}

variable "vercel_team_id" {
  description = "Team id or slug; null for a personal account"
  type        = string
  default     = null
}

# App secrets (openssl rand -hex 32)
variable "deployx_secret_key" {
  type      = string
  sensitive = true
}

variable "cron_secret" {
  type      = string
  sensitive = true
}
