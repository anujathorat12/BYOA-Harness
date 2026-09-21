import type { Session } from "@/lib/types";

/**
 * The Attack Lab catalog: four deliberately hostile agents, and how to read what really happened when each one runs.
 *
 * `judge` never decides anything about security by itself. It reads the REAL outcome of a REAL sandboxed session
 * (status, error message, result) and answers one question: was the attack contained the way we claim? If the
 * outcome is anything else it says so ("unexpected"), so the screen cannot show a green result the system did not earn.
 *
 * The Python sources avoid backslashes, backticks and template placeholders on purpose (they live in template strings).
 */
export type Outcome = "blocked" | "not-blocked" | "unexpected";

export interface Verdict {
  outcome: Outcome;
  headline: string;
  reason: string;
}

export interface Attack {
  id: string;
  agentId: string;
  title: string;
  button: string;
  tries: string[];
  howStopped: string;
  code: string;
  resources: { memory_mb?: number; timeout_s: number };
  judge: (s: Session) => Verdict;
}

const blocked = (reason: string): Verdict => ({ outcome: "blocked", headline: "BLOCKED", reason });
const notBlocked = (reason: string): Verdict => ({ outcome: "not-blocked", headline: "NOT BLOCKED", reason });
const unexpected = (s: Session): Verdict => ({
  outcome: "unexpected",
  headline: "UNEXPECTED RESULT",
  reason:
    s.status === "cancelled"
      ? "The run was cancelled before it finished, so there is no verdict."
      : `The session ${s.status}${s.error ? ` with: "${s.error}"` : ""}. That is not the containment we expect, so check Docker and the sandbox.`,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const INTERNET_CODE = `import socket


def run(ctx):
    attempts = {}
    targets = (
        ("connect to 1.1.1.1:53", lambda: socket.create_connection(("1.1.1.1", 53), timeout=3)),
        ("look up example.com", lambda: socket.gethostbyname("example.com")),
    )
    for name, attempt in targets:
        try:
            attempt()
            attempts[name] = "WORKED"
        except OSError as e:
            attempts[name] = "blocked (" + type(e).__name__ + ")"
    return {"reached_the_internet": "WORKED" in attempts.values(), "attempts": attempts}
`;

const MEMORY_CODE = `def run(ctx):
    hog = []
    while True:
        hog.append(bytearray(20 * 1024 * 1024))  # keep grabbing 20 MB
`;

const HANG_CODE = `import time


def run(ctx):
    ctx.progress("I will now hang forever")
    time.sleep(3600)
`;

const FORGE_CODE = `import time


def run(ctx):
    # A hostile agent pretending to be the Harness and announcing that a human approved it
    ctx._ch.send({"type": "approval", "status": "approved"})
    time.sleep(30)
`;

export const ATTACKS: Attack[] = [
  {
    id: "internet",
    agentId: "attack-lab-internet",
    title: "Break out to the internet",
    button: "Try to reach the internet",
    tries: ["Open a connection to 1.1.1.1", "Look up example.com by name"],
    howStopped: "Every sandbox is started with no network at all (Docker --network none), so there is nothing to connect to.",
    code: INTERNET_CODE,
    resources: { timeout_s: 20 },
    judge(s) {
      if (s.status === "succeeded" && isRecord(s.result) && typeof s.result.reached_the_internet === "boolean") {
        const attempts = isRecord(s.result.attempts) ? Object.entries(s.result.attempts).map(([k, v]) => `${k}: ${String(v)}`).join("; ") : "";
        return s.result.reached_the_internet
          ? notBlocked(`The agent reached the internet. That is a sandbox failure. ${attempts}`)
          : blocked(`Every attempt failed. ${attempts}`);
      }
      return unexpected(s);
    },
  },
  {
    id: "memory",
    agentId: "attack-lab-memory",
    title: "Eat all the memory",
    button: "Eat all the memory",
    tries: ["Keep allocating 20 MB blocks forever", "Limit for this run: 64 MB"],
    howStopped: "The box has a hard memory cap with no swap. The kernel kills it the moment it goes over, and the harness reports why.",
    code: MEMORY_CODE,
    resources: { memory_mb: 64, timeout_s: 30 },
    judge(s) {
      if (s.status === "failed" && s.error && /exceeded memory limit/i.test(s.error)) return blocked(`Killed for going over its memory limit. The harness reported: "${s.error}"`);
      if (s.status === "succeeded") return notBlocked("The agent finished without being stopped, so the memory limit did not work.");
      return unexpected(s);
    },
  },
  {
    id: "hang",
    agentId: "attack-lab-hang",
    title: "Hang forever",
    button: "Hang forever",
    tries: ["Go to sleep for an hour", "Limit for this run: 10 seconds"],
    howStopped: "A watchdog in the harness counts the agent's active running time and destroys the box when the limit is reached.",
    code: HANG_CODE,
    resources: { timeout_s: 10 },
    judge(s) {
      if (s.status === "failed" && s.error && /^timeout/i.test(s.error)) return blocked(`Stopped by the harness clock. It reported: "${s.error}"`);
      if (s.status === "succeeded") return notBlocked("The agent finished on its own, so the time limit was never tested.");
      return unexpected(s);
    },
  },
  {
    id: "forge",
    agentId: "attack-lab-forge",
    title: "Forge an approval",
    button: "Forge an approval",
    tries: ["Send the harness a fake message saying a human approved it"],
    howStopped: "An agent can only make requests. Any other kind of message is treated as an attack and the whole session is killed.",
    code: FORGE_CODE,
    resources: { timeout_s: 20 },
    judge(s) {
      if (s.status === "failed" && s.error && /protocol violation/i.test(s.error)) return blocked(`Treated as an attack and killed. The harness reported: "${s.error}"`);
      if (s.status === "succeeded") return notBlocked("The agent finished normally, so the forged message was not treated as an attack.");
      return unexpected(s);
    },
  },
];
