import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import YAML from "yaml";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { GatedButton } from "@/components/GatedButton";
import { api } from "@/lib/api";
import type { Shape } from "@/lib/types";

interface FileRow {
  name: string;
  content: string;
}

const DEFAULT_SPEC = `steps:
  - id: logs
    call: data.read
    args: { dataset: prod.logs }
  - return: { logs: "\${logs.records}" }
`;

const DEFAULT_FILE: FileRow = { name: "main.py", content: 'def run(ctx):\n    return {"task": ctx.task}\n' };

export function RegisterAgentDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [shape, setShape] = useState<Shape>("package");
  const [description, setDescription] = useState("");
  const [entrypoint, setEntrypoint] = useState("main:run");
  const [files, setFiles] = useState<FileRow[]>([{ ...DEFAULT_FILE }]);
  const [spec, setSpec] = useState(DEFAULT_SPEC);
  const [memory, setMemory] = useState("");
  const [cpus, setCpus] = useState("");
  const [timeout, setTimeoutS] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const register = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.registerAgent(body),
    onSuccess: (res) => {
      toast.success(`Registered ${res.id} v${res.version}`, { description: "It runs deny-all until an admin attaches a policy." });
      void qc.invalidateQueries({ queryKey: ["agents"] });
      setOpen(false);
      setId("");
    },
  });

  function submit() {
    setLocalError(null);
    const resources: Record<string, number> = {};
    if (memory) resources.memory_mb = Number(memory);
    if (cpus) resources.cpus = Number(cpus);
    if (timeout) resources.timeout_s = Number(timeout);
    const body: Record<string, unknown> = { id, shape, description, ...(Object.keys(resources).length ? { resources } : {}) };
    if (shape === "package") {
      body.package = { entrypoint, files: Object.fromEntries(files.filter((f) => f.name).map((f) => [f.name, f.content])) };
    } else {
      try {
        // Transport only: the operator writes YAML or JSON, the API takes JSON. All validation is the server's.
        const parsed = YAML.parse(spec);
        if (parsed === null || typeof parsed !== "object") throw new Error("spec must be a mapping with a 'steps' list");
        body.spec = parsed;
      } catch (e) {
        setLocalError(`Spec is not parseable YAML/JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    register.mutate(body);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) register.reset(); }}>
      <DialogTrigger asChild>
        <GatedButton cap="agent.register" data-testid="register-agent">
          <Plus className="size-4" /> Register agent
        </GatedButton>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Register an agent</DialogTitle>
          <DialogDescription>
            Registering an agent grants it no capability. It runs deny-all until an administrator attaches a policy. Re-registering an id
            creates a new immutable version.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-id">Agent id</Label>
              <Input id="agent-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="it-ops-agent" />
              <p className="text-xs text-muted-foreground">lower-case letters, digits, dashes (2–63)</p>
            </div>
            <div className="grid gap-1.5">
              <Label>Shape</Label>
              <Select value={shape} onValueChange={(v) => setShape(v as Shape)}>
                <SelectTrigger aria-label="Shape"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="package">package — code (Python, stdlib only)</SelectItem>
                  <SelectItem value="declarative">declarative — config, no code</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-desc">Description</Label>
            <Input id="agent-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          {shape === "package" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="entrypoint">Entrypoint (module:function)</Label>
                <Input id="entrypoint" value={entrypoint} onChange={(e) => setEntrypoint(e.target.value)} className="font-mono" />
              </div>
              <div className="grid gap-3">
                <div className="flex items-center justify-between">
                  <Label>Files</Label>
                  <Button type="button" variant="outline" size="sm" onClick={() => setFiles([...files, { name: "", content: "" }])}>
                    <Plus className="size-3.5" /> Add file
                  </Button>
                </div>
                {files.map((f, i) => (
                  <div key={i} className="grid gap-1.5 rounded-md border p-3">
                    <div className="flex gap-2">
                      <Input aria-label={`File ${i + 1} name`} value={f.name} placeholder="main.py" className="font-mono" onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                      {files.length > 1 && (
                        <Button type="button" variant="ghost" size="icon" aria-label={`Remove file ${i + 1}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                    <Textarea aria-label={`File ${i + 1} content`} rows={8} value={f.content} className="font-mono text-xs" onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="spec">Spec (YAML or JSON)</Label>
              <Textarea id="spec" rows={12} value={spec} onChange={(e) => setSpec(e.target.value)} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">
                1–100 steps; each has exactly one of <code>call</code>, <code>llm</code>, <code>return</code>. See docs/BYOA_CONTRACT.md.
              </p>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="res-mem">Memory MB (optional)</Label>
              <Input id="res-mem" inputMode="numeric" value={memory} onChange={(e) => setMemory(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="res-cpu">CPUs (optional)</Label>
              <Input id="res-cpu" inputMode="decimal" value={cpus} onChange={(e) => setCpus(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="res-time">Timeout s (optional)</Label>
              <Input id="res-time" inputMode="numeric" value={timeout} onChange={(e) => setTimeoutS(e.target.value)} />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">Agents may only request less than the platform ceiling, never more.</p>

          {(localError || register.isError) && (
            <p role="alert" className="text-sm text-destructive">
              {localError ?? (register.error instanceof Error ? register.error.message : "Registration failed")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!id || register.isPending} data-testid="register-submit">
            {register.isPending ? "Registering…" : "Register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
