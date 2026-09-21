import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/badges";
import { DataTable } from "@/components/DataTable";
import { Mono } from "@/components/JsonBlock";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/states";
import { api } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { formatTs, shortId, timeAgo } from "@/lib/format";
import { can } from "@/lib/roles";
import type { Session } from "@/lib/types";
import { SubmitSessionDialog } from "./SubmitSessionDialog";

const ALL = "all";

export function SessionsPage() {
  const me = useMe();
  const navigate = useNavigate();
  const [status, setStatus] = useState(ALL);
  const [agent, setAgent] = useState("");
  const sessions = useQuery({
    queryKey: ["sessions", { status, agent }],
    queryFn: () => api.sessions({ status: status === ALL ? undefined : status, agent_id: agent || undefined, limit: 100 }),
    refetchInterval: 3000,
  });
  // Which running sessions are frozen is only exposed by the operator overview (auditor/approver/admin).
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, enabled: can(me.roles, "overview.read"), refetchInterval: 3000 });
  const frozen = new Set(overview.data?.active_sessions.filter((a) => a.paused).map((a) => a.session_id));

  const columns: ColumnDef<Session>[] = [
    { header: "Session", accessorKey: "id", cell: ({ row }) => <Link className="text-sky-700 hover:underline" to={`/sessions/${row.original.id}`} onClick={(e) => e.stopPropagation()}><Mono>{shortId(row.original.id)}</Mono></Link> },
    { header: "Agent", accessorKey: "agent_id", cell: ({ row }) => <span>{row.original.agent_id} <span className="text-muted-foreground">v{row.original.agent_version}</span></span> },
    { header: "Status", accessorKey: "status", cell: ({ row }) => <StatusBadge status={row.original.status} frozen={frozen.has(row.original.id)} /> },
    { header: "Submitted by", accessorKey: "submitted_by" },
    { header: "Actions", accessorKey: "action_count" },
    { header: "Tokens", accessorKey: "spent_tokens" },
    { header: "Spend", accessorKey: "spent_amount", cell: ({ row }) => row.original.spent_amount.toFixed(2) },
    { header: "Started", accessorKey: "created_at", cell: ({ row }) => <span title={formatTs(row.original.created_at)}>{timeAgo(row.original.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Live Sessions"
        description="Every task submitted to an agent. Open one to watch its actions, policy decisions and approvals arrive live."
        actions={<SubmitSessionDialog />}
      />
      <div className="mb-3 flex items-center gap-3">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Status filter" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {["queued", "running", "succeeded", "failed", "cancelled"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input aria-label="Agent filter" className="w-56 font-mono" placeholder="filter by agent id" value={agent} onChange={(e) => setAgent(e.target.value)} />
      </div>
      {sessions.isPending ? <LoadingRows /> : sessions.isError ? <ErrorNote error={sessions.error} title="Could not load sessions" /> : (
        <DataTable data={sessions.data} columns={columns} getRowId={(s) => s.id} onRowClick={(s) => navigate(`/sessions/${s.id}`)} empty="No sessions yet. Submit a task to an agent to see it here." />
      )}
    </>
  );
}
