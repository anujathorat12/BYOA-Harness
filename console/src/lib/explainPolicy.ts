import YAML from "yaml";

/**
 * Turns a policy document into readable sentences.
 *
 * DISPLAY ONLY. This never decides anything: it rewords the fields of the rules exactly as written. The backend's
 * policy engine remains the only thing that evaluates an action. Anything unrecognised is shown verbatim
 * (in code font) rather than guessed at, so the text can never claim more or less than the YAML says.
 */
export type RuleDecision = "deny" | "require-approval" | "allow";

export interface ExplainedRule {
  ruleId: string;
  sentence: string; // may contain `backticked` fragments, rendered as code by the UI
  reason?: string;
}

export interface ExplainedSection {
  decision: RuleDecision;
  heading: string;
  items: ExplainedRule[];
}

export interface ExplainedPolicy {
  id: string;
  description: string;
  sections: ExplainedSection[];
  limits: string[];
  fallback: string;
}

export type ExplainResult = { ok: true; value: ExplainedPolicy } | { ok: false; message: string };

const HEADINGS: Record<RuleDecision, string> = {
  deny: "Never allowed",
  "require-approval": "A human must approve first",
  allow: "Allowed",
};
const ORDER: RuleDecision[] = ["deny", "require-approval", "allow"]; // strictest first, same precedence as the engine

// Friendly names for the built-in action types. Unknown types are shown as-is.
const ACTION_LABELS: Record<string, string> = {
  "data.read": "Read data",
  "data.export": "Send data out of the system",
  "ticket.create": "Create a ticket",
  "production.modify": "Change production",
  "production.delete": "Delete things in production",
  "payment.transfer": "Transfer money",
  "network.request": "Make a web request",
  "llm.complete": "Ask the AI model",
};

const OP_WORDS: Record<string, string> = {
  eq: "is",
  ne: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  in: "is one of",
  not_in: "is none of",
  glob: "matches",
  prefix: "starts with",
  contains: "contains",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = new Intl.NumberFormat("en-US");

function code(text: string): string {
  return `\`${text}\``;
}

function actionPhrase(type: string): string {
  if (type === "*") return "Do anything";
  const known = ACTION_LABELS[type];
  if (known) return known;
  if (type.endsWith(".*")) return `Do any ${type.slice(0, -2)} action (${code(type)})`;
  return `Do ${code(type)}`;
}

function targetPhrase(resource: string): string {
  if (resource === "*") return "";
  return /[*?]/.test(resource) ? ` on anything matching ${code(resource)}` : ` on ${code(resource)}`;
}

function valuePhrase(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => code(String(x))).join(", ");
  return code(String(v));
}

function conditionPhrase(c: unknown): string {
  if (!isRecord(c) || typeof c.field !== "string" || typeof c.op !== "string") return "";
  if (c.op === "exists") return `${code(c.field)} is ${c.value === false ? "absent" : "present"}`;
  const word = OP_WORDS[c.op];
  return word ? `${code(c.field)} ${word} ${valuePhrase(c.value)}` : `${code(c.field)} ${code(c.op)} ${valuePhrase(c.value)}`;
}

function ruleSentence(match: Record<string, unknown>): string {
  const type = typeof match.type === "string" ? match.type : "*";
  const resource = typeof match.resource === "string" ? match.resource : "*";
  const when = Array.isArray(match.when) ? match.when.map(conditionPhrase).filter(Boolean) : [];
  const conditions = when.length ? ` when ${when.join(" and ")}` : "";
  return `${actionPhrase(type)}${targetPhrase(resource)}${conditions}.`;
}

export function explainPolicy(source: string): ExplainResult {
  let data: unknown;
  try {
    data = YAML.parse(source);
  } catch (e) {
    return { ok: false, message: `Not readable yet: ${e instanceof Error ? e.message.split("\n")[0] : "invalid YAML"}` };
  }
  if (isRecord(data) && isRecord(data.policy) && Object.keys(data).length === 1) data = data.policy;
  if (!isRecord(data)) return { ok: false, message: "Not readable yet: a policy is a mapping with an id and rules." };

  const rules = Array.isArray(data.rules) ? data.rules : [];
  const sections: ExplainedSection[] = ORDER.map((decision) => ({ decision, heading: HEADINGS[decision], items: [] }));
  for (const raw of rules) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    const decision = raw.decision as RuleDecision;
    const section = sections.find((s) => s.decision === decision);
    if (!section) continue;
    const item: ExplainedRule = { ruleId: raw.id, sentence: ruleSentence(isRecord(raw.match) ? raw.match : {}) };
    if (typeof raw.reason === "string" && raw.reason.trim()) item.reason = raw.reason.trim();
    section.items.push(item);
  }

  const limits: string[] = [];
  const budgets = isRecord(data.budgets) ? data.budgets : {};
  if (typeof budgets.tokens === "number") limits.push(`A task may use at most ${num.format(budgets.tokens)} AI tokens. This is a hard stop; no human is asked.`);
  if (typeof budgets.amount === "number") limits.push(`A task may spend at most ${num.format(budgets.amount)} in total. This is a hard stop; no human is asked.`);
  const lim = isRecord(data.limits) ? data.limits : {};
  if (typeof lim.max_actions === "number") limits.push(`A task may attempt at most ${num.format(lim.max_actions)} actions (denied attempts count).`);
  const scope = isRecord(data.scope) && Array.isArray(data.scope.agents) ? data.scope.agents.map(String) : [];
  if (scope.length) limits.push(`This policy can only be attached to: ${scope.map(code).join(", ")}.`);

  return {
    ok: true,
    value: {
      id: typeof data.id === "string" ? data.id : "(no id yet)",
      description: typeof data.description === "string" ? data.description : "",
      sections: sections.filter((s) => s.items.length > 0),
      limits,
      fallback: "Anything not listed here is denied. If several rules match one action, the strictest wins: deny beats ask-a-human beats allow.",
    },
  };
}
