import type { Approval } from "./types";

/**
 * Browser-side alerting for approvals: a synthesized two-note "ding" (no audio file needed) and a desktop notification.
 * Browsers only allow sound and notification prompts after a user gesture, which is why alerts are opt-in via a
 * button (see ApprovalAlerts.tsx) instead of being on by default.
 */
const PREF_KEY = "byoa.console.approval-alerts";

export function readAlertsPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false; // storage blocked: alerts simply start off
  }
}

export function writeAlertsPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: the choice just does not persist */
  }
}

/** Approvals in `current` that have not been seen before. */
export function unseen(seen: ReadonlySet<string>, current: readonly Approval[]): Approval[] {
  return current.filter((a) => !seen.has(a.id));
}

export function describeApproval(a: Approval): string {
  return `${a.agent_id} (task by ${a.submitted_by}) wants to ${a.action.type} on ${a.action.resource}`;
}

export function titleWithPending(base: string, pending: number): string {
  return pending > 0 ? `(${pending}) Approval needed · ${base}` : base;
}

// ---------------------------------------------------------------------------------------------------- sound
type AudioCtor = typeof AudioContext;
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const g = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Call from a click/keypress once so later dings are allowed to play. */
export function unlockAudio(): void {
  const c = audio();
  if (c && c.state === "suspended") void c.resume();
}

const NOTES: [frequencyHz: number, offsetSeconds: number][] = [
  [880, 0],
  [1318.5, 0.16],
];

/** Plays a short two-note chime. Returns false if the browser has no Web Audio. */
export function playDing(): boolean {
  const c = audio();
  if (!c) return false;
  if (c.state === "suspended") void c.resume();
  const now = c.currentTime;
  for (const [freq, offset] of NOTES) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now + offset);
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.45);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.5);
  }
  return true;
}

// ------------------------------------------------------------------------------------------- notification
export type NotifyPermission = NotificationPermission | "unsupported";

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/** Shows a desktop notification if the browser allows it. Returns whether one was shown. */
export function notifyApproval(a: Approval, onClick: () => void): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const n = new Notification("Approval needed", { body: describeApproval(a), tag: a.id });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
  return true;
}
