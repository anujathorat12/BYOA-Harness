// Response shapes of the harness API. The backend returns plain dicts (no pydantic response models), so
// these are written by hand from `api/app.py` and verified against live responses (see e2e/).

export type Role = "admin" | "developer" | "approver" | "auditor";
export type Effect = "allow" | "deny" | "require-approval";
export type SessionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
const FINISHED: readonly SessionStatus[] = ["succeeded", "failed", "cancelled"];
/** A session in one of these states will never change again, so polling and streaming can stop. */
export const isFinished = (status: SessionStatus): boolean => FINISHED.includes(status);
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type Shape = "package" | "declarative";

export interface Whoami {
  name: string;
  roles: Role[];
  separation_of_duties: boolean;
}

interface PolicyAttachmentRef {
  policy_id: string;
  policy_version: number | null; // null = follows latest at session start
}

export interface AgentSummary {
  id: string;
  version: number;
  shape: Shape;
  owner: string;
  created_at: string;
  policies: PolicyAttachmentRef[];
}

export interface AgentDetail {
  id: string;
  version: number;
  owner: string;
  shape: Shape;
  created_at: string;
  manifest: Record<string, unknown>;
  policies: (PolicyAttachmentRef & { agent_id: string; attached_by: string; attached_at: string })[];
}

interface PinnedPolicy {
  id: string;
  version: number;
  source: "agent" | "session";
}

export interface Session {
  id: string;
  agent_id: string;
  agent_version: number;
  submitted_by: string;
  status: SessionStatus;
  result: unknown;
  error: string | null;
  policies: PinnedPolicy[];
  spent_tokens: number;
  spent_amount: number;
  action_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AuditEvent {
  id: number;
  session_id: string;
  seq: number;
  ts: string;
  agent_id: string;
  kind: string;
  action_type: string | null;
  resource: string | null;
  effect: Effect | null;
  rule_id: string | null;
  policy_id: string | null;
  policy_version: number | null;
  payload: Record<string, unknown>;
  hash: string;
}

export interface AuditPage {
  events: AuditEvent[];
  next_after_id: number;
  next_before_id: number | null;
}

interface CanonicalAction {
  type: string;
  resource: string;
  params: Record<string, unknown>;
  cost: { tokens: number; amount: number };
}

export interface Approval {
  id: string;
  session_id: string;
  agent_id: string;
  submitted_by: string;
  action: CanonicalAction;
  action_digest: string;
  rule_id: string;
  policy_ref: string;
  status: ApprovalStatus;
  requested_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
}

export interface PolicyVersionRow {
  id: string;
  version: number;
  content_hash: string;
  created_by: string;
  created_at: string;
}

export interface PolicyDocument extends PolicyVersionRow {
  document: string;
}

export interface PolicyValidation {
  valid: boolean;
  id: string;
  rules: number;
  content_hash: string;
}

export interface PolicyCreated {
  id: string;
  version: number;
  content_hash?: string;
  unchanged?: boolean;
}

export interface EvaluationResult {
  effect: Effect;
  rule_id: string;
  policy_id: string;
  policy_version: number;
  reason: string;
  matched_rules: string[];
}

export interface SimulationRow {
  ref: string;
  type: string;
  resource: string;
  original: { effect: Effect; rule_id: string };
  simulated: { effect: Effect; rule_id: string; policy: string };
  changed: boolean;
}

export interface SimulationResult {
  total: number;
  changed: number;
  skipped: number;
  would: Record<Effect, number>;
  results: SimulationRow[];
}

export type ChainVerification =
  | { valid: true; events: number; head_hash: string }
  | { valid: false; events: number; broken_at_seq: number; reason: string };

export interface ActiveSession {
  session_id: string;
  agent_id: string;
  active_seconds: number;
  paused: boolean;
  pending_approvals: number;
  actions: number;
  spent_tokens: number;
  spent_amount: number;
  limits: { memory_mb: number; cpus: number; timeout_s: number };
  sandbox: { cpu?: string; memory?: string; pids?: string };
}

export interface Overview {
  active_sessions: ActiveSession[];
  pending_approvals: Approval[];
  decisions: Partial<Record<Effect | "none", number>>;
  sessions: Partial<Record<SessionStatus, number>>;
  capacity: { max_concurrent: number; max_queued: number };
}

export interface Readiness {
  status: "ready" | "not_ready";
  checks: Record<string, string>;
}

export interface Health {
  status: string;
  version: string;
}
