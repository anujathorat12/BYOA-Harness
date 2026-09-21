import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Ban, ChevronDown, ChevronRight, CircleCheck, CircleX, Flag, Hourglass, MessageSquare, Play, UserCheck } from "lucide-react";
import { EffectBadge } from "@/components/badges";
import { JsonBlock, Mono } from "@/components/JsonBlock";
import { formatTs } from "@/lib/format";
import type { AuditEvent } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { CallItem, Timeline } from "./timeline";

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const asStr = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function Row({ icon, ts, children, tone }: { icon: ReactNode; ts: string; children: ReactNode; tone?: string }) {
  return (
    <div className="flex items-start gap-3 py-1.5 text-sm">
      <div className={cn("mt-0.5 text-muted-foreground", tone)}>{icon}</div>
      <div className="min-w-0 flex-1">{children}</div>
      <Mono className="shrink-0 text-muted-foreground">{formatTs(ts).slice(11)}</Mono>
    </div>
  );
}

function CallRow({ item }: { item: CallItem }) {
  const [open, setOpen] = useState(false);
  const d = item.decided;
  const payload = asObj(d.payload);
  const decision = asObj(payload.decision);
  const action = asObj(payload.action);
  const reason = asStr(decision.reason);
  const effect = d.effect;
  const blocked = effect === "deny";
  const out = item.outcome ? asObj(item.outcome.payload) : null;
  const approval = item.approval;
  const resolved = approval?.resolved ? asObj(approval.resolved.payload) : null;

  return (
    <div className={cn("my-1 rounded-md border bg-card", blocked && "border-red-200 bg-red-50/40", effect === "require-approval" && "border-amber-200 bg-amber-50/40")} data-testid={`call-${item.callId}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-3 py-2 text-left">
        {open ? <ChevronDown className="mt-1 size-4 text-muted-foreground" /> : <ChevronRight className="mt-1 size-4 text-muted-foreground" />}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Mono className="text-[13px] font-semibold">{d.action_type ?? asStr(payload.tool)}</Mono>
            {d.resource && <Mono className="text-muted-foreground">{d.resource}</Mono>}
            <EffectBadge effect={effect} />
            {d.rule_id && <Mono className="rounded bg-muted px-1.5 py-0.5" data-testid="rule-chip">rule {d.rule_id}</Mono>}
            {d.policy_id ? <Mono className="text-muted-foreground">{d.policy_id}@v{d.policy_version}</Mono> : <span className="text-xs text-muted-foreground">harness</span>}
          </div>
          {reason && <div className="text-xs text-muted-foreground">{reason}</div>}
          {approval && (
            <div className="flex items-center gap-1.5 text-xs" data-testid="approval-line">
              {resolved ? (
                <>
                  <UserCheck className={cn("size-3.5", resolved.status === "approved" ? "text-emerald-600" : "text-red-600")} />
                  <span>{asStr(resolved.status)} by <b>{asStr(resolved.decided_by)}</b>{asStr(resolved.comment) && <> — “{asStr(resolved.comment)}”</>}</span>
                </>
              ) : (
                <>
                  <Hourglass className="size-3.5 text-amber-600" />
                  <span className="font-medium text-amber-800">frozen — waiting on a human decision</span>
                </>
              )}
            </div>
          )}
          {blocked && <div className="flex items-center gap-1.5 text-xs text-red-700"><Ban className="size-3.5" /> blocked at the enforcement point — never reached the resource</div>}
          {out && (
            <div className="flex items-center gap-1.5 text-xs">
              {out.status === "ok" ? <CircleCheck className="size-3.5 text-emerald-600" /> : <CircleX className="size-3.5 text-red-600" />}
              <span>{out.status === "ok" ? `executed in ${asStr(out.duration_ms)} ms` : `${asStr(out.status)}${out.error ? `: ${asStr(out.error)}` : ""}`}</span>
            </div>
          )}
        </div>
        <Mono className="shrink-0 text-muted-foreground">{formatTs(d.ts).slice(11)}</Mono>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div><div className="mb-1 text-xs font-medium text-muted-foreground">Canonical action (what was evaluated and executed)</div><JsonBlock value={Object.keys(action).length ? action : payload.args} className="max-h-48" /></div>
            <div><div className="mb-1 text-xs font-medium text-muted-foreground">Decision</div><JsonBlock value={decision} className="max-h-48" /></div>
          </div>
          <div className="text-xs text-muted-foreground">
            digest <Mono>{asStr(payload.action_digest).slice(0, 16) || "—"}</Mono> · audit event <Link className="text-sky-700 hover:underline" to={`/audit?session_id=${d.session_id}`}>#{d.id}</Link>
          </div>
          {out?.result_preview != null && <div><div className="mb-1 text-xs font-medium text-muted-foreground">Result</div><JsonBlock value={out.result_preview} className="max-h-40" /></div>}
        </div>
      )}
    </div>
  );
}

function lifecycleText(e: AuditEvent): { icon: ReactNode; text: ReactNode; tone?: string } {
  const p = asObj(e.payload);
  if (e.kind === "session.created") return { icon: <Flag className="size-4" />, text: <>Submitted by <b>{asStr(p.submitted_by)}</b></> };
  if (e.kind === "session.started") {
    const lim = asObj(p.limits);
    return { icon: <Play className="size-4" />, text: <>Sandbox started · {asStr(p.shape)} agent · {asStr(lim.memory_mb)} MB · {asStr(lim.cpus)} cpu · {asStr(lim.timeout_s)}s limit</> };
  }
  const status = asStr(p.status);
  return {
    icon: status === "succeeded" ? <CircleCheck className="size-4" /> : <CircleX className="size-4" />,
    tone: status === "succeeded" ? "text-emerald-600" : "text-red-600",
    text: <>Session <b>{status}</b>{asStr(p.reason) && <> — {asStr(p.reason)}</>} · {asStr(p.actions)} actions · {asStr(p.spent_tokens)} tokens · {asStr(p.spent_amount)} spent</>,
  };
}

export function SessionTimeline({ timeline }: { timeline: Timeline }) {
  if (timeline.items.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">Waiting for the first event…</p>;
  return (
    <div data-testid="timeline">
      {timeline.items.map((it, i) => {
        if (it.type === "call") return <CallRow key={`c${it.decided.id}`} item={it} />;
        if (it.type === "progress") {
          return <Row key={`p${it.event.id}`} icon={<MessageSquare className="size-4" />} ts={it.event.ts}><span className="text-muted-foreground">{asStr(asObj(it.event.payload).message)}</span></Row>;
        }
        const l = lifecycleText(it.event);
        return <Row key={`l${i}${it.event.id}`} icon={l.icon} tone={l.tone} ts={it.event.ts}>{l.text}</Row>;
      })}
    </div>
  );
}
