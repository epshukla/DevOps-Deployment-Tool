"use client";

import { useState } from "react";
import { signInWithGitHub } from "@/lib/auth/github-oauth";
import { invitePath } from "@/lib/invite-links";

/** Starts GitHub OAuth and returns the user to this invite afterwards. */
export function InviteSignInButton({ token }: { readonly token: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    const result = await signInWithGitHub(invitePath(token));
    if (result.error) {
      setError(result.error);
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 bg-primary text-on-primary font-bold py-3 px-4 rounded-md text-sm transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[20px]">
          {loading ? "progress_activity" : "login"}
        </span>
        {loading ? "Redirecting to GitHub..." : "Sign in with GitHub to join"}
      </button>
      {error && (
        <p role="alert" className="text-xs text-error text-center">
          {error}
        </p>
      )}
    </div>
  );
}
