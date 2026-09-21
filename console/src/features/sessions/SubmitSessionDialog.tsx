import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { GatedButton } from "@/components/GatedButton";
import { api } from "@/lib/api";

/** "id" or "id@3" (comma separated) -> API refs. Session policies can only narrow what the agent's own policy grants. */
function parseRefs(text: string): { id: string; version?: number }[] {
  return text.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
    const [id, v] = t.split("@");
    return v ? { id: id!, version: Number(v) } : { id: id! };
  });
}

export function SubmitSessionDialog({ defaultAgent }: { defaultAgent?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState(defaultAgent ?? "");
  const [task, setTask] = useState("{}");
  const [refs, setRefs] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents, enabled: open });

  const submit = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try {
        parsed = task.trim() ? JSON.parse(task) : {};
      } catch (e) {
        throw new Error(`Task must be a JSON object: ${e instanceof Error ? e.message : String(e)}`);
      }
      return api.submit(agentId, { task: parsed, policies: parseRefs(refs) });
    },
    onMutate: () => setLocalError(null),
    onSuccess: (s) => {
      toast.success(`Session ${s.id} accepted`);
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      setOpen(false);
      navigate(`/sessions/${s.id}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) submit.reset(); }}>
      <DialogTrigger asChild>
        <GatedButton cap="session.submit" data-testid="submit-session"><Play className="size-4" /> Submit session</GatedButton>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit a task to an agent</DialogTitle>
          <DialogDescription>Returns immediately; you will be taken to the live view. The agent runs sandboxed under its admin-attached policies.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger aria-label="Agent" className="w-full"><SelectValue placeholder="Choose an agent" /></SelectTrigger>
              <SelectContent>{agents.data?.map((a) => <SelectItem key={a.id} value={a.id}>{a.id} · v{a.version} · {a.shape}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-json">Task (JSON object)</Label>
            <Textarea id="task-json" rows={5} value={task} onChange={(e) => setTask(e.target.value)} className="font-mono text-xs" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="session-policies">Extra session policies (optional)</Label>
            <Input id="session-policies" value={refs} onChange={(e) => setRefs(e.target.value)} placeholder="policy-id, other-policy@2" className="font-mono" />
            <p className="text-xs text-muted-foreground">These can only narrow what the agent's own policy allows; they can never grant more.</p>
          </div>
          {submit.isError && <p role="alert" className="text-sm text-destructive">{submit.error.message}</p>}
          {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={!agentId || submit.isPending} data-testid="submit-session-confirm">{submit.isPending ? "Submitting…" : "Submit"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
