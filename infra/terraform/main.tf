# DeployX control plane as code: the Supabase project (Postgres, Auth,
# Storage) and the Vercel project (Next.js app) with its environment.
#
#   cd infra/terraform
#   terraform init
#   terraform plan -var-file=deployx.tfvars
#   terraform apply -var-file=deployx.tfvars
#
# The live deployment was created by hand; adopt it instead of recreating:
#   terraform import supabase_project.deployx <project-ref>
#   terraform import vercel_project.web <vercel-project-id>
# Database schema stays in supabase/migrations (npx supabase db push).

terraform {
  required_version = ">= 1.6"
  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.5"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 3.0"
    }
  }
}

provider "supabase" {
  access_token = var.supabase_access_token
}

provider "vercel" {
  api_token = var.vercel_api_token
  team      = var.vercel_team_id
}

# ── Supabase ────────────────────────────────────────────────────────────────

resource "supabase_project" "deployx" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.supabase_db_password
  region            = var.supabase_region

  lifecycle {
    # The password is only used at creation; don't churn on it afterwards
    ignore_changes = [database_password]
  }
}

resource "supabase_settings" "deployx" {
  project_ref = supabase_project.deployx.id

  auth = jsonencode({
    site_url                 = var.app_url
    uri_allow_list           = "${var.app_url}/auth/callback,http://localhost:3000/auth/callback"
    external_github_enabled  = true
    external_github_client_id = var.github_oauth_client_id
    external_github_secret   = var.github_oauth_client_secret
    mfa_totp_enroll_enabled  = true
    mfa_totp_verify_enabled  = true
  })
}

data "supabase_apikeys" "deployx" {
  project_ref = supabase_project.deployx.id
}

locals {
  supabase_url = "https://${supabase_project.deployx.id}.supabase.co"
}

# ── Vercel ──────────────────────────────────────────────────────────────────

resource "vercel_project" "web" {
  name           = var.project_name
  framework      = "nextjs"
  root_directory = "apps/web"

  git_repository = {
    type = "github"
    repo = var.github_repo
  }
}

locals {
  web_env = {
    NEXT_PUBLIC_SUPABASE_URL      = { value = local.supabase_url, sensitive = false }
    NEXT_PUBLIC_SUPABASE_ANON_KEY = { value = data.supabase_apikeys.deployx.anon_key, sensitive = false }
    SUPABASE_SERVICE_ROLE_KEY     = { value = data.supabase_apikeys.deployx.service_role_key, sensitive = true }
    DEPLOYX_SECRET_KEY            = { value = var.deployx_secret_key, sensitive = true }
    CRON_SECRET                   = { value = var.cron_secret, sensitive = true }
  }
}

resource "vercel_project_environment_variable" "web" {
  for_each = local.web_env

  project_id = vercel_project.web.id
  key        = each.key
  value      = each.value.value
  target     = ["production", "preview"]
  sensitive  = each.value.sensitive
}
