import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/DataTable";
import { Mono } from "@/components/JsonBlock";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/states";
import { api } from "@/lib/api";
import { formatTs } from "@/lib/format";
import type { AgentSummary } from "@/lib/types";
import { AgentDetailSheet } from "./AgentDetailSheet";
import { RegisterAgentDialog } from "./RegisterAgentDialog";

const columns: ColumnDef<AgentSummary>[] = [
  { header: "Agent", accessorKey: "id", cell: ({ row }) => <Mono className="font-semibold">{row.original.id}</Mono> },
  { header: "Shape", accessorKey: "shape", cell: ({ row }) => <Badge variant="outline">{row.original.shape}</Badge> },
  { header: "Version", accessorKey: "version", cell: ({ row }) => `v${row.original.version}` },
  { header: "Owner", accessorKey: "owner" },
  {
    header: "Policies",
    id: "policies",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.policies.length === 0 ? (
        <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">deny-all · none attached</Badge>
      ) : (
        <span className="flex flex-wrap gap-1">
          {row.original.policies.map((p) => (
            <Badge key={p.policy_id} variant="secondary" className="font-mono">
              {p.policy_id}{p.policy_version ? `@v${p.policy_version}` : ""}
            </Badge>
          ))}
        </span>
      ),
  },
  { header: "Registered", accessorKey: "created_at", cell: ({ row }) => <Mono>{formatTs(row.original.created_at)}</Mono> },
];

export function AgentsPage() {
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchInterval: 10_000 });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Agents"
        description="Every registered third-party or in-house agent, its shape, and the admin-owned policies that govern it. Click an agent to see its manifest and manage its policies."
        actions={<RegisterAgentDialog />}
      />
      {agents.isPending ? <LoadingRows /> : agents.isError ? <ErrorNote error={agents.error} title="Could not load agents" /> : (
        <DataTable
          data={agents.data}
          columns={columns}
          getRowId={(a) => a.id}
          onRowClick={(a) => setSelected(a.id)}
          selectedId={selected}
          empty="No agents registered yet. Use “Register agent” to add one."
        />
      )}
      <AgentDetailSheet agentId={selected} onClose={() => setSelected(null)} />
    </>
  );
}
