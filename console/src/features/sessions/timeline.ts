import type { AuditEvent } from "@/lib/types";

/**
 * Folds the flat, ordered audit stream of one session into per-call rows.
 * Pure: it only regroups what the backend recorded; it never decides anything itself.
 *
 *   action.decided ─┬─ (approval.requested ─ approval.resolved)? ─ action.executed | action.failed
 */
export interface CallItem {
  type: "call";
  callId: string;
  decided: AuditEvent;
  approval?: { requested: AuditEvent; resolved?: AuditEvent };
  outcome?: AuditEvent;
}
export type TimelineItem =
  | CallItem
  | { type: "progress"; event: AuditEvent }
  | { type: "lifecycle"; event: AuditEvent };

export interface FrozenInfo {
  approvalId: string;
  callId: string;
  since: string;
  actionType: string | null;
  resource: string | null;
}

export interface Timeline {
  items: TimelineItem[];
  /** The call currently waiting on a human, if any. */
  frozen: FrozenInfo | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function buildTimeline(events: readonly AuditEvent[]): Timeline {
  const items: TimelineItem[] = [];
  const byCall = new Map<string, CallItem>();
  const byApproval = new Map<string, CallItem>();

  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    const callId = str(e.payload.call_id);
    switch (e.kind) {
      case "action.decided": {
        const item: CallItem = { type: "call", callId: callId ?? `#${e.id}`, decided: e };
        byCall.set(item.callId, item);
        items.push(item);
        break;
      }
      case "action.executed":
      case "action.failed": {
        const item = callId ? byCall.get(callId) : undefined;
        if (item) item.outcome = e;
        break;
      }
      case "approval.requested": {
        const digest = str(e.payload.action_digest);
        const approvalId = str(e.payload.approval_id);
        const target = [...byCall.values()]
          .reverse()
          .find((c) => !c.approval && c.decided.effect === "require-approval" && str(c.decided.payload.action_digest) === digest);
        if (target && approvalId) {
          target.approval = { requested: e };
          byApproval.set(approvalId, target);
        }
        break;
      }
      case "approval.resolved": {
        const approvalId = str(e.payload.approval_id);
        const target = approvalId ? byApproval.get(approvalId) : undefined;
        if (target?.approval) target.approval.resolved = e;
        break;
      }
      case "agent.progress":
        items.push({ type: "progress", event: e });
        break;
      default:
        if (e.kind.startsWith("session.")) items.push({ type: "lifecycle", event: e });
    }
  }

  let frozen: FrozenInfo | null = null;
  for (const c of byCall.values()) {
    if (c.approval && !c.approval.resolved) {
      frozen = {
        approvalId: str(c.approval.requested.payload.approval_id) ?? "",
        callId: c.callId,
        since: c.approval.requested.ts,
        actionType: c.decided.action_type,
        resource: c.decided.resource,
      };
    }
  }
  return { items, frozen };
}
