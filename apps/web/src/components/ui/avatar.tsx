"use client";

import { useState } from "react";

const SIZE_CLASS = {
  xs: "w-7 h-7 text-[10px]",
  sm: "w-8 h-8 text-xs",
  lg: "w-20 h-20 text-2xl",
} as const;

/** Up to two initials from a display name ("Eshan Shukla" → "ES"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0];
  return letters.toUpperCase();
}

/**
 * Initials sit underneath and the photo fades in on top once it loads, so a
 * slow or blocked image host never leaves an empty circle. A broken image
 * falls back to the initials.
 */
export function Avatar({
  name,
  url,
  size = "sm",
  decorative = false,
}: {
  readonly name: string;
  readonly url: string | null | undefined;
  readonly size?: keyof typeof SIZE_CLASS;
  /** true when the name is already shown next to the avatar */
  readonly decorative?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/15 font-display font-bold text-primary ring-1 ring-outline-variant/30 ${SIZE_CLASS[size]}`}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
    >
      <span aria-hidden="true">{initialsOf(name)}</span>
      {url && !failed && (
        // eslint-disable-next-line @next/next/no-img-element -- remote avatar, tiny, already sized
        <img
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </span>
  );
}
