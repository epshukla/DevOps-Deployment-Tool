"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A link to a create/edit flow that renders as a greyed-out, non-navigating
 * element (with the reason as a tooltip) when the user lacks the role.
 */
export function GatedLink({
  href,
  allowed,
  reason,
  className,
  children,
}: {
  readonly href: string;
  readonly allowed: boolean;
  readonly reason?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  if (allowed) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <span
      role="link"
      aria-disabled="true"
      title={reason}
      className={`${className ?? ""} cursor-not-allowed opacity-50`}
    >
      {children}
    </span>
  );
}
