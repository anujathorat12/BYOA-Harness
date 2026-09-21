import { useMutation } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { GatedButton } from "@/components/GatedButton";
import { Mono } from "@/components/JsonBlock";
import { api } from "@/lib/api";

/**
 * Recomputes the session's hash chain on the server and reports the result plainly.
 * Each audit row commits to the previous row's hash, so any edit, deletion or reordering inside a session breaks it.
 */
export function ChainVerifier({ sessionId }: { sessionId: string }) {
  const verify = useMutation({ mutationFn: () => api.verifyChain(sessionId) });
  const r = verify.data;
  return (
    <div className="space-y-2">
      <GatedButton cap="audit.verify" variant="outline" size="sm" onClick={() => verify.mutate()} disabled={verify.isPending} data-testid="verify-chain">
        <ShieldCheck className="size-4" /> {verify.isPending ? "Verifying…" : "Verify hash chain"}
      </GatedButton>
      {verify.isError && <p role="alert" className="text-sm text-destructive">{verify.error.message}</p>}
      {r?.valid === true && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="chain-result">
          <ShieldCheck className="mt-0.5 size-5 shrink-0" />
          <div>
            <div className="font-semibold">Chain intact</div>
            <div>{r.events} events verified — none altered, removed or reordered.</div>
            <div className="text-xs">head <Mono>{r.head_hash.slice(0, 24)}…</Mono></div>
          </div>
        </div>
      )}
      {r?.valid === false && (
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900" data-testid="chain-result">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          <div>
            <div className="font-semibold">Chain BROKEN — tampering or data loss detected</div>
            <div>First inconsistent event: sequence <b>{r.broken_at_seq}</b> ({r.reason}). {r.events} events present.</div>
          </div>
        </div>
      )}
    </div>
  );
}
