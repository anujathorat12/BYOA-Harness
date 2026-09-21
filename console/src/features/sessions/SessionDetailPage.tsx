import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban } from "lucide-react";
import { toast } from "sonner";
import { GatedButton } from "@/components/GatedButton";
import { Mono } from "@/components/JsonBlock";
import { PageHeader } from "@/components/states";
import { api } from "@/lib/api";
import { formatTs } from "@/lib/format";
import { SessionLiveView } from "./SessionLiveView";

export function SessionDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ["session", id], queryFn: () => api.session(id) });
  const cancel = useMutation({
    mutationFn: () => api.cancel(id),
    onSuccess: (r) => {
      toast[r.cancelled ? "success" : "info"](r.cancelled ? "Cancel requested — the sandbox is being destroyed" : "Session already finished");
      void qc.invalidateQueries({ queryKey: ["session", id] });
    },
    onError: (e) => toast.error(e.message),
  });
  const s = session.data;
  const terminal = !!s && ["succeeded", "failed", "cancelled"].includes(s.status);

  return (
    <>
      <Link to="/sessions" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> All sessions</Link>
      <PageHeader
        title={`Session ${id}`}
        description={s ? `Agent ${s.agent_id} v${s.agent_version} · submitted by ${s.submitted_by} · ${formatTs(s.created_at)}` : undefined}
        actions={
          <GatedButton cap="session.submit" blockReason={terminal ? "Session already finished" : null} variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending} data-testid="cancel-session">
            <Ban className="size-4" /> Cancel session
          </GatedButton>
        }
      />
      {s && <p className="mb-4 text-xs text-muted-foreground">Agent: <Link className="text-sky-700 hover:underline" to="/agents"><Mono>{s.agent_id}</Mono></Link></p>}
      <SessionLiveView sessionId={id} />
    </>
  );
}
