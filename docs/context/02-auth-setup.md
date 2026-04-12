# Auth Setup — Complete

## Files
| File | Purpose |
|------|---------|
| `apps/web/src/proxy.ts` | Next.js 16 proxy (was middleware.ts). Refreshes tokens via `getUser()`, protects routes, redirects. |
| `apps/web/src/lib/supabase/client.ts` | Browser client (`createBrowserClient`) for client components |
| `apps/web/src/lib/supabase/server.ts` | Server client (`createServerClient`) for server components/actions |
| `apps/web/src/app/auth/callback/route.ts` | PKCE OAuth code exchange -> session -> redirect to dashboard |
| `apps/web/src/app/(auth)/login/page.tsx` | GitHub OAuth button wired to `signInWithOAuth` |
| `apps/web/.env.local` | Supabase URL + anon key + service_role key (gitignored) |

## OAuth Flow
1. User clicks "Sign in with GitHub" on `/login`
2. `supabase.auth.signInWithOAuth({ provider: "github" })` redirects to GitHub
3. GitHub authorizes -> redirects to Supabase
4. Supabase redirects to `http://localhost:3000/auth/callback?code=...`
5. Route handler calls `exchangeCodeForSession(code)` -> sets session cookies
6. Redirects to dashboard `/`

## Protected Routes
- `/`, `/projects/*`, `/runners/*`, `/settings/*` -> redirect to `/login` if no user
- `/login` -> redirect to `/` if user already authenticated

## Next.js 16 Notes
- `middleware.ts` renamed to `proxy.ts`, export `proxy` (not `middleware`)
- Async Request APIs: `cookies()`, `headers()` must be awaited
- `@supabase/ssr` v0.6.1 cookie pattern works identically in proxy.ts
