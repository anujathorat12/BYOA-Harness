import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/DataTable";
import { JsonBlock, Mono } from "@/components/JsonBlock";
import { ErrorNote, LoadingRows, PageHeader, Restricted } from "@/components/states";
import { api } from "@/lib/api";
import { formatTs } from "@/lib/format";
import type { PolicyVersionRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EvaluatePanel, SimulatePanel, SourcePicker, defaultSource } from "./DryRun";
import { POLICY_TEMPLATE, PolicyEditor } from "./PolicyEditor";
import { useLiveValidation } from "./useLiveValidation";

export function PolicyStudioPage() {
  return (
    <>
      <PageHeader
        title="Policy Studio"
        description="Author immutable policy versions, see exactly which version governs what, and dry-run any change against real recorded traffic before it goes live."
      />
      <Restricted cap="policy.read" what="Policy Studio">
        <Studio />
      </Restricted>
    </>
  );
}

function Studio() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("policy");
  const selectedVersion = params.get("version") ? Number(params.get("version")) : undefined;
  const [tab, setTab] = useState("policy");
  const [draft, setDraft] = useState("");
  const [source, setSource] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["policies"], queryFn: api.policies });
  const grouped = useMemo(() => {
    const m = new Map<string, PolicyVersionRow[]>();
    for (const r of list.data ?? []) m.set(r.id, [...(m.get(r.id) ?? []), r].sort((a, b) => a.version - b.version));
    return m;
  }, [list.data]);

  const versions = selectedId ? (grouped.get(selectedId) ?? []) : [];
  const latest = versions[versions.length - 1]?.version;
  const shownVersion = selectedVersion ?? latest;
  const doc = useQuery({
    queryKey: ["policy", selectedId, shownVersion],
    queryFn: () => api.policy(selectedId!, shownVersion),
    enabled: !!selectedId && shownVersion !== undefined,
  });

  const validation = useLiveValidation(tab === "editor" || tab === "dryrun" ? draft : "");
  const allVersions = useMemo(() => [...grouped.values()].flat(), [grouped]);
  const effectiveSource = source ?? defaultSource(draft.trim() !== "", versions.length ? versions : allVersions);

  const select = (id: string, version?: number) => setParams(version ? { policy: id, version: String(version) } : { policy: id });
  const startDraft = (text: string) => { setDraft(text); setTab("editor"); };

  const versionCols: ColumnDef<PolicyVersionRow>[] = [
    { header: "Version", accessorKey: "version", cell: ({ row }) => <span className="flex items-center gap-2">v{row.original.version}{row.original.version === latest && <Badge variant="secondary">latest</Badge>}</span> },
    { header: "Content hash", accessorKey: "content_hash", cell: ({ row }) => <Mono>{row.original.content_hash.slice(0, 12)}</Mono> },
    { header: "Created by", accessorKey: "created_by" },
    { header: "Created", accessorKey: "created_at", cell: ({ row }) => <Mono>{formatTs(row.original.created_at)}</Mono> },
  ];

  return (
    <div className="grid grid-cols-[260px_1fr] gap-6">
      <aside>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Policies</h2>
          <Button size="sm" variant="outline" onClick={() => startDraft(POLICY_TEMPLATE)} data-testid="new-policy"><Plus className="size-3.5" /> New</Button>
        </div>
        {list.isPending ? <LoadingRows /> : list.isError ? <ErrorNote error={list.error} /> : grouped.size === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No policies yet. Agents run deny-all until one is created and attached.</p>
        ) : (
          <ul className="space-y-1">
            {[...grouped.entries()].map(([id, vs]) => (
              <li key={id}>
                <button
                  onClick={() => { select(id); setTab("policy"); }}
                  className={cn("flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-accent", selectedId === id && "border-primary bg-accent")}
                  data-testid={`policy-${id}`}
                >
                  <Mono className="font-semibold">{id}</Mono>
                  <span className="text-xs text-muted-foreground">v{vs[vs.length - 1]?.version}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="min-w-0">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="policy">Policy</TabsTrigger>
            <TabsTrigger value="editor">Editor</TabsTrigger>
            <TabsTrigger value="dryrun">Dry-run</TabsTrigger>
          </TabsList>

          <TabsContent value="policy" className="space-y-4 pt-4">
            {!selectedId ? (
              <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">Select a policy, or create a new one.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="font-mono text-lg font-semibold">{selectedId} <span className="text-sm font-normal text-muted-foreground">v{shownVersion}</span></h2>
                  {doc.data && <Button variant="outline" size="sm" onClick={() => startDraft(doc.data.document)} data-testid="edit-as-new">Edit as new version</Button>}
                </div>
                {doc.isPending ? <LoadingRows rows={3} /> : doc.isError ? <ErrorNote error={doc.error} /> : <JsonBlock value={doc.data.document} className="max-h-[420px]" />}
                <h3 className="text-sm font-semibold">Version history</h3>
                <DataTable dense data={versions.slice().reverse()} columns={versionCols} getRowId={(r) => `${r.id}@${r.version}`} selectedId={`${selectedId}@${shownVersion}`} onRowClick={(r) => select(r.id, r.version)} />
              </>
            )}
          </TabsContent>

          <TabsContent value="editor" className="pt-4">
            <PolicyEditor
              draft={draft}
              onChange={setDraft}
              validation={validation}
              onSaved={(id, version) => { select(id, version); setTab("policy"); }}
            />
          </TabsContent>

          <TabsContent value="dryrun" className="space-y-6 pt-4">
            <SourcePicker value={effectiveSource} onChange={setSource} versions={selectedId ? versions : allVersions} hasDraft={draft.trim() !== ""} />
            <EvaluatePanel source={effectiveSource} draft={draft} />
            <SimulatePanel source={effectiveSource} draft={draft} />
          </TabsContent>
        </Tabs>
      </section>
    </div>
  );
}
