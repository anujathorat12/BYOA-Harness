import { Link } from "react-router-dom";
import { EffectBadge } from "@/components/badges";
import { JsonBlock, Mono } from "@/components/JsonBlock";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMe } from "@/lib/auth";
import { formatTs } from "@/lib/format";
import { can } from "@/lib/roles";
import type { AuditEvent } from "@/lib/types";
import { ChainVerifier } from "./ChainVerifier";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function AuditEventSheet({ event, onClose }: { event: AuditEvent | null; onClose: () => void }) {
  const me = useMe();
  const p = event ? obj(event.payload) : {};
  const decision = obj(p.decision);
  const isDecision = event?.kind === "action.decided";

  return (
    <Sheet open={!!event} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[620px] overflow-y-auto sm:max-w-[620px]">
        {event && (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-base">{event.kind}</SheetTitle>
              <SheetDescription>Event #{event.id} · seq {event.seq} in its session · {formatTs(event.ts)}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-8" data-testid="audit-drilldown">
              <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Agent</dt><dd>{event.agent_id}</dd>
                <dt className="text-muted-foreground">Session</dt>
                <dd>{event.session_id.startsWith("ses_") ? <Link className="text-sky-700 hover:underline" to={`/sessions/${event.session_id}`}><Mono>{event.session_id}</Mono></Link> : <Mono>{event.session_id}</Mono>}</dd>
                {event.action_type && (<><dt className="text-muted-foreground">Action</dt><dd><Mono>{event.action_type}</Mono> <Mono className="text-muted-foreground">{event.resource}</Mono></dd></>)}
                {event.effect && (<><dt className="text-muted-foreground">Decision</dt><dd><EffectBadge effect={event.effect} /></dd></>)}
                {event.rule_id && (<><dt className="text-muted-foreground">Rule that fired</dt><dd><Mono className="rounded bg-muted px-1.5 py-0.5 font-semibold" data-testid="drill-rule">{event.rule_id}</Mono></dd></>)}
                {event.policy_id ? (
                  <>
                    <dt className="text-muted-foreground">Governing policy</dt>
                    <dd>
                      <Mono data-testid="drill-policy">{event.policy_id}@v{event.policy_version}</Mono>{" "}
                      {can(me.roles, "policy.read") && <Link className="ml-2 text-xs text-sky-700 hover:underline" to={`/policies?policy=${event.policy_id}&version=${event.policy_version}`}>view this exact version →</Link>}
                    </dd>
                  </>
                ) : event.rule_id ? (<><dt className="text-muted-foreground">Governing policy</dt><dd className="text-muted-foreground">none — refused by the harness itself before policy evaluation</dd></>) : null}
                {typeof decision.reason === "string" && decision.reason && (<><dt className="text-muted-foreground">Why</dt><dd>{decision.reason}</dd></>)}
                {Array.isArray(decision.matched_rules) && decision.matched_rules.length > 0 && (<><dt className="text-muted-foreground">All matching rules</dt><dd><Mono>{(decision.matched_rules as string[]).join(", ")}</Mono> <span className="text-xs text-muted-foreground">(deny &gt; approval &gt; allow)</span></dd></>)}
              </dl>

              {isDecision && p.action != null && (<section><h3 className="mb-1 text-sm font-semibold">Canonical action evaluated</h3><JsonBlock value={p.action} className="max-h-56" /></section>)}
              {isDecision && p.context != null && (<section><h3 className="mb-1 text-sm font-semibold">Evaluation context</h3><JsonBlock value={p.context} className="max-h-40" /></section>)}
              {!isDecision && <section><h3 className="mb-1 text-sm font-semibold">Payload</h3><JsonBlock value={event.payload} className="max-h-64" /></section>}

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Tamper evidence</h3>
                <p className="text-xs text-muted-foreground">Event hash <Mono>{event.hash}</Mono></p>
                {event.session_id.startsWith("ses_") && <ChainVerifier sessionId={event.session_id} />}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
