import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CircleAlert, Globe, Loader2, MemoryStick, OctagonX, ShieldAlert, ShieldCheck, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JsonBlock, Mono } from "@/components/JsonBlock";
import { PageHeader, Restricted } from "@/components/states";
import { ApiError, api } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { can } from "@/lib/roles";
import { isFinished, type AgentDetail, type Session } from "@/lib/types";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/utils";
import { ATTACKS, type Attack, type Verdict } from "./attacks";

type Phase = "idle" | "preparing" | "running" | "done" | "error";
interface RunState {
  phase: Phase;
  session?: Session;
  verdict?: Verdict;
  error?: string;
  startedAt?: number;
}

const ICONS: Record<string, typeof Globe> = { internet: Globe, memory: MemoryStick, hang: Timer, forge: ShieldAlert };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Same code and limits already registered? Then reuse it instead of creating a new agent version on every click. */
function sameAgent(existing: AgentDetail, a: Attack): boolean {
  const pkg = existing.manifest.package as { files?: Record<string, string> } | undefined;
  const res = (existing.manifest.resources ?? {}) as Record<string, unknown>;
  return (
    pkg?.files?.["main.py"] === a.code &&
    (res.memory_mb ?? null) === (a.resources.memory_mb ?? null) &&
    (res.timeout_s ?? null) === a.resources.timeout_s
  );
}

