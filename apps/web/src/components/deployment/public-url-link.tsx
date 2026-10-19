"use client";

import { formatDate } from "@/lib/format-date";
import { useState } from "react";

/** "23h left", "45m left", or null once expired. */
export function timeLeft(expiresAt: string, now: number): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m left`;
  return `${Math.floor(minutes / 60)}h left`;
}

/**
 * The deployment's temporary public URL (Cloudflare tunnel) with its
 * remaining lifetime. Renders nothing when there is no URL or it expired.
 */
export function PublicUrlLink({
  url,
  expiresAt,
  compact = false,
}: {
  readonly url: string | null | undefined;
  readonly expiresAt: string | null | undefined;
  readonly compact?: boolean;
}) {
  // Captured once per mount; good enough for a countdown measured in hours
  const [now] = useState(() => Date.now());
  if (!url || !expiresAt) return null;
  const left = timeLeft(expiresAt, now);
  if (!left) return null;
  const host = url.replace(/^https:\/\//, "");

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Public URL — expires ${formatDate(expiresAt)}`}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md border border-tertiary/25 bg-tertiary/10 text-tertiary transition-colors hover:bg-tertiary/15 ${
        compact ? "h-5 px-1.5 text-[11px]" : "h-7 px-2.5 text-xs"
      }`}
    >
      <span aria-hidden="true" className={`material-symbols-outlined ${compact ? "text-[13px]" : "text-[15px]"}`}>
        public
      </span>
      <span className="truncate font-mono">{compact ? "public" : host}</span>
      <span className="shrink-0 text-tertiary/70">· {left}</span>
      <span aria-hidden="true" className={`material-symbols-outlined ${compact ? "text-[12px]" : "text-[14px]"}`}>
        open_in_new
      </span>
    </a>
  );
}
