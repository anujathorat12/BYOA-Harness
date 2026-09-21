import { describe, expect, it } from "vitest";
import type { Session } from "@/lib/types";
import { ATTACKS, type Attack } from "./attacks";

const session = (over: Partial<Session>): Session => ({ id: "ses_x", status: "succeeded", result: null, error: null, ...over }) as Session;
const attack = (id: string): Attack => ATTACKS.find((a) => a.id === id)!;

describe("the attack catalog", () => {
  it("has the four attacks with unique ids and valid agent ids", () => {
    expect(ATTACKS.map((a) => a.id)).toEqual(["internet", "memory", "hang", "forge"]);
    expect(new Set(ATTACKS.map((a) => a.agentId)).size).toBe(4);
    for (const a of ATTACKS) expect(a.agentId).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/); // the API's agent-id rule
  });

  it("each hostile program defines run(ctx), stays stdlib-only, and fits the request limits", () => {
    for (const a of ATTACKS) {
      expect(a.code).toContain("def run(ctx):");
      expect(a.code).not.toMatch(/^\s*(import|from)\s+(requests|numpy|pandas)/m);
      expect(a.code.length).toBeLessThan(2000);
      expect(a.resources.timeout_s).toBeGreaterThanOrEqual(1);
      expect(a.resources.timeout_s).toBeLessThanOrEqual(3600);
      if (a.resources.memory_mb !== undefined) {
        expect(a.resources.memory_mb).toBeGreaterThanOrEqual(16);
        expect(a.resources.memory_mb).toBeLessThanOrEqual(4096);
      }
    }
  });

  it("uses no characters that would break inside a template string", () => {
    for (const a of ATTACKS) {
      expect(a.code).not.toContain("\\");
      expect(a.code).not.toContain("`");
      expect(a.code).not.toContain("${");
    }
  });
});

describe("judging the internet attack", () => {
  const j = attack("internet").judge;
  it("BLOCKED when every attempt failed", () => {
    const v = j(session({ result: { reached_the_internet: false, attempts: { "connect to 1.1.1.1:53": "blocked (OSError)" } } }));
    expect(v.outcome).toBe("blocked");
    expect(v.reason).toContain("connect to 1.1.1.1:53: blocked (OSError)");
  });
  it("NOT BLOCKED if the agent really reached the internet", () => {
    expect(j(session({ result: { reached_the_internet: true, attempts: {} } })).outcome).toBe("not-blocked");
  });
  it("unexpected for a failed session or a malformed result (never a green result it did not earn)", () => {
    expect(j(session({ status: "failed", error: "sandbox failed to start" })).outcome).toBe("unexpected");
    expect(j(session({ result: "nonsense" })).outcome).toBe("unexpected");
    expect(j(session({ result: null })).outcome).toBe("unexpected");
  });
});

describe("judging the memory attack", () => {
  const j = attack("memory").judge;
  it("BLOCKED only for the memory-limit message", () => {
    expect(j(session({ status: "failed", error: "agent killed: exceeded memory limit (64 MB)" })).outcome).toBe("blocked");
    expect(j(session({ status: "failed", error: "timeout: exceeded 30s of active runtime" })).outcome).toBe("unexpected");
    expect(j(session({ status: "failed", error: "agent exited without a result (code 137)" })).outcome).toBe("unexpected");
  });
  it("NOT BLOCKED if it somehow finished", () => {
    expect(j(session({ status: "succeeded" })).outcome).toBe("not-blocked");
  });
});

describe("judging the hang and forge attacks", () => {
  it("hang: BLOCKED by the clock", () => {
    const j = attack("hang").judge;
    expect(j(session({ status: "failed", error: "timeout: exceeded 10s of active runtime" })).outcome).toBe("blocked");
    expect(j(session({ status: "failed", error: "protocol violation: x" })).outcome).toBe("unexpected");
    expect(j(session({ status: "succeeded" })).outcome).toBe("not-blocked");
  });
  it("forge: BLOCKED as a protocol violation", () => {
    const j = attack("forge").judge;
    const v = j(session({ status: "failed", error: "protocol violation: unknown message type 'approval'" }));
    expect(v.outcome).toBe("blocked");
    expect(v.reason).toContain("unknown message type 'approval'");
    expect(j(session({ status: "cancelled" })).outcome).toBe("unexpected");
    expect(j(session({ status: "succeeded" })).outcome).toBe("not-blocked");
  });
});
