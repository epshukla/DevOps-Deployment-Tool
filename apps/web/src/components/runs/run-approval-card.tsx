"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitApprovalVote } from "@/app/(dashboard)/projects/[projectId]/deployments/actions";
import { formatDate } from "@/lib/format-date";

interface ApprovalVoteData {
  readonly id: string;
  readonly user_id: string;
  readonly voter_name: string;
  readonly decision: string;
  readonly comment: string | null;
  readonly created_at: string;
}

interface ApprovalData {
  readonly id: string;
  readonly task_run_id: string;
  readonly task_name: string;
  readonly status: string;
  readonly required_approvals: number;
  readonly votes: readonly ApprovalVoteData[];
}

interface RunApprovalCardProps {
  readonly projectId: string;
  readonly approval: ApprovalData;
}

const STATUS_BADGE: Record<string, { text: string; className: string }> = {
  pending: { text: "Awaiting Approval", className: "bg-[#f59e0b]/10 text-[#f59e0b]" },
  approved: { text: "Approved", className: "bg-tertiary/10 text-tertiary" },
  rejected: { text: "Rejected", className: "bg-error/10 text-error" },
};

export function RunApprovalCard({ projectId, approval }: RunApprovalCardProps) {
  const [comment, setComment] = useState("");
  const [voteError, setVoteError] = useState<string | null>(null);
  const [isVoting, startVoteTransition] = useTransition();
  const router = useRouter();

  const approveCount = approval.votes.filter((v) => v.decision === "approve").length;
  const isPending = approval.status === "pending";
  const statusBadge = STATUS_BADGE[approval.status] ?? {
    text: approval.status,
    className: "bg-on-surface-variant/10 text-on-surface-variant",
  };

  const handleVote = (decision: "approve" | "reject") => {
    setVoteError(null);
    startVoteTransition(async () => {
      const result = await submitApprovalVote(
        projectId,
        approval.id,
        decision,
        comment.trim() || undefined,
      );
      if (result.error) {
        setVoteError(result.error);
      } else {
        setComment("");
        router.refresh();
      }
    });
  };

  return (
    <div className="bg-surface-container rounded-lg p-6 ring-1 ring-[#f59e0b]/30">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-[#f59e0b]">approval</span>
          <h3 className="text-sm font-bold text-on-surface">
            Approval Required — {approval.task_name}
          </h3>
          <span className={`px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase ${statusBadge.className}`}>
            {statusBadge.text}
          </span>
        </div>
        <span className="text-xs text-on-surface-variant">
          {approveCount}/{approval.required_approvals} approval
          {approval.required_approvals !== 1 ? "s" : ""}
        </span>
      </div>

      {approval.votes.length > 0 && (
        <div className="space-y-2 mb-4">
          {approval.votes.map((vote) => (
            <div key={vote.id} className="flex items-center gap-3 text-xs">
              <span
                className={`material-symbols-outlined text-sm ${
                  vote.decision === "approve" ? "text-tertiary" : "text-error"
                }`}
              >
                {vote.decision === "approve" ? "check_circle" : "cancel"}
              </span>
              <span className="text-on-surface font-medium">{vote.voter_name}</span>
              <span className="text-on-surface-variant capitalize">{vote.decision}d</span>
              {vote.comment && (
                <span className="text-on-surface-variant">— {vote.comment}</span>
              )}
              <span className="text-on-surface-variant/50 ml-auto">
                {formatDate(vote.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}

      {voteError && <p className="text-xs text-error mb-3">{voteError}</p>}

      {isPending && (
        <div className="space-y-3">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment..."
            rows={2}
            className="w-full bg-surface-container-lowest border-none rounded-md px-3 py-2 text-xs text-on-surface focus:ring-1 focus:ring-primary transition-all placeholder:text-on-surface-variant/30 resize-none"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={() => handleVote("approve")}
              disabled={isVoting}
              className="flex items-center gap-1.5 px-4 py-2 bg-tertiary text-on-tertiary text-xs font-bold rounded hover:bg-tertiary/90 transition-colors disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">check</span>
              Approve
            </button>
            <button
              onClick={() => handleVote("reject")}
              disabled={isVoting}
              className="flex items-center gap-1.5 px-4 py-2 border border-error/30 text-error text-xs font-bold rounded hover:bg-error/10 transition-colors disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">close</span>
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
