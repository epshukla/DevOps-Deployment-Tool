"use client";

import { useState, useSyncExternalStore } from "react";
import { inviteUrl } from "@/lib/invite-links";

function subscribeNever(): () => void {
  return () => {};
}

/** The deployment's own origin, so links work on preview and prod alike. */
function useOrigin(): string {
  return useSyncExternalStore(
    subscribeNever,
    () => window.location.origin,
    () => "",
  );
}

/**
 * Read-only invite URL with a copy button. Copy falls back to selecting the
 * text when the Clipboard API is unavailable (e.g. non-secure contexts).
 */
export function InviteLinkField({
  token,
  compact = false,
}: {
  readonly token: string;
  readonly compact?: boolean;
}) {
  const origin = useOrigin();
  const url = origin ? inviteUrl(origin, token) : "";
  const [copied, setCopied] = useState(false);
  const inputId = `invite-link-${token.slice(0, 8)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      input?.select();
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={copy}
        disabled={!url}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-50"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[15px]">
          {copied ? "check" : "link"}
        </span>
        {copied ? "Copied" : "Copy link"}
      </button>
    );
  }

  return (
    <div className="flex gap-2">
      <label htmlFor={inputId} className="sr-only">
        Invite link
      </label>
      <input
        id={inputId}
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="h-9 min-w-0 flex-1 rounded-md border border-outline-variant bg-surface-container-lowest px-3 font-mono text-xs text-on-surface"
      />
      <button
        type="button"
        onClick={copy}
        disabled={!url}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-on-primary transition-colors hover:bg-primary-container disabled:opacity-50"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
          {copied ? "check" : "content_copy"}
        </span>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
