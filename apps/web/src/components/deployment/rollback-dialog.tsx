"use client";

import { useState } from "react";
import { formatDate } from "@/lib/format-date";

interface RevisionOption {
  readonly id: string;
  readonly revision_number: number;
  readonly image_tag: string;
  readonly status: string;
  readonly created_at: string;
}

interface RollbackDialogProps {
  readonly isOpen: boolean;
  readonly revisions: readonly RevisionOption[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (targetRevisionId: string, reason: string) => void;
}

type Step = "select" | "confirm";

/**
 * Two-step rollback flow: pick a target revision + reason, review a
 * confirmation summary, then submit. The caller owns the pending/error
 * state so it can wire this to a server action with useTransition.
 */
export function RollbackDialog({
  isOpen,
  revisions,
  pending,
  error,
  onClose,
  onConfirm,
}: RollbackDialogProps) {
  const [step, setStep] = useState<Step>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (!isOpen) return null;

  const selected = revisions.find((r) => r.id === selectedId) ?? null;
  const canContinue = selectedId !== null && reason.trim().length > 0;

  const handleClose = () => {
    setStep("select");
    setSelectedId(null);
    setReason("");
    onClose();
  };

  const handleConfirm = () => {
    if (!selectedId) return;
    onConfirm(selectedId, reason.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-lg p-8 max-h-[85vh] overflow-y-auto">
        <h3 className="text-xl font-extrabold text-on-surface mb-2">
          {step === "select" ? "Roll Back Deployment" : "Confirm Rollback"}
        </h3>

        {error && (
          <div className="bg-error/10 border border-error/30 rounded-md p-3 text-xs text-error mb-4">
            {error}
          </div>
        )}

        {step === "select" ? (
          <>
            <p className="text-sm text-on-surface-variant mb-4">
              Choose a previous revision to roll back to and explain why.
            </p>

            {revisions.length === 0 ? (
              <p className="text-xs text-on-surface-variant/60 mb-6">
                No previous revisions are available to roll back to.
              </p>
            ) : (
              <div className="space-y-2 mb-6 max-h-60 overflow-y-auto pr-1">
                {revisions.map((rev) => (
                  <label
                    key={rev.id}
                    className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                      selectedId === rev.id
                        ? "border-primary bg-primary/5"
                        : "border-outline-variant/15 hover:bg-surface-container-high"
                    }`}
                  >
                    <input
                      type="radio"
                      name="target-revision"
                      className="mt-1"
                      checked={selectedId === rev.id}
                      onChange={() => setSelectedId(rev.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-on-surface">
                          #{rev.revision_number}
                        </span>
                        <span className="text-[9px] uppercase font-bold text-on-surface-variant/60">
                          {rev.status}
                        </span>
                      </div>
                      <p className="text-xs font-mono text-on-surface-variant truncate">
                        {rev.image_tag}
                      </p>
                      <p className="text-[10px] text-on-surface-variant/50">
                        {formatDate(rev.created_at)}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            )}

            <div className="space-y-2 mb-6">
              <label className="text-xs font-bold text-on-surface-variant/60 uppercase tracking-widest">
                Reason
              </label>
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why are you rolling back this deployment?"
                className="w-full bg-surface-container-lowest border-none rounded-md px-4 py-3 text-sm text-on-surface focus:ring-2 focus:ring-primary transition-all placeholder:text-on-surface-variant/30"
              />
            </div>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm font-medium text-on-surface-variant hover:text-on-surface transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canContinue}
                onClick={() => setStep("confirm")}
                className="px-6 py-2 bg-primary text-on-primary text-sm font-bold rounded-md hover:brightness-110 disabled:opacity-50 transition-all"
              >
                Review Rollback
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-on-surface-variant mb-4">
              This will mark the current revision as rolled back and switch
              this deployment to revision{" "}
              <span className="font-bold text-on-surface">#{selected?.revision_number}</span>{" "}
              (<span className="font-mono text-xs">{selected?.image_tag}</span>). This cannot be
              undone from this dialog.
            </p>

            <div className="bg-surface-container-lowest border border-outline-variant/20 rounded-md p-4 mb-6">
              <p className="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest mb-1">
                Reason
              </p>
              <p className="text-sm text-on-surface">{reason.trim()}</p>
            </div>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                disabled={pending}
                onClick={() => setStep("select")}
                className="px-4 py-2 text-sm font-medium text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={handleConfirm}
                className="flex items-center gap-2 px-6 py-2 bg-error text-on-error text-sm font-bold rounded-md hover:brightness-110 disabled:opacity-50 transition-all"
              >
                {pending && (
                  <span aria-hidden="true" className="material-symbols-outlined text-sm animate-spin">
                    progress_activity
                  </span>
                )}
                Confirm Rollback
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
