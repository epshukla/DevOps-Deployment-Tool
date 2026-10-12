"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { acceptInviteLink, declineInviteLink } from "./actions";

type Choice = "accept" | "decline";

/** Accept / Decline buttons for a signed-in visitor holding a valid link. */
export function InviteResponse({
  token,
  orgName,
}: {
  readonly token: string;
  readonly orgName: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);

  function respond(next: Choice) {
    setChoice(next);
    setError(null);
    startTransition(async () => {
      // On success, accept redirects to the dashboard server-side.
      const result =
        next === "accept"
          ? await acceptInviteLink(token)
          : await declineInviteLink(token);
      if (result?.error) {
        setError(result.error);
        return;
      }
      if (next === "decline") setDeclined(true);
    });
  }

  if (declined) {
    return (
      <div className="text-center space-y-3">
        <p className="text-sm text-on-surface">
          You declined the invite to {orgName}. The link no longer works.
        </p>
        <Link href="/" className="text-sm font-medium text-primary hover:underline">
          Go to your dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => respond("accept")}
          disabled={isPending}
          className="flex-1 bg-primary text-on-primary font-bold py-3 px-4 rounded-md text-sm transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isPending && choice === "accept" ? "Joining..." : `Join ${orgName}`}
        </button>
        <button
          type="button"
          onClick={() => respond("decline")}
          disabled={isPending}
          className="px-4 py-3 rounded-md text-sm font-medium text-on-surface-variant border border-outline-variant/40 hover:text-on-surface transition-colors disabled:opacity-50"
        >
          {isPending && choice === "decline" ? "Declining..." : "Decline"}
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="text-sm text-error bg-error/10 border border-error/20 rounded-md px-3 py-2 text-center"
        >
          {error}
        </p>
      )}
    </div>
  );
}
