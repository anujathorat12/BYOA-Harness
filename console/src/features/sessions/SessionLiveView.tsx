import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hourglass, Radio, WifiOff } from "lucide-react";
import { JsonBlock, Mono } from "@/components/JsonBlock";
import { ErrorNote, LoadingRows } from "@/components/states";
import { StatusBadge } from "@/components/badges";
import { api } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { can } from "@/lib/roles";
import { elapsed, useNow } from "@/lib/useNow";
import { ApprovalActions } from "@/features/approvals/ApprovalActions";
import { SessionTimeline } from "./SessionTimeline";
import { buildTimeline } from "./timeline";
import { useSessionEvents, type StreamState } from "./useSessionEvents";

const TERMINAL = ["succeeded", "failed", "cancelled"];

export function StreamIndicator({ state }: { state: StreamState }) {
  if (state === "live") return <span className="flex items-center gap-1.5 text-xs text-emerald-700" data-testid="stream-state"><Radio className="size-3.5 animate-pulse" /> live</span>;
  if (state === "ended") return <span className="text-xs text-muted-foreground" data-testid="stream-state">stream ended</span>;
  if (state === "reconnecting") return <span className="flex items-center gap-1.5 text-xs text-amber-700" data-testid="stream-state"><WifiOff className="size-3.5" /> reconnecting…</span>;
  if (state === "error") return <span className="text-xs text-red-700" data-testid="stream-state">stream unavailable</span>;
  return <span className="text-xs text-muted-foreground" data-testid="stream-state">connecting…</span>;
}

/**
 * The live picture of one session: status, the frozen-for-approval banner, and the per-call timeline fed by SSE.
 * Used full-page on the session screen and embedded beside the approval queue, so approving in one place
 * visibly resumes the session in the other (real `docker unpause`, real event).
 */
export function SessionLiveView({ sessionId }: { sessionId: string }) {
  const me = useMe();
  const now = useNow();
  const { events, state, error } = useSessionEvents(sessionId);
  const session = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.session(sessionId),
    refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status) ? false : 2000),
  });
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const s = session.data;
  const terminal = !!s && TERMINAL.includes(s.status);
  const frozen = !terminal ? timeline.frozen : null;

  // The pending approval object (needed for the separation-of-duties check) for the inline decision buttons.
  const canReadApprovals = can(me.roles, "approval.read");
  const pending = useQuery({ queryKey: ["approvals", "pending"], queryFn: () => api.approvals("pending"), enabled: canReadApprovals && !!frozen, refetchInterval: 2000 });
  const approval = frozen ? pending.data?.find((a) => a.id === frozen.approvalId) : undefined;

  if (session.isPending) return <LoadingRows rows={3} />;
  if (session.isError) return <ErrorNote error={session.error} title="Could not load session" />;
  if (error) return <ErrorNote error={new Error(error)} title="Event stream unavailable" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={s!.status} frozen={!!frozen} />
        <StreamIndicator state={state} />
        <span className="text-xs text-muted-foreground">
          {s!.action_count} actions · {s!.spent_tokens} tokens · {s!.spent_amount.toFixed(2)} spent
        </span>
        <span className="flex flex-wrap gap-1 text-xs">
          {s!.policies.length === 0 ? <span className="text-amber-800">deny-all (no policy attached)</span> : s!.policies.map((p) => <Mono key={`${p.id}${p.source}`} className="rounded bg-muted px-1.5 py-0.5">{p.id}@v{p.version} · {p.source}</Mono>)}
        </span>
      </div>

      {frozen && (
        <div className="rounded-md border-2 border-amber-300 bg-amber-50 p-4" data-testid="frozen-banner">
          <div className="flex items-center gap-2 font-semibold text-amber-900"><Hourglass className="size-5" /> Frozen — waiting on a human decision</div>
          <p className="mt-1 text-sm text-amber-900/90">
            The sandbox is paused (cgroup freezer). It wants to run <Mono className="font-semibold">{frozen.actionType}</Mono> on <Mono className="font-semibold">{frozen.resource}</Mono>.
            Frozen for <Mono data-testid="frozen-timer">{elapsed(frozen.since, now)}</Mono>; frozen time does not count against the session's runtime limit.
          </p>
          <div className="mt-3">
            {approval ? <ApprovalActions approval={approval} /> : (
              <p className="text-xs text-amber-900/80">
                {canReadApprovals ? "Loading the approval…" : "Only an approver can decide this. Your role cannot see or decide approvals."}
              </p>
            )}
          </div>
        </div>
      )}

      <SessionTimeline timeline={timeline} />

      {terminal && (s!.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="session-error"><b>Failed:</b> {s!.error}</div>
      ) : s!.result != null ? (
        <div><h3 className="mb-1 text-sm font-semibold">Result</h3><JsonBlock value={s!.result} data-testid="session-result" /></div>
      ) : null)}
    </div>
  );
}
