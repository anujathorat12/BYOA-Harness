import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EffectBadge, StatusBadge } from "@/components/badges";
import { DataTable } from "@/components/DataTable";
import { Mono } from "@/components/JsonBlock";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/states";
import { api } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { formatDuration, formatTs, shortId } from "@/lib/format";
import { can, requirement } from "@/lib/roles";
import type { ActiveSession, AuditEvent, Session } from "@/lib/types";

function Stat({ label, value, sub, to, testId }: { label: string; value: React.ReactNode; sub?: string; to?: string; testId?: string }) {
  const body = (
    <Card className="h-full">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tabular-nums" data-testid={testId}>{value}</div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

const activeCols: ColumnDef<ActiveSession>[] = [
  { header: "Session", accessorKey: "session_id", cell: ({ row }) => <Link className="text-sky-700 hover:underline" to={`/sessions/${row.original.session_id}`}><Mono>{shortId(row.original.session_id)}</Mono></Link> },
  { header: "Agent", accessorKey: "agent_id" },
  { header: "State", id: "state", cell: ({ row }) => <StatusBadge status="running" frozen={row.original.paused} /> },
  { header: "Active", accessorKey: "active_seconds", cell: ({ row }) => formatDuration(row.original.active_seconds) },
  { header: "Actions", accessorKey: "actions" },
  { header: "Tokens", accessorKey: "spent_tokens" },
  { header: "Spend", accessorKey: "spent_amount", cell: ({ row }) => row.original.spent_amount.toFixed(2) },
  { header: "CPU", id: "cpu", cell: ({ row }) => <Mono>{row.original.sandbox.cpu ?? "—"}</Mono> },
  { header: "Memory", id: "mem", cell: ({ row }) => <Mono>{row.original.sandbox.memory ?? "—"}</Mono> },
  { header: "Pids", id: "pids", cell: ({ row }) => <Mono>{row.original.sandbox.pids ?? "—"}</Mono> },
  { header: "Limits", id: "limits", cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.limits.memory_mb} MB · {row.original.limits.cpus} cpu · {row.original.limits.timeout_s}s</span> },
];

const denialCols: ColumnDef<AuditEvent>[] = [
  { header: "Time", accessorKey: "ts", cell: ({ row }) => <Mono>{formatTs(row.original.ts)}</Mono> },
  { header: "Agent", accessorKey: "agent_id" },
  { header: "Action", id: "action", cell: ({ row }) => <Mono>{row.original.action_type ?? "—"} {row.original.resource ?? ""}</Mono> },
  { header: "Rule", accessorKey: "rule_id", cell: ({ row }) => <Mono>{row.original.rule_id}</Mono> },
  { header: "Policy", id: "policy", cell: ({ row }) => (row.original.policy_id ? <Mono>{row.original.policy_id}@v{row.original.policy_version}</Mono> : <span className="text-muted-foreground">harness</span>) },
  { header: "Session", id: "session", cell: ({ row }) => <Link className="text-sky-700 hover:underline" to={`/sessions/${row.original.session_id}`}><Mono>{shortId(row.original.session_id)}</Mono></Link> },
];

const mineCols: ColumnDef<Session>[] = [
  { header: "Session", accessorKey: "id", cell: ({ row }) => <Link className="text-sky-700 hover:underline" to={`/sessions/${row.original.id}`}><Mono>{shortId(row.original.id)}</Mono></Link> },
  { header: "Agent", accessorKey: "agent_id" },
  { header: "Status", id: "status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
  { header: "Started", accessorKey: "created_at", cell: ({ row }) => <Mono>{formatTs(row.original.created_at)}</Mono> },
];

export function OverviewPage() {
  const me = useMe();
  const canOverview = can(me.roles, "overview.read");
  const canAudit = can(me.roles, "audit.read");

  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const ready = useQuery({ queryKey: ["ready"], queryFn: api.readiness, refetchInterval: 5000 });
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, enabled: canOverview, refetchInterval: 3000 });
  const denials = useQuery({
    queryKey: ["audit", "recent-denials"],
    queryFn: () => api.audit({ effect: "deny", kind: "action.decided" }, { order: "desc", limit: 8 }),
    enabled: canAudit,
    refetchInterval: 5000,
  });
  const mine = useQuery({ queryKey: ["sessions", "mine"], queryFn: () => api.sessions({ limit: 10 }), enabled: !canOverview, refetchInterval: 5000 });

  const o = overview.data;
  return (
    <>
      <PageHeader
        title="Overview"
        description="What is running, what is waiting on a human, what was blocked, and whether the platform itself is healthy."
        actions={
          <a className="text-xs text-sky-700 hover:underline" href="/metrics" target="_blank" rel="noreferrer">
            Prometheus metrics ↗
          </a>
        }
      />

      <div className="mb-4 grid grid-cols-4 gap-4">
        <Card className="h-full">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Platform health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm" data-testid="health-card">
            {ready.data ? (
              Object.entries(ready.data.checks).map(([name, state]) => (
                <div key={name} className="flex items-center gap-2">
                  {state === "ok" ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-red-600" />}
                  <span className="capitalize">{name === "sandbox" ? "Docker daemon" : name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{state}</span>
                </div>
              ))
            ) : ready.isError ? (
              <div className="flex items-center gap-2 text-red-700"><XCircle className="size-4" /> Harness unreachable</div>
            ) : (
              <LoadingRows rows={2} />
            )}
            {health.data && <div className="pt-1 text-xs text-muted-foreground">API v{health.data.version}</div>}
          </CardContent>
        </Card>
        <Stat label="Running" testId="stat-running" value={canOverview ? (o ? `${o.active_sessions.length}/${o.capacity.max_concurrent}` : "…") : "—"} sub={canOverview ? "sessions / concurrent capacity" : `overview needs ${requirement("overview.read")}`} />
        <Stat label="Queued" testId="stat-queued" value={canOverview ? (o ? (o.sessions.queued ?? 0) : "…") : "—"} sub={o ? `queue limit ${o.capacity.max_queued}` : undefined} />
        <Stat label="Awaiting approval" testId="stat-approvals" to={can(me.roles, "approval.read") ? "/approvals" : undefined} value={canOverview ? (o ? o.pending_approvals.length : "…") : "—"} sub="agents frozen until a human decides" />
      </div>

      {!canOverview ? (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            The operational overview is limited to auditor and approver roles. Showing your own recent sessions instead.
          </p>
          {mine.isPending ? <LoadingRows /> : mine.isError ? <ErrorNote error={mine.error} /> : <DataTable data={mine.data} columns={mineCols} getRowId={(s) => s.id} empty="You have not run any sessions yet." />}
        </>
      ) : overview.isError ? (
        <ErrorNote error={overview.error} title="Could not load overview" />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Policy decisions (all time)</CardTitle></CardHeader>
              <CardContent className="flex gap-6" data-testid="decision-counts">
                {(["allow", "require-approval", "deny"] as const).map((e) => (
                  <div key={e}>
                    <EffectBadge effect={e} />
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{o?.decisions[e] ?? 0}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Sessions by status</CardTitle></CardHeader>
              <CardContent className="flex gap-6">
                {(["running", "succeeded", "failed", "cancelled"] as const).map((s) => (
                  <div key={s}>
                    <StatusBadge status={s} />
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{o?.sessions[s] ?? 0}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <h2 className="mb-2 text-sm font-semibold">Running now</h2>
          <div className="mb-6" data-testid="active-sessions">
            {overview.isPending ? <LoadingRows rows={2} /> : <DataTable dense data={o?.active_sessions ?? []} columns={activeCols} getRowId={(s) => s.session_id} empty="No sessions are running." />}
          </div>

          <h2 className="mb-2 text-sm font-semibold">Recent denials</h2>
          {!canAudit ? null : denials.isPending ? <LoadingRows rows={2} /> : denials.isError ? <ErrorNote error={denials.error} /> : (
            <div data-testid="recent-denials"><DataTable dense data={denials.data.events} columns={denialCols} getRowId={(e) => String(e.id)} empty="Nothing has been denied yet." /></div>
          )}
        </>
      )}
    </>
  );
}
