import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EffectBadge } from "@/components/badges";
import { DataTable } from "@/components/DataTable";
import { Mono } from "@/components/JsonBlock";
import { ErrorNote, LoadingRows, PageHeader, Restricted } from "@/components/states";
import { api, type AuditFilters } from "@/lib/api";
import { formatTs, shortId } from "@/lib/format";
import type { AuditEvent } from "@/lib/types";
import { AuditEventSheet } from "./AuditEventSheet";
import { ChainVerifier } from "./ChainVerifier";

const ANY = "any";
const PAGE = 50;
const KINDS = ["action.decided", "action.executed", "action.failed", "approval.requested", "approval.resolved", "agent.progress",
  "session.created", "session.started", "session.finished", "agent.registered", "policy.created", "policy.attached", "policy.detached"];
const FIELDS: (keyof AuditFilters)[] = ["session_id", "agent_id", "kind", "effect", "rule_id", "action_type", "since", "until"];

const columns: ColumnDef<AuditEvent>[] = [
  { header: "Time", accessorKey: "ts", cell: ({ row }) => <Mono>{formatTs(row.original.ts)}</Mono> },
  { header: "Agent", accessorKey: "agent_id" },
  { header: "Event", accessorKey: "kind", cell: ({ row }) => <Mono>{row.original.kind}</Mono> },
  { header: "Action", id: "action", cell: ({ row }) => (row.original.action_type ? <Mono>{row.original.action_type} <span className="text-muted-foreground">{row.original.resource}</span></Mono> : <span className="text-muted-foreground">—</span>) },
  { header: "Decision", accessorKey: "effect", cell: ({ row }) => <EffectBadge effect={row.original.effect} /> },
  { header: "Rule", accessorKey: "rule_id", cell: ({ row }) => (row.original.rule_id ? <Mono>{row.original.rule_id}</Mono> : "—") },
  { header: "Policy", id: "policy", enableSorting: false, cell: ({ row }) => (row.original.policy_id ? <Mono>{row.original.policy_id}@v{row.original.policy_version}</Mono> : <span className="text-muted-foreground">—</span>) },
  { header: "Session", accessorKey: "session_id", cell: ({ row }) => (row.original.session_id.startsWith("ses_") ? <Link className="text-sky-700 hover:underline" to={`/sessions/${row.original.session_id}`} onClick={(e) => e.stopPropagation()}><Mono>{shortId(row.original.session_id)}</Mono></Link> : <Mono className="text-muted-foreground">{shortId(row.original.session_id)}</Mono>) },
];

export function AuditPage() {
  return (
    <>
      <PageHeader title="Audit & Decision Log" description="Every action every agent attempted, the decision, the exact rule and policy version that made it, and proof the record has not been altered." />
      <Restricted cap="audit.read" what="The audit log"><Log /></Restricted>
    </>
  );
}

function Log() {
  const [params, setParams] = useSearchParams();
  const applied: AuditFilters = Object.fromEntries(FIELDS.flatMap((f) => (params.get(f) ? [[f, params.get(f)!]] : [])));
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f, params.get(f) ?? ""])));
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const q = useInfiniteQuery({
    queryKey: ["audit", applied],
    queryFn: ({ pageParam }) => api.audit(applied, { order: "desc", limit: PAGE, before_id: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.events.length === PAGE ? (last.next_before_id ?? undefined) : undefined),
    refetchInterval: false,
  });
  const rows = q.data?.pages.flatMap((p) => p.events) ?? [];

  function apply(e?: FormEvent) {
    e?.preventDefault();
    const next = new URLSearchParams();
    for (const f of FIELDS) if (form[f]) next.set(f, form[f]!);
    setParams(next);
  }
  function reset() {
    setForm(Object.fromEntries(FIELDS.map((f) => [f, ""])));
    setParams(new URLSearchParams());
  }
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v === ANY ? "" : v }));
  const text = (k: keyof AuditFilters, label: string, ph = "") => (
    <div className="grid gap-1"><Label htmlFor={`f-${k}`} className="text-xs">{label}</Label><Input id={`f-${k}`} value={form[k] ?? ""} placeholder={ph} className="h-8 font-mono text-xs" onChange={(e) => set(k)(e.target.value)} /></div>
  );

  return (
    <>
      <form onSubmit={apply} className="mb-4 rounded-md border bg-card p-3" data-testid="audit-filters">
        <div className="grid grid-cols-4 gap-3">
          {text("agent_id", "Agent")}
          {text("session_id", "Session")}
          {text("rule_id", "Rule id")}
          {text("action_type", "Action type", "payment.transfer")}
          <div className="grid gap-1">
            <Label className="text-xs">Decision</Label>
            <Select value={form.effect || ANY} onValueChange={set("effect")}>
              <SelectTrigger aria-label="Decision" className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{[ANY, "allow", "deny", "require-approval"].map((v) => <SelectItem key={v} value={v}>{v === ANY ? "any decision" : v}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Event kind</Label>
            <Select value={form.kind || ANY} onValueChange={set("kind")}>
              <SelectTrigger aria-label="Event kind" className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{[ANY, ...KINDS].map((v) => <SelectItem key={v} value={v}>{v === ANY ? "any event" : v}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {text("since", "Since (ISO)", "2026-09-01T00:00:00Z")}
          {text("until", "Until (ISO)", "")}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button type="submit" size="sm" data-testid="apply-filters">Apply filters</Button>
          <Button type="button" size="sm" variant="ghost" onClick={reset}>Reset</Button>
          <span className="ml-auto text-xs text-muted-foreground">{q.isSuccess ? `${rows.length} event${rows.length === 1 ? "" : "s"} loaded · newest first` : ""}</span>
        </div>
      </form>

      {applied.session_id?.startsWith("ses_") && <div className="mb-4"><ChainVerifier sessionId={applied.session_id} /></div>}

      {q.isPending ? <LoadingRows rows={6} /> : q.isError ? <ErrorNote error={q.error} title="Could not load audit events" /> : (
        <>
          <DataTable dense data={rows} columns={columns} getRowId={(e) => String(e.id)} onRowClick={setSelected} selectedId={selected ? String(selected.id) : null} empty="No audit events match these filters." />
          <div className="mt-3 flex justify-center">
            {q.hasNextPage ? (
              <Button variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage} data-testid="load-older">{q.isFetchingNextPage ? "Loading…" : "Load older events"}</Button>
            ) : rows.length > 0 ? <span className="text-xs text-muted-foreground">Reached the beginning of the matching history.</span> : null}
          </div>
        </>
      )}
      <AuditEventSheet event={selected} onClose={() => setSelected(null)} />
    </>
  );
}
