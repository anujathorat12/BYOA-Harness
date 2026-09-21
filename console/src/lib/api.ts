import type {
  AgentDetail, AgentSummary, Approval, ApprovalStatus, AuditPage, ChainVerification, EvaluationResult, Health,
  Overview, PolicyCreated, PolicyDocument, PolicyValidation, PolicyVersionRow, Readiness, Session,
  SimulationResult, Whoami,
} from "./types";

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const TOKEN_KEY = "byoa.console.apikey";

/** The API key lives in sessionStorage only: it dies with the tab and is never written to localStorage. */
export const credentials = {
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    sessionStorage.setItem(TOKEN_KEY, token);
  },
  clear() {
    sessionStorage.removeItem(TOKEN_KEY);
  },
};

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export function notifyUnauthorized() {
  onUnauthorized?.();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

export function apiUrl(path: string) {
  return `${BASE}${path}`;
}

async function toError(res: Response): Promise<ApiError> {
  let message = res.statusText || `HTTP ${res.status}`;
  let requestId: string | undefined;
  try {
    const body = await res.json();
    message = body?.error?.message ?? message;
    requestId = body?.error?.request_id || undefined;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, message, requestId);
}

interface Options {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  token?: string; // explicit token (login check) instead of the stored one
}

async function request<T>(path: string, opts: Options = {}): Promise<T> {
  const token = opts.token ?? credentials.get();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const url = apiUrl(path) + (qs.size ? `?${qs}` : "");
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!res.ok) {
    if (res.status === 401 && opts.token === undefined) onUnauthorized?.();
    throw await toError(res);
  }
  return (await res.json()) as T;
}

export interface AuditFilters {
  session_id?: string;
  agent_id?: string;
  kind?: string;
  effect?: string;
  rule_id?: string;
  action_type?: string;
  since?: string;
  until?: string;
}

export const api = {
  whoami: (token?: string) => request<Whoami>("/v1/whoami", { token }),
  health: () => request<Health>("/healthz"),
  readiness: async (): Promise<Readiness> => {
    // /readyz answers 503 WITH a useful body when a dependency is down; that is data, not an error.
    const res = await fetch(apiUrl("/readyz"));
    return (await res.json()) as Readiness;
  },
  overview: () => request<Overview>("/v1/admin/overview"),

  agents: () => request<AgentSummary[]>("/v1/agents"),
  agent: (id: string) => request<AgentDetail>(`/v1/agents/${encodeURIComponent(id)}`),
  registerAgent: (body: Record<string, unknown>) => request<{ id: string; version: number }>("/v1/agents", { method: "POST", body }),
  attachPolicy: (agentId: string, policy_id: string, version?: number | null) =>
    request(`/v1/agents/${encodeURIComponent(agentId)}/policies`, { method: "POST", body: { policy_id, version: version ?? null } }),
  detachPolicy: (agentId: string, policyId: string) =>
    request(`/v1/agents/${encodeURIComponent(agentId)}/policies/${encodeURIComponent(policyId)}`, { method: "DELETE" }),

  policies: () => request<PolicyVersionRow[]>("/v1/policies"),
  policy: (id: string, version?: number) => request<PolicyDocument>(`/v1/policies/${encodeURIComponent(id)}`, { query: { version } }),
  validatePolicy: (document: string, signal?: AbortSignal) =>
    request<PolicyValidation>("/v1/policies/validate", { method: "POST", body: { document }, signal }),
  createPolicy: (document: string) => request<PolicyCreated>("/v1/policies", { method: "POST", body: { document } }),
  evaluate: (body: Record<string, unknown>) => request<EvaluationResult>("/v1/policies/evaluate", { method: "POST", body }),
  simulate: (body: Record<string, unknown>) => request<SimulationResult>("/v1/policies/simulate", { method: "POST", body }),

  sessions: (query: { agent_id?: string; status?: string; limit?: number } = {}) => request<Session[]>("/v1/sessions", { query }),
  session: (id: string) => request<Session>(`/v1/sessions/${encodeURIComponent(id)}`),
  submit: (agentId: string, body: { task: unknown; policies: { id: string; version?: number }[] }) =>
    request<Session>(`/v1/agents/${encodeURIComponent(agentId)}/sessions`, { method: "POST", body }),
  cancel: (id: string) => request<{ cancelled: boolean }>(`/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),

  approvals: (status?: ApprovalStatus | "") => request<Approval[]>("/v1/approvals", { query: { status: status || undefined } }),
  decide: (id: string, verdict: "approve" | "deny", comment: string) =>
    request<Approval>(`/v1/approvals/${encodeURIComponent(id)}/${verdict}`, { method: "POST", body: { comment } }),

  audit: (filters: AuditFilters, page: { before_id?: number; limit?: number; order?: "asc" | "desc" } = {}) =>
    request<AuditPage>("/v1/audit", { query: { ...filters, ...page } }),
  verifyChain: (sessionId: string) => request<ChainVerification>(`/v1/audit/sessions/${encodeURIComponent(sessionId)}/verify`),
};
