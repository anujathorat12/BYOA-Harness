import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApprovalStatusBadge } from "@/components/badges";
import { JsonBlock, Mono } from "@/components/JsonBlock";
import { ErrorNote, Empty, LoadingRows, PageHeader, Restricted } from "@/components/states";
import { api } from "@/lib/api";
import { formatTs, shortId, timeAgo } from "@/lib/format";
import { countdown, useNow } from "@/lib/useNow";
import type { Approval, ApprovalStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SessionLiveView } from "@/features/sessions/SessionLiveView";
import { ApprovalActions } from "./ApprovalActions";

const STATUSES: (ApprovalStatus | "all")[] = ["pending", "approved", "denied", "expired", "all"];

export function ApprovalsPage() {
  return (
    <>
      <PageHeader
        title="Approval Queue"
        description="Actions a policy marked require-approval. The agent is genuinely frozen until you decide. Select one to watch its session live and see it resume the moment you approve."
      />
      <Restricted cap="approval.read" what="The approval queue">
        <Queue />
      </Restricted>
    </>
  );
}

function Queue() {
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") as ApprovalStatus | "all" | null) ?? "pending";
  const selected = params.get("selected");
  const now = useNow();
  const list = useQuery({
    queryKey: ["approvals", status],
    queryFn: () => api.approvals(status === "all" ? "" : status),
    refetchInterval: status === "pending" ? 2000 : 8000,
  });

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  // Keep something selected so the live session panel is never blank when there is work to do.
  const first = list.data?.[0]?.id;
  const selectedApproval = list.data?.find((a) => a.id === selected);
  useEffect(() => {
    if (!selectedApproval && first) setParam("selected", first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, selectedApproval?.id]);

  return (
    <>
      <Tabs value={status} onValueChange={(v) => { const n = new URLSearchParams(params); n.set("status", v); n.delete("selected"); setParams(n); }} className="mb-4">
        <TabsList>{STATUSES.map((s) => <TabsTrigger key={s} value={s} className="capitalize">{s}</TabsTrigger>)}</TabsList>
      </Tabs>
      <div className="grid grid-cols-[minmax(420px,1fr)_minmax(0,1.2fr)] gap-6">
        <div className="space-y-3" data-testid="approval-list">
          {list.isPending ? <LoadingRows /> : list.isError ? <ErrorNote error={list.error} title="Could not load approvals" /> : list.data.length === 0 ? (
            <Empty>{status === "pending" ? "Nothing is waiting on you. No agent is frozen." : `No ${status === "all" ? "" : status + " "}approvals.`}</Empty>
          ) : list.data.map((a) => <ApprovalCard key={a.id} a={a} now={now} active={a.id === selected} onSelect={() => setParam("selected", a.id)} />)}
        </div>
        <div className="min-w-0 rounded-md border bg-card p-4" data-testid="live-panel">
          {selectedApproval ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Live session</h2>
                <Link className="text-xs text-sky-700 hover:underline" to={`/sessions/${selectedApproval.session_id}`}>open full view →</Link>
              </div>
              <SessionLiveView sessionId={selectedApproval.session_id} />
            </>
          ) : <p className="py-10 text-center text-sm text-muted-foreground">Select an approval to watch its session live.</p>}
        </div>
      </div>
    </>
  );
}

function ApprovalCard({ a, now, active, onSelect }: { a: Approval; now: number; active: boolean; onSelect: () => void }) {
  return (
    <div className={cn("rounded-md border bg-card p-4", active && "ring-2 ring-primary/40")} data-testid={`approval-${a.id}`} onClick={onSelect}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Mono className="text-[13px] font-semibold">{a.action.type}</Mono>
          <Mono className="text-muted-foreground">{a.action.resource}</Mono>
        </div>
        <ApprovalStatusBadge status={a.status} />
      </div>
      <dl className="mb-3 grid grid-cols-[110px_1fr] gap-y-1 text-xs">
        <dt className="text-muted-foreground">Agent</dt><dd>{a.agent_id}</dd>
        <dt className="text-muted-foreground">Submitted by</dt><dd data-testid="submitted-by">{a.submitted_by}</dd>
        <dt className="text-muted-foreground">Rule</dt><dd><Mono>{a.rule_id}</Mono> <span className="text-muted-foreground">({a.policy_ref})</span></dd>
        <dt className="text-muted-foreground">Session</dt><dd><Link className="text-sky-700 hover:underline" to={`/sessions/${a.session_id}`} onClick={(e) => e.stopPropagation()}><Mono>{shortId(a.session_id)}</Mono></Link></dd>
        <dt className="text-muted-foreground">Requested</dt><dd title={formatTs(a.requested_at)}>{timeAgo(a.requested_at, now)}</dd>
        {a.status === "pending" ? (
          <><dt className="text-muted-foreground">Auto-denies in</dt><dd className="font-mono">{countdown(a.expires_at, now)}</dd></>
        ) : (
          <><dt className="text-muted-foreground">Decided</dt><dd>{a.decided_by} · {formatTs(a.decided_at)}{a.comment && <> — “{a.comment}”</>}</dd></>
        )}
      </dl>
      {Object.keys(a.action.params).length > 0 && <JsonBlock value={a.action.params} className="mb-3 max-h-28" />}
      {a.status === "pending" && <ApprovalActions approval={a} />}
    </div>
  );
}
