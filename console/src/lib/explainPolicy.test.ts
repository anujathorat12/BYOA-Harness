/// <reference types="node" />
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { explainPolicy, type ExplainedPolicy } from "./explainPolicy";

const example = (name: string) => readFileSync(path.resolve(import.meta.dirname, "../../../examples/policies", `${name}.yaml`), "utf8");

function ok(source: string): ExplainedPolicy {
  const r = explainPolicy(source);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}
const sentences = (p: ExplainedPolicy, heading: string) => p.sections.find((s) => s.heading === heading)?.items.map((i) => i.sentence) ?? [];

describe("explainPolicy on the shipped example policies", () => {
  it("enterprise-it: read logs is allowed, production change needs a human, delete is never allowed", () => {
    const p = ok(example("enterprise-it"));
    expect(p.id).toBe("enterprise-it");
    expect(sentences(p, "Allowed")).toContain("Read data on anything matching `prod.logs*`.");
    expect(sentences(p, "A human must approve first")).toEqual(["Change production."]);
    expect(sentences(p, "Never allowed")).toEqual(["Delete things in production."]);
    expect(p.limits).toContain("A task may attempt at most 50 actions (denied attempts count).");
  });

  it("financial-ops: threshold conditions, budgets and reasons are carried through", () => {
    const p = ok(example("financial-ops"));
    expect(sentences(p, "A human must approve first")).toEqual(["Transfer money when `params.amount` is more than `1000`."]);
    expect(sentences(p, "Allowed")).toContain("Transfer money when `params.amount` is at most `1000`.");
    expect(sentences(p, "Never allowed")).toEqual(["Read data on anything matching `finance.accounts*`."]);
    expect(p.limits).toEqual([
      "A task may use at most 20,000 AI tokens. This is a hard stop; no human is asked.",
      "A task may spend at most 25,000 in total. This is a hard stop; no human is asked.",
    ]);
    const denied = p.sections.find((s) => s.heading === "Never allowed")!.items[0]!;
    expect(denied.ruleId).toBe("deny-account-master-data");
    expect(denied.reason).toMatch(/out of scope/);
  });

  it("healthcare-data: export needs approval, restricted records are denied", () => {
    const p = ok(example("healthcare-data"));
    expect(sentences(p, "A human must approve first")).toEqual(["Send data out of the system."]);
    expect(sentences(p, "Never allowed")).toEqual(["Read data on anything matching `health.records.restricted*`."]);
  });
});

describe("explainPolicy edge cases", () => {
  it("orders sections strictest first, the same precedence the engine uses", () => {
    const p = ok("id: p\nrules:\n - {id: a, decision: allow}\n - {id: b, decision: require-approval}\n - {id: c, decision: deny}\n");
    expect(p.sections.map((s) => s.decision)).toEqual(["deny", "require-approval", "allow"]);
  });

  it("describes wildcards, unknown action types, lists and exists", () => {
    const p = ok(`id: p
rules:
  - {id: r1, decision: allow}
  - {id: r2, decision: allow, match: {type: "data.*"}}
  - {id: r3, decision: deny, match: {type: "vault.open", resource: "s3://x", when: [{field: params.k, op: in, value: [a, b]}, {field: params.z, op: exists, value: false}]}}
`);
    expect(sentences(p, "Allowed")).toEqual(["Do anything.", "Do any data action (`data.*`)."]);
    expect(sentences(p, "Never allowed")).toEqual(["Do `vault.open` on `s3://x` when `params.k` is one of `a`, `b` and `params.z` is absent."]);
  });

  it("accepts the policy: wrapper and mentions scope", () => {
    const p = ok("policy:\n  id: wrapped\n  scope: {agents: [bot-1]}\n  rules: []\n");
    expect(p.id).toBe("wrapped");
    expect(p.sections).toEqual([]);
    expect(p.limits).toEqual(["This policy can only be attached to: `bot-1`."]);
  });

  it("never throws on garbage; says why it cannot be read yet", () => {
    for (const bad of ["", "- just\n- a list", "id: [", "42", "rules: nope"]) {
      const r = explainPolicy(bad);
      if (r.ok) expect(r.value.sections).toEqual([]);
      else expect(r.message).toMatch(/Not readable yet/);
    }
  });

  it("ignores malformed rules instead of guessing", () => {
    const p = ok("id: p\nrules:\n - not-a-mapping\n - {id: x, decision: maybe}\n - {decision: allow}\n - {id: ok, decision: deny}\n");
    expect(p.sections).toHaveLength(1);
    expect(p.sections[0]!.items.map((i) => i.ruleId)).toEqual(["ok"]);
  });
});
