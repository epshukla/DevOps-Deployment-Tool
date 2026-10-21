import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { MfaClient } from "./mfa-client";

export const metadata: Metadata = {
  title: "Two-factor authentication — DeployX",
  robots: { index: false, follow: false },
};

interface MfaPageProps {
  readonly searchParams: Promise<{ reason?: string }>;
}

/**
 * Enroll a TOTP authenticator, or complete the second factor for this
 * session. Uses requireUser (not requireUserWithOrg) so it can't redirect
 * back to itself.
 */
export default async function MfaPage({ searchParams }: MfaPageProps) {
  const { supabase } = await requireUser();
  const { reason } = await searchParams;
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verified = (factors?.totp ?? []).filter((f) => f.status === "verified");

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-surface">
      <div className="w-full max-w-sm bg-surface-container-low border border-outline-variant rounded-lg p-6">
        <h1 className="text-lg font-semibold text-on-surface mb-1">Two-factor authentication</h1>
        <p className="text-xs text-on-surface-variant mb-5">
          {reason === "enroll"
            ? "Your organization requires Owners and Admins to use an authenticator app."
            : verified.length > 0
              ? "Enter the 6-digit code from your authenticator app to continue."
              : "Protect your account with an authenticator app (Google Authenticator, 1Password, Authy…)."}
        </p>
        <MfaClient verifiedFactorId={verified[0]?.id ?? null} />
      </div>
    </main>
  );
}
