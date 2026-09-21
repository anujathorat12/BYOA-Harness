import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GatedButton } from "@/components/GatedButton";
import { Mono } from "@/components/JsonBlock";
import { api } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { approvalBlockReason } from "@/lib/roles";
import type { Approval } from "@/lib/types";

/**
 * Approve / deny controls for one approval. The buttons are DISABLED (with the reason on hover) when the role
 * cannot decide or when separation of duties forbids it, instead of letting the click fail on the server.
 * A comment is required so the audit trail records why.
 */
export function ApprovalActions({ approval, size = "default" }: { approval: Approval; size?: "default" | "sm" }) {
  const me = useMe();
  const qc = useQueryClient();
  const [verdict, setVerdict] = useState<"approve" | "deny" | null>(null);
  const [comment, setComment] = useState("");
  const blocked = approvalBlockReason(approval, me);

  const decide = useMutation({
    mutationFn: (v: "approve" | "deny") => api.decide(approval.id, v, comment.trim()),
    onSuccess: (_r, v) => {
      toast.success(v === "approve" ? "Approved — the agent resumes" : "Denied — the agent's call fails");
      setVerdict(null);
      setComment("");
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      void qc.invalidateQueries({ queryKey: ["session", approval.session_id] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  return (
    <>
      <div className="flex gap-2">
        <GatedButton size={size} blockReason={blocked} onClick={() => setVerdict("approve")} data-testid={`approve-${approval.id}`} className="bg-emerald-600 text-white hover:bg-emerald-700">
          <Check className="size-4" /> Approve
        </GatedButton>
        <GatedButton size={size} variant="outline" blockReason={blocked} onClick={() => setVerdict("deny")} data-testid={`deny-${approval.id}`} className="border-red-300 text-red-700 hover:bg-red-50">
          <X className="size-4" /> Deny
        </GatedButton>
      </div>

      <Dialog open={verdict !== null} onOpenChange={(o) => { if (!o) { setVerdict(null); decide.reset(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{verdict === "approve" ? "Approve this action?" : "Deny this action?"}</DialogTitle>
            <DialogDescription>
              <Mono>{approval.action.type}</Mono> on <Mono>{approval.action.resource}</Mono> requested by <b>{approval.submitted_by}</b>'s session.
              {verdict === "approve" ? " The frozen agent resumes and the action executes exactly as shown." : " The agent's call fails and the action never executes."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={`comment-${approval.id}`}>Comment (required — recorded in the audit trail)</Label>
            <Textarea id={`comment-${approval.id}`} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
          </div>
          {decide.isError && <p role="alert" className="text-sm text-destructive">{decide.error.message}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setVerdict(null)}>Cancel</Button>
            <Button
              onClick={() => verdict && decide.mutate(verdict)}
              disabled={!comment.trim() || decide.isPending}
              className={verdict === "approve" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700"}
              data-testid="confirm-decision"
            >
              {decide.isPending ? "Sending…" : verdict === "approve" ? "Confirm approve" : "Confirm deny"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