async function ensureAgent(a: Attack): Promise<void> {
  let existing: AgentDetail | null = null;
  try {
    existing = await api.agent(a.agentId);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
  if (existing && sameAgent(existing, a)) return;
  try {
    await api.registerAgent({
      id: a.agentId,
      shape: "package",
      description: `Attack Lab: ${a.title}`,
      package: { entrypoint: "main:run", files: { "main.py": a.code } },
      resources: a.resources,
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      throw new Error(`The test agent "${a.agentId}" belongs to another user, so it cannot be created or updated from this account. Sign in as the user who first opened the Attack Lab.`);
    }
    throw e;
  }
}

export function AttackLabPage() {
  return (
    <>
      <PageHeader
        title="Attack Lab"
        description="Don't take our word for it: attack the sandbox yourself. Each button launches a real hostile program inside a real sandbox and shows what the platform did about it."
      />
      <Restricted cap="agent.register" what="The Attack Lab">
        <Lab />
      </Restricted>
    </>
  );
}

function Lab() {
  const me = useMe();
  const now = useNow(500);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [allRunning, setAllRunning] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const patch = useCallback((id: string, p: Partial<RunState>) => {
    if (alive.current) setRuns((r) => ({ ...r, [id]: { phase: "idle", ...r[id], ...p } }));
  }, []);

  const run = useCallback(
    async (attack: Attack) => {
      setBusy(attack.id);
      patch(attack.id, { phase: "preparing", session: undefined, verdict: undefined, error: undefined, startedAt: Date.now() });
      try {
        await ensureAgent(attack);
        let s = await api.submit(attack.agentId, { task: {}, policies: [] });
        patch(attack.id, { phase: "running", session: s, startedAt: Date.now() });
        const deadline = Date.now() + (attack.resources.timeout_s + 45) * 1000;
        while (!isFinished(s.status)) {
          if (!alive.current) return;
          if (Date.now() > deadline) throw new Error("Still running well past its time limit. Open Live Sessions to check on it.");
          await sleep(500);
          s = await api.session(s.id);
          patch(attack.id, { session: s });
        }
        patch(attack.id, { phase: "done", session: s, verdict: attack.judge(s) });
      } catch (e) {
        patch(attack.id, { phase: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [patch],
  );

  const runAll = async () => {
    setAllRunning(true);
    try {
      for (const a of ATTACKS) {
        if (!alive.current) break;
        await run(a);
      }
    } finally {
      if (alive.current) setAllRunning(false);
    }
  };

  const stop = (id: string) => {
    const sid = runs[id]?.session?.id;
    if (sid) void api.cancel(sid).catch(() => undefined);
  };

  const disabled = busy !== null || allRunning;
  const finished = ATTACKS.filter((a) => runs[a.id]?.phase === "done");
  const blockedCount = finished.filter((a) => runs[a.id]?.verdict?.outcome === "blocked").length;

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="flex items-center justify-between gap-6 pt-6">
          <p className="max-w-3xl text-sm text-muted-foreground">
            These are real hostile programs running in real Docker sandboxes; nothing on this page is simulated, and each result is read
            from the actual session. They cannot harm your computer, and that is exactly what is being demonstrated. Run them one at a
            time on a busy machine.
          </p>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <Button onClick={() => void runAll()} disabled={disabled} data-testid="run-all">
              {allRunning ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} Run all four, one at a time
            </Button>
            <span className="text-sm font-medium" data-testid="attack-summary">
              {finished.length === 0 ? "No attacks run yet" : `Blocked ${blockedCount} of ${finished.length} attack${finished.length === 1 ? "" : "s"} run`}
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        {ATTACKS.map((a) => (
          <AttackCard
            key={a.id}
            attack={a}
            state={runs[a.id] ?? { phase: "idle" }}
            disabled={disabled}
            now={now}
            canAudit={can(me.roles, "audit.read")}
            onRun={() => void run(a)}
            onStop={() => stop(a.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AttackCard({
  attack, state, disabled, now, canAudit, onRun, onStop,
}: { attack: Attack; state: RunState; disabled: boolean; now: number; canAudit: boolean; onRun: () => void; onStop: () => void }) {
  const Icon = ICONS[attack.id] ?? ShieldAlert;
  const seconds = state.startedAt ? Math.max(0, Math.round((now - state.startedAt) / 1000)) : 0;
  const active = state.phase === "preparing" || state.phase === "running";

  return (
    <Card data-testid={`card-${attack.id}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Icon className="size-5 text-red-600" /> {attack.title}</CardTitle>
        <CardDescription>What the hostile agent tries:</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul className="list-disc space-y-0.5 pl-5">{attack.tries.map((t) => <li key={t}>{t}</li>)}</ul>
        <p className="text-xs text-muted-foreground"><b>How it is stopped:</b> {attack.howStopped}</p>

        <div className="flex items-center gap-2">
          <Button variant="destructive" onClick={onRun} disabled={disabled} data-testid={`attack-${attack.id}`}>
            {attack.button}
          </Button>
          {active && state.session && (
            <Button variant="outline" size="sm" onClick={onStop} data-testid={`stop-${attack.id}`}>Stop</Button>
          )}
        </div>

        {active && (
          <p className="flex items-center gap-2 text-muted-foreground" data-testid={`running-${attack.id}`}>
            <Loader2 className="size-4 animate-spin" />
            {state.phase === "preparing" ? "Preparing the hostile agent…" : `Running in a real sandbox (${state.session?.status ?? "starting"}) · ${seconds}s`}
          </p>
        )}

        {state.phase === "error" && (
          <p role="alert" className="flex items-start gap-2 text-destructive" data-testid={`error-${attack.id}`}>
            <CircleAlert className="mt-0.5 size-4 shrink-0" /> {state.error}
          </p>
        )}

        {state.phase === "done" && state.verdict && state.session && (
          <VerdictBox id={attack.id} verdict={state.verdict} session={state.session} canAudit={canAudit} />
        )}
      </CardContent>
    </Card>
  );
}

function VerdictBox({ id, verdict, session, canAudit }: { id: string; verdict: Verdict; session: Session; canAudit: boolean }) {
  const look =
    verdict.outcome === "blocked"
      ? { box: "border-emerald-300 bg-emerald-50 text-emerald-900", icon: <ShieldCheck className="size-6" /> }
      : verdict.outcome === "not-blocked"
        ? { box: "border-red-300 bg-red-50 text-red-900", icon: <OctagonX className="size-6" /> }
        : { box: "border-amber-300 bg-amber-50 text-amber-900", icon: <CircleAlert className="size-6" /> };

  return (
    <div className={cn("rounded-md border-2 p-3", look.box)} data-testid={`verdict-${id}`} data-outcome={verdict.outcome}>
      <div className="flex items-center gap-2 text-lg font-bold">{look.icon} {verdict.headline}</div>
      <p className="mt-1 text-sm">{verdict.reason}</p>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer font-medium">Evidence from the real session</summary>
        <div className="mt-2 space-y-2 text-foreground">
          <div>Session <Link className="text-sky-700 hover:underline" to={`/sessions/${session.id}`}><Mono>{session.id}</Mono></Link> · status <b>{session.status}</b>
            {canAudit && <> · <Link className="text-sky-700 hover:underline" to={`/audit?session_id=${session.id}`}>audit trail</Link></>}
          </div>
          {session.error && <div>Error reported: <Mono>{session.error}</Mono></div>}
          {session.result != null && <JsonBlock value={session.result} className="max-h-40" />}
        </div>
      </details>
    </div>
  );
}
