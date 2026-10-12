import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  isPlausibleInviteToken,
  parseInvitePreview,
  type InvitePreview,
} from "@/lib/invite-links";
import { formatDateShort } from "@/lib/format-date";
import { InviteResponse } from "./invite-response";
import { InviteSignInButton } from "./invite-sign-in-button";

export const metadata: Metadata = {
  title: "Organization invite — DeployX",
  robots: { index: false, follow: false },
  // The token is in the URL: never leak it via the Referer header.
  referrer: "no-referrer",
};

interface InvitePageProps {
  readonly params: Promise<{ token: string }>;
}

async function loadInvite(token: string) {
  const supabase = await createClient();
  const [{ data: userData }, preview] = await Promise.all([
    supabase.auth.getUser(),
    isPlausibleInviteToken(token)
      ? supabase
          .rpc("get_invite_preview" as never, { p_token: token } as never)
          .then(({ data, error }) => {
            if (error) {
              console.error("[invite] get_invite_preview failed:", error.message);
            }
            return parseInvitePreview(data);
          })
      : Promise.resolve(null),
  ]);
  return { preview, user: userData.user };
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const { preview, user } = await loadInvite(token);

  return (
    <InviteShell>
      <InviteBody token={token} preview={preview} userEmail={user ? (user.email ?? "your account") : null} />
    </InviteShell>
  );
}

function InviteBody({
  token,
  preview,
  userEmail,
}: {
  readonly token: string;
  readonly preview: InvitePreview | null;
  readonly userEmail: string | null;
}) {
  const signedIn = userEmail !== null;

  if (!preview) {
    return (
      <StateMessage
        icon="link_off"
        title="This invite link isn't valid"
        body="It may have been mistyped, cancelled by an admin, or replaced by a newer link. Ask the person who invited you to send it again."
        action={<DashboardLink signedIn={signedIn} />}
      />
    );
  }

  if (preview.status === "expired") {
    return (
      <StateMessage
        icon="schedule"
        title="This invite has expired"
        body={`The invite to ${preview.org_name} expired on ${formatDateShort(preview.expires_at)}. Ask an admin of ${preview.org_name} for a new link.`}
        action={<DashboardLink signedIn={signedIn} />}
      />
    );
  }

  if (preview.status === "accepted") {
    return (
      <StateMessage
        icon="task_alt"
        title="This invite has already been used"
        body={`Invite links work once. If you accepted it, ${preview.org_name} is waiting in your dashboard.`}
        action={<DashboardLink signedIn={signedIn} />}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <p className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
          You&apos;re invited
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">
          Join {preview.org_name}
        </h1>
      </div>

      <dl className="rounded-lg border border-outline-variant/30 divide-y divide-outline-variant/20 text-sm">
        <DetailRow label="Role">
          <span className="capitalize font-medium text-on-surface">{preview.role}</span>
        </DetailRow>
        <DetailRow label="Invited email">
          <span className="font-mono text-on-surface">{preview.email}</span>
        </DetailRow>
        <DetailRow label="Expires">
          <span className="text-on-surface">{formatDateShort(preview.expires_at)}</span>
        </DetailRow>
      </dl>

      {signedIn ? (
        <div className="space-y-4">
          <p className="text-xs text-on-surface-variant text-center">
            Signed in as <span className="font-medium text-on-surface">{userEmail}</span>.
            Accepting adds this account to {preview.org_name}.
          </p>
          <InviteResponse token={token} orgName={preview.org_name} />
        </div>
      ) : (
        <div className="space-y-3">
          <InviteSignInButton token={token} />
          <p className="text-xs text-on-surface-variant text-center">
            You&apos;ll come back here to accept after signing in.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Layout pieces ──

function InviteShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-surface">
      <main className="w-full max-w-md space-y-8">
        <div className="flex items-center justify-center gap-2.5">
          <span
            aria-hidden="true"
            className="material-symbols-outlined text-primary text-[28px]"
          >
            rocket_launch
          </span>
          <span className="text-lg font-bold tracking-tight text-on-surface">
            DeployX
          </span>
        </div>
        <section className="bg-surface-container-low border border-outline-variant/30 rounded-xl p-8">
          {children}
        </section>
      </main>
    </div>
  );
}

function StateMessage({
  icon,
  title,
  body,
  action,
}: {
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  readonly action: ReactNode;
}) {
  return (
    <div className="text-center space-y-4">
      <span
        aria-hidden="true"
        className="material-symbols-outlined text-on-surface-variant text-[40px]"
      >
        {icon}
      </span>
      <h1 className="text-xl font-bold tracking-tight text-on-surface">{title}</h1>
      <p className="text-sm text-on-surface-variant leading-relaxed">{body}</p>
      <div className="pt-2">{action}</div>
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="text-on-surface-variant">{label}</dt>
      <dd className="text-right truncate">{children}</dd>
    </div>
  );
}

function DashboardLink({ signedIn }: { readonly signedIn: boolean }) {
  return (
    <Link
      href={signedIn ? "/" : "/login"}
      className="inline-block text-sm font-medium text-primary hover:underline"
    >
      {signedIn ? "Go to your dashboard" : "Go to sign in"}
    </Link>
  );
}
