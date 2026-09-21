import { describe, expect, it } from "vitest";
import { approvalBlockReason, can, denyReason } from "./roles";
import type { Approval, Whoami } from "./types";

const me = (roles: Whoami["roles"], name = "bob", sod = true): Whoami => ({ name, roles, separation_of_duties: sod });
const approval = (over: Partial<Approval> = {}): Approval =>
  ({ id: "apr_1", submitted_by: "alice", status: "pending", ...over }) as Approval;

describe("role matrix mirrors the backend", () => {
  it("admin satisfies every capability", () => {
    for (const cap of ["agent.register", "policy.write", "approval.decide", "audit.verify", "overview.read"] as const) {
      expect(can(["admin"], cap)).toBe(true);
    }
  });
  it("developers cannot read policies, audit or overview, and cannot write policy", () => {
    for (const cap of ["policy.read", "policy.write", "audit.read", "overview.read", "approval.read"] as const) {
      expect(can(["developer"], cap)).toBe(false);
    }
    expect(can(["developer"], "session.submit")).toBe(true);
  });
  it("approvers can read audit but cannot verify chains (auditor-only on the server)", () => {
    expect(can(["approver"], "audit.read")).toBe(true);
    expect(can(["approver"], "audit.verify")).toBe(false);
    expect(denyReason(["approver"], "audit.verify")).toMatch(/auditor/);
  });
  it("only admins write policy", () => {
    expect(can(["auditor"], "policy.write")).toBe(false);
    expect(can(["auditor"], "policy.read")).toBe(true);
  });
});

describe("approval decision guard", () => {
  it("lets a different approver decide", () => {
    expect(approvalBlockReason(approval(), me(["approver"]))).toBeNull();
  });
  it("blocks the submitter with an explanation (separation of duties)", () => {
    expect(approvalBlockReason(approval({ submitted_by: "bob" }), me(["approver"]))).toMatch(/Separation of duties/);
  });
  it("does not claim separation of duties when the server has it disabled", () => {
    expect(approvalBlockReason(approval({ submitted_by: "bob" }), me(["approver"], "bob", false))).toBeNull();
  });
  it("blocks non-approvers and already-decided approvals", () => {
    expect(approvalBlockReason(approval(), me(["auditor"]))).toMatch(/Requires role/);
    expect(approvalBlockReason(approval({ status: "approved" }), me(["approver"]))).toMatch(/Already approved/);
  });
});
