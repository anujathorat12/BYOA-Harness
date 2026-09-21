import { Fragment, useMemo } from "react";
import { Ban, CheckCircle2, UserCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mono } from "@/components/JsonBlock";
import { explainPolicy, type RuleDecision } from "@/lib/explainPolicy";
import { cn } from "@/lib/utils";

const LOOK: Record<RuleDecision, { icon: typeof Ban; heading: string; box: string }> = {
  deny: { icon: Ban, heading: "text-red-700", box: "border-red-200 bg-red-50/50" },
  "require-approval": { icon: UserCheck, heading: "text-amber-800", box: "border-amber-200 bg-amber-50/50" },
  allow: { icon: CheckCircle2, heading: "text-emerald-700", box: "border-emerald-200 bg-emerald-50/50" },
};

/** Renders `backticked` fragments as code, everything else as plain text. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** The same policy, in sentences. Display only: the server's engine is what actually decides. */
export function PlainEnglish({ source }: { source: string }) {
  const result = useMemo(() => explainPolicy(source), [source]);

  return (
    <Card data-testid="plain-english">
      <CardHeader>
        <CardTitle className="text-base">In plain English</CardTitle>
        <CardDescription>The same rules, worded for people. The YAML is what the harness enforces.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!result.ok ? (
          <p className="text-muted-foreground" data-testid="plain-english-unreadable">{result.message}</p>
        ) : (
          <>
            <div>
              <div className="font-semibold">Policy <Mono>{result.value.id}</Mono></div>
              {result.value.description && <p className="text-muted-foreground">{result.value.description}</p>}
            </div>

            {result.value.sections.length === 0 && <p className="text-muted-foreground">This policy has no rules, so everything is denied.</p>}
            {result.value.sections.map((s) => {
              const look = LOOK[s.decision];
              const Icon = look.icon;
              return (
                <section key={s.decision} className={cn("rounded-md border p-3", look.box)} data-testid={`pe-${s.decision}`}>
                  <h3 className={cn("mb-2 flex items-center gap-2 font-semibold", look.heading)}>
                    <Icon className="size-4" /> {s.heading}
                  </h3>
                  <ul className="space-y-2">
                    {s.items.map((it) => (
                      <li key={it.ruleId}>
                        <div><Inline text={it.sentence} /></div>
                        {it.reason && <div className="text-xs italic text-muted-foreground">Why: {it.reason}</div>}
                        <Mono className="text-muted-foreground">rule {it.ruleId}</Mono>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}

            {result.value.limits.length > 0 && (
              <section className="rounded-md border p-3">
                <h3 className="mb-2 font-semibold">Limits</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {result.value.limits.map((l) => <li key={l}><Inline text={l} /></li>)}
                </ul>
              </section>
            )}

            <p className="text-xs text-muted-foreground">{result.value.fallback}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
