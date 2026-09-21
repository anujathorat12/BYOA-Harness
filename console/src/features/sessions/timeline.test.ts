import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@/lib/types";
import { buildTimeline } from "./timeline";

let n = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}, over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: ++n, session_id: "s", seq: n, ts: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`, agent_id: "a", kind,
  action_type: null, resource: null, effect: null, rule_id: null, policy_id: null, policy_version: null,
  payload, hash: "h", ...over,
});
const decided = (callId: string, effect: AuditEvent["effect"], digest: string, type = "production.modify") =>
  ev("action.decided", { call_id: callId, action_digest: digest },
    { effect, action_type: type, resource: "api", rule_id: "r", policy_id: "p", policy_version: 1 });

describe("timeline", () => {
  it("pairs each decision with its outcome", () => {
    const t = buildTimeline([ev("session.started"), decided("1", "allow", "d1"), ev("action.executed", { call_id: "1", status: "ok" })]);
    const call = t.items.find((i) => i.type === "call");
    expect(call && call.type === "call" && call.outcome?.kind).toBe("action.executed");
    expect(t.frozen).toBeNull();
  });

  it("reports the session frozen while an approval is unresolved, and unfreezes on resolution", () => {
    const base = [decided("1", "require-approval", "dA"), ev("approval.requested", { approval_id: "apr_1", action_digest: "dA" })];
    expect(buildTimeline(base).frozen).toMatchObject({ approvalId: "apr_1", callId: "1", actionType: "production.modify" });

    const resumed = buildTimeline([
      ...base, ev("approval.resolved", { approval_id: "apr_1", status: "approved" }), ev("action.executed", { call_id: "1" }),
    ]);
    expect(resumed.frozen).toBeNull();
    const call = resumed.items.find((i) => i.type === "call");
    expect(call && call.type === "call" && call.approval?.resolved?.payload.status).toBe("approved");
  });

  it("matches an approval to the right call by action digest when calls interleave", () => {
    const t = buildTimeline([
      decided("1", "require-approval", "dA"),
      decided("2", "require-approval", "dB"),
      ev("approval.requested", { approval_id: "apr_B", action_digest: "dB" }),
    ]);
    expect(t.frozen?.callId).toBe("2");
  });

  it("orders by event id regardless of arrival order", () => {
    const a = decided("1", "deny", "d1", "production.delete");
    const b = ev("agent.progress", { message: "x" });
    expect(buildTimeline([b, a]).items.map((i) => i.type)).toEqual(["call", "progress"]);
  });

  it("records a failed outcome", () => {
    const call = buildTimeline([decided("1", "allow", "d"), ev("action.failed", { call_id: "1", error: "boom" })]).items[0];
    expect(call?.type === "call" && call.outcome?.kind).toBe("action.failed");
  });
});
