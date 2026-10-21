"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setNotifyWebhook, setRequireMfa } from "./security-actions";

interface SecurityCardProps {
  readonly isOwner: boolean;
  readonly requireMfa: boolean;
  readonly notifyWebhookUrl: string | null;
  readonly myMfaEnabled: boolean;
}

/** Account 2FA status, the org MFA policy and the notification webhook. */
export function SecurityCard({ isOwner, requireMfa, notifyWebhookUrl, myMfaEnabled }: SecurityCardProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [webhook, setWebhook] = useState(notifyWebhookUrl ?? "");

  const run = (fn: () => Promise<{ error?: string }>, message: string) => {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
      else {
        setSaved(message);
        router.refresh();
      }
    });
  };

  return (
    <div className="relative z-20 px-8 pb-8 max-w-[1600px] mx-auto">
      <section className="bg-surface-container-low rounded-lg border border-outline-variant divide-y divide-outline-variant/10">
        <div className="px-6 py-4">
          <h3 className="text-sm font-bold text-on-surface">Security &amp; integrations</h3>
          {error && <p role="alert" className="text-xs text-error mt-1">{error}</p>}
          {saved && <p className="text-xs text-tertiary mt-1">{saved}</p>}
        </div>

        <div className="px-6 py-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-on-surface">Your two-factor authentication</p>
            <p className="text-xs text-on-surface-variant">
              {myMfaEnabled ? "On — every sign-in asks for a code from your authenticator app." : "Off"}
            </p>
          </div>
          {!myMfaEnabled && (
            <Link href="/mfa" className="px-3 py-1.5 text-xs font-bold rounded bg-primary text-on-primary">
              Set up
            </Link>
          )}
        </div>

        <div className="px-6 py-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-on-surface">Require MFA for Owners and Admins</p>
            <p className="text-xs text-on-surface-variant">
              They are sent to set up an authenticator before they can use the dashboard.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-on-surface-variant" title={isOwner ? undefined : "Owner only"}>
            <input
              type="checkbox"
              checked={requireMfa}
              disabled={!isOwner || isPending}
              onChange={(e) => {
                const enabled = e.target.checked;
                run(() => setRequireMfa(enabled), enabled ? "MFA is now required" : "MFA requirement removed");
              }}
            />
            {requireMfa ? "Required" : "Optional"}
          </label>
        </div>

        <form
          className="px-6 py-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => setNotifyWebhook(webhook), webhook ? "Webhook saved" : "Webhook removed");
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-on-surface-variant flex-1 min-w-[16rem]">
            Notification webhook (Slack, Discord or any JSON endpoint)
            <input
              type="url"
              value={webhook}
              disabled={!isOwner || isPending}
              onChange={(e) => setWebhook(e.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              className="bg-surface-container-highest border border-outline-variant rounded px-2 py-1.5 text-xs font-mono text-on-surface"
            />
          </label>
          <button
            type="submit"
            disabled={!isOwner || isPending}
            title={isOwner ? undefined : "Owner only"}
            className="px-3 py-1.5 text-xs font-bold rounded bg-primary text-on-primary disabled:opacity-40"
          >
            Save
          </button>
        </form>
      </section>
    </div>
  );
}
