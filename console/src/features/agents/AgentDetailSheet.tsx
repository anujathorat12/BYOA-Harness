import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link2Off } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { GatedButton } from "@/components/GatedButton";
import { JsonBlock, Mono } from "@/components/JsonBlock";
import { ErrorNote, LoadingRows } from "@/components/states";
import { api } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { formatTs } from "@/lib/format";
import { can } from "@/lib/roles";

const LATEST = "latest";

export function AgentDetailSheet({ agentId, onClose }: { agentId: string | null; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const canReadPolicies = can(me.roles, "policy.read");
  const agent = useQuery({ queryKey: ["agent", agentId], queryFn: () => api.agent(agentId!), enabled: !!agentId });
  const policies = useQuery({ queryKey: ["policies"], queryFn: api.policies, enabled: !!agentId && canReadPolicies });
  const [policyId, setPolicyId] = useState<string>("");
  const [version, setVersion] = useState<string>(LATEST);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["agent", agentId] });
    void qc.invalidateQueries({ queryKey: ["agents"] });
  };
  const attach = useMutation({
    mutationFn: () => api.attachPolicy(agentId!, policyId, version === LATEST ? null : Number(version)),
    onSuccess: () => { toast.success(`Attached ${policyId} to ${agentId}`); setPolicyId(""); setVersion(LATEST); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const detach = useMutation({
    mutationFn: (pid: string) => api.detachPolicy(agentId!, pid),
    onSuccess: (_r, pid) => { toast.success(`Detached ${pid}`); refresh(); },
    onError: (e) => toast.error(e.message),
  });

  const byId = new Map<string, number[]>();
  for (const p of policies.data ?? []) byId.set(p.id, [...(byId.get(p.id) ?? []), p.version]);
  const attachedIds = new Set(agent.data?.policies.map((p) => p.policy_id));
  const attachable = [...byId.keys()].filter((id) => !attachedIds.has(id));

  return (
    <Sheet open={!!agentId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[560px] overflow-y-auto sm:max-w-[560px]">
        <SheetHeader>
          <SheetTitle className="font-mono">{agentId}</SheetTitle>
          <SheetDescription>Registered agent version, manifest and governing policies.</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          {agent.isPending ? <LoadingRows /> : agent.isError ? <ErrorNote error={agent.error} /> : (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <span className="text-muted-foreground">Shape</span><span>{agent.data.shape}</span>
                <span className="text-muted-foreground">Version</span><span>v{agent.data.version}</span>
                <span className="text-muted-foreground">Owner</span><span>{agent.data.owner}</span>
                <span className="text-muted-foreground">Registered</span><span>{formatTs(agent.data.created_at)}</span>
              </div>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Governing policies</h3>
                {agent.data.policies.length === 0 ? (
                  <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="deny-all-note">
                    No policy attached — this agent runs <b>deny-all</b>: every action it attempts is refused and audited.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {agent.data.policies.map((p) => (
                      <li key={p.policy_id} className="flex items-center justify-between rounded-md border p-2 text-sm" data-testid={`attached-${p.policy_id}`}>
                        <div>
                          <Mono>{p.policy_id}</Mono>{" "}
                          <Badge variant="secondary">{p.policy_version ? `v${p.policy_version} pinned` : "follows latest"}</Badge>
                          <div className="text-xs text-muted-foreground">attached by {p.attached_by} · {formatTs(p.attached_at)}</div>
                        </div>
                        <GatedButton cap="policy.write" variant="outline" size="sm" onClick={() => detach.mutate(p.policy_id)} disabled={detach.isPending} aria-label={`Detach ${p.policy_id}`}>
                          <Link2Off className="size-4" /> Detach
                        </GatedButton>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Attach a policy</h3>
                {!canReadPolicies ? (
                  <GatedButton cap="policy.write">Attach policy</GatedButton>
                ) : policies.isPending ? <LoadingRows rows={1} /> : policies.isError ? <ErrorNote error={policies.error} /> : attachable.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No further policies to attach. Create one in Policy Studio.</p>
                ) : (
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Select value={policyId} onValueChange={(v) => { setPolicyId(v); setVersion(LATEST); }}>
                        <SelectTrigger aria-label="Policy to attach"><SelectValue placeholder="Choose policy" /></SelectTrigger>
                        <SelectContent>{attachable.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="w-40">
                      <Select value={version} onValueChange={setVersion} disabled={!policyId}>
                        <SelectTrigger aria-label="Policy version"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={LATEST}>follow latest</SelectItem>
                          {(byId.get(policyId) ?? []).map((v) => <SelectItem key={v} value={String(v)}>pin v{v}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <GatedButton cap="policy.write" onClick={() => attach.mutate()} disabled={!policyId || attach.isPending}>Attach</GatedButton>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Only administrators attach or detach policies, so an agent's owner cannot grant itself power. Sessions pin the version at start.</p>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Manifest</h3>
                <JsonBlock value={agent.data.manifest} className="max-h-96" />
              </section>
            </>
          )}
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
