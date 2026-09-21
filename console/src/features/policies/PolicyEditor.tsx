import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { GatedButton } from "@/components/GatedButton";
import { api } from "@/lib/api";
import type { Validation } from "./useLiveValidation";

export const POLICY_TEMPLATE = `id: my-policy
description: What this policy is for
rules:
  - id: allow-read-logs
    decision: allow
    match: { type: data.read, resource: "prod.logs*" }
  - id: prod-change-needs-approval
    decision: require-approval
    match: { type: production.modify }
    reason: A human must approve production changes
`;

export function ValidationBanner({ v }: { v: Validation }) {
  if (v.state === "idle") return <p className="text-sm text-muted-foreground">Start typing: the server validates the document as you go.</p>;
  if (v.state === "checking") {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Validating with the server…</p>;
  }
  if (v.state === "valid") {
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-700" data-testid="validation-ok">
        <CheckCircle2 className="size-4" /> Valid — policy <b>{v.result.id}</b>, {v.result.rules} rule{v.result.rules === 1 ? "" : "s"}
        <span className="font-mono text-xs text-muted-foreground">#{v.result.content_hash.slice(0, 10)}</span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="validation-error">
      <XCircle className="mt-0.5 size-4 shrink-0" /> <span className="break-words">{v.message}</span>
    </p>
  );
}

export function PolicyEditor({
  draft, onChange, validation, onSaved,
}: { draft: string; onChange: (s: string) => void; validation: Validation; onSaved: (id: string, version: number) => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.createPolicy(draft),
    onSuccess: (res) => {
      if (res.unchanged) toast.info(`No change — identical to ${res.id} v${res.version}`);
      else toast.success(`Created ${res.id} v${res.version}`, { description: "Existing sessions keep their pinned version." });
      void qc.invalidateQueries({ queryKey: ["policies"] });
      onSaved(res.id, res.version);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-3">
      <Textarea
        aria-label="Policy document"
        spellCheck={false}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        rows={22}
        className="font-mono text-xs leading-relaxed"
      />
      <ValidationBanner v={validation} />
      <div className="flex items-center gap-3">
        <GatedButton cap="policy.write" onClick={() => save.mutate()} disabled={validation.state !== "valid" || save.isPending} data-testid="save-policy">
          {save.isPending ? "Saving…" : "Save as new version"}
        </GatedButton>
        <p className="text-xs text-muted-foreground">
          Versions are immutable. The <code>id</code> in the document decides which policy receives the new version. Only administrators can save;
          anyone with policy access can draft and dry-run.
        </p>
      </div>
    </div>
  );
}
