import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EffectBadge } from "@/components/badges";
import { DataTable } from "@/components/DataTable";
import { Mono } from "@/components/JsonBlock";
import { ErrorNote } from "@/components/states";
import { api } from "@/lib/api";
import type { PolicyVersionRow, SimulationRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const DRAFT = "__draft__";

/** Where the policy under test comes from: the unsaved editor draft, or a stored immutable version. */
export function SourcePicker({ value, onChange, versions, hasDraft }: { value: string; onChange: (v: string) => void; versions: PolicyVersionRow[]; hasDraft: boolean }) {
  return (
    <div className="grid gap-1.5">
      <Label>Policy under test</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label="Policy under test" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {hasDraft && <SelectItem value={DRAFT}>Draft in the editor (unsaved)</SelectItem>}
          {versions.map((v) => (
            <SelectItem key={`${v.id}@${v.version}`} value={`${v.id}@${v.version}`}>{v.id} @ v{v.version} (stored)</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function defaultSource(hasDraft: boolean, versions: PolicyVersionRow[]): string {
  if (hasDraft) return DRAFT;
  const last = versions[versions.length - 1];
  return last ? `${last.id}@${last.version}` : DRAFT;
}

async function resolveDocument(source: string, draft: string): Promise<string> {
  if (source === DRAFT) return draft;
  const [id, v] = source.split("@");
  return (await api.policy(id!, Number(v))).document;
}

export function EvaluatePanel({ source, draft }: { source: string; draft: string }) {
  const [type, setType] = useState("payment.transfer");
  const [resource, setResource] = useState("vendor-1");
  const [params, setParams] = useState('{ "amount": 5000 }');
  const [tokens, setTokens] = useState("0");
  const [amount, setAmount] = useState("0");
  const [count, setCount] = useState("0");
  const [localError, setLocalError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      let parsed: unknown;
      try {
        parsed = params.trim() ? JSON.parse(params) : {};
      } catch (e) {
        throw new Error(`Params must be JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      return api.evaluate({
        documents: [await resolveDocument(source, draft)],
        action: { type, resource, params: parsed },
        spent_tokens: Number(tokens) || 0, spent_amount: Number(amount) || 0, action_count: Number(count) || 0,
      });
    },
    onMutate: () => setLocalError(null),
    onError: (e) => setLocalError(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What would this policy do to one action?</CardTitle>
        <CardDescription>Evaluated by the backend's real policy engine — the console never re-implements a decision.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1.5"><Label htmlFor="ev-type">Action type</Label><Input id="ev-type" value={type} onChange={(e) => setType(e.target.value)} className="font-mono" /></div>
          <div className="grid gap-1.5"><Label htmlFor="ev-res">Resource</Label><Input id="ev-res" value={resource} onChange={(e) => setResource(e.target.value)} className="font-mono" /></div>
        </div>
        <div className="grid gap-1.5"><Label htmlFor="ev-params">Params (JSON)</Label><Textarea id="ev-params" rows={3} value={params} onChange={(e) => setParams(e.target.value)} className="font-mono text-xs" /></div>
        <div className="grid grid-cols-3 gap-4">
          <div className="grid gap-1.5"><Label htmlFor="ev-tok">Session tokens spent</Label><Input id="ev-tok" inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="ev-amt">Session amount spent</Label><Input id="ev-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="ev-cnt">Actions so far</Label><Input id="ev-cnt" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} /></div>
        </div>
        <div><Button onClick={() => run.mutate()} disabled={run.isPending || !type || !resource} data-testid="evaluate-run">Evaluate</Button></div>
        {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
        {run.isError && !localError && <ErrorNote error={run.error} />}
        {run.data && (
          <div className="rounded-md border bg-muted/30 p-4 text-sm" data-testid="evaluate-result">
            <div className="mb-2 flex items-center gap-3"><EffectBadge effect={run.data.effect} className="text-sm" /><span>decided by rule <Mono className="font-semibold">{run.data.rule_id}</Mono></span></div>
            {run.data.reason && <p className="text-muted-foreground">{run.data.reason}</p>}
            <p className="mt-1 text-xs text-muted-foreground">Policy: <Mono>{run.data.policy_id || "—"}</Mono>{run.data.matched_rules.length > 0 && <> · matched rules: <Mono>{run.data.matched_rules.join(", ")}</Mono></>}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SimulatePanel({ source, draft }: { source: string; draft: string }) {
  const [agentId, setAgentId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [since, setSince] = useState("");
  const [limit, setLimit] = useState("1000");
  const [onlyChanged, setOnlyChanged] = useState(true);
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  const run = useMutation({
    mutationFn: async () => {
      const base = { agent_id: agentId || undefined, session_id: sessionId || undefined, since: since || undefined, limit: Number(limit) || 1000 };
      if (source === DRAFT) return api.simulate({ ...base, documents: [draft] });
      const [id, v] = source.split("@");
      return api.simulate({ ...base, policies: [{ id, version: Number(v) }] });
    },
  });

  const cols: ColumnDef<SimulationRow>[] = [
    { header: "Recorded action", id: "action", cell: ({ row }) => <Mono>{row.original.type} <span className="text-muted-foreground">{row.original.resource}</span></Mono> },
    { header: "Then (actual)", id: "orig", cell: ({ row }) => <span className="flex items-center gap-2"><EffectBadge effect={row.original.original.effect} /><Mono className="text-muted-foreground">{row.original.original.rule_id}</Mono></span> },
    { header: "", id: "arrow", enableSorting: false, cell: ({ row }) => <ArrowRight className={cn("size-4", row.original.changed ? "text-amber-600" : "text-muted-foreground/40")} /> },
    { header: "Would be", id: "sim", cell: ({ row }) => <span className="flex items-center gap-2"><EffectBadge effect={row.original.simulated.effect} /><Mono className="text-muted-foreground">{row.original.simulated.rule_id}</Mono></span> },
    { header: "Changed", accessorKey: "changed", cell: ({ row }) => (row.original.changed ? <span className="font-semibold text-amber-700">changed</span> : <span className="text-muted-foreground">same</span>) },
    { header: "Audit ref", accessorKey: "ref", cell: ({ row }) => <Mono className="text-muted-foreground">#{row.original.ref}</Mono> },
  ];

  const data = run.data;
  const rows = data ? (onlyChanged ? data.results.filter((r) => r.changed) : data.results) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What would this policy have done to our real traffic?</CardTitle>
        <CardDescription>Replays recorded audit decisions against the policy under test. No agent is re-run and nothing is changed.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-4 gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="sim-agent">Agent (optional)</Label>
            <Input id="sim-agent" list="sim-agents" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="all agents" className="font-mono" />
            <datalist id="sim-agents">{agents.data?.map((a) => <option key={a.id} value={a.id} />)}</datalist>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="sim-session">Session (optional)</Label><Input id="sim-session" value={sessionId} onChange={(e) => setSessionId(e.target.value)} className="font-mono" /></div>
          <div className="grid gap-1.5"><Label htmlFor="sim-since">Since (ISO time, optional)</Label><Input id="sim-since" value={since} onChange={(e) => setSince(e.target.value)} placeholder="2026-09-01T00:00:00Z" className="font-mono" /></div>
          <div className="grid gap-1.5"><Label htmlFor="sim-limit">Max actions</Label><Input id="sim-limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} /></div>
        </div>
        <div><Button onClick={() => run.mutate()} disabled={run.isPending} data-testid="simulate-run">{run.isPending ? "Replaying…" : "Replay against history"}</Button></div>
        {run.isError && <ErrorNote error={run.error} title="Simulation failed" />}
        {data && (
          <div className="space-y-4" data-testid="simulate-result">
            <div className="grid grid-cols-5 gap-3">
              <Tile label="Actions replayed" value={data.total} testId="sim-total" />
              <Tile label="Decisions that change" value={data.changed} emphasise={data.changed > 0} testId="sim-changed" />
              <Tile label="Would allow" value={data.would.allow} />
              <Tile label="Would require approval" value={data.would["require-approval"]} />
              <Tile label="Would deny" value={data.would.deny} />
            </div>
            {data.skipped > 0 && <p className="text-xs text-muted-foreground">{data.skipped} recorded refusal(s) never became an action (unknown tool / invalid arguments) and were skipped.</p>}
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={onlyChanged} onCheckedChange={(c) => setOnlyChanged(c === true)} aria-label="Only show changed decisions" /> Only show decisions that would change</label>
            <DataTable dense data={rows} columns={cols} getRowId={(r) => r.ref} empty={data.total === 0 ? "No recorded actions match these filters." : "No decision would change under this policy."} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({ label, value, emphasise, testId }: { label: string; value: number; emphasise?: boolean; testId?: string }) {
  return (
    <div className={cn("rounded-md border p-3", emphasise && "border-amber-300 bg-amber-50")}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums" data-testid={testId}>{value}</div>
    </div>
  );
}
