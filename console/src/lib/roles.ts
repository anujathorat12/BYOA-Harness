import type { Approval, Role, Whoami } from "./types";

/**
 * Mirrors the backend's `need(...)` dependencies in api/app.py. The server is the authority (it enforces
 * these regardless); this matrix exists so the UI can disable controls and say WHY instead of failing on click.
 * `admin` satisfies every requirement, exactly like the server.
 */
export type Capability =
  | "agent.register"
  | "policy.read" // list/get/validate/evaluate/simulate
  | "policy.write" // create version, attach, detach
  | "session.submit"
  | "approval.read"
  | "approval.decide"
  | "audit.read"
  | "audit.verify"
  | "overview.read";

const NEEDS: Record<Capability, Role[]> = {
  "agent.register": ["developer"],
  "policy.read": ["auditor"],
  "policy.write": [],
  "session.submit": ["developer"],
  "approval.read": ["approver", "auditor"],
  "approval.decide": ["approver"],
  "audit.read": ["auditor", "approver"],
  "audit.verify": ["auditor"],
  "overview.read": ["auditor", "approver"],
};

export function can(roles: readonly Role[], cap: Capability): boolean {
  return roles.includes("admin") || NEEDS[cap].some((r) => roles.includes(r));
}

export function requirement(cap: Capability): string {
  const needs = NEEDS[cap];
  return needs.length ? `admin, ${needs.join(", ")}` : "admin";
}

export function denyReason(roles: readonly Role[], cap: Capability): string | null {
  return can(roles, cap) ? null : `Requires role: ${requirement(cap)}`;
}

/** Why this operator cannot decide this approval, or null if they can. */
export function approvalBlockReason(approval: Approval, me: Whoami): string | null {
  const role = denyReason(me.roles, "approval.decide");
  if (role) return role;
  if (approval.status !== "pending") return `Already ${approval.status}`;
  if (me.separation_of_duties && approval.submitted_by === me.name) {
    return "Separation of duties: you submitted this task, so you cannot approve its actions";
  }
  return null;
}
