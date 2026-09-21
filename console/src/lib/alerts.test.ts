import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeApproval, notifyApproval, playDing, readAlertsPref, titleWithPending, unseen, writeAlertsPref } from "./alerts";
import type { Approval } from "./types";

const approval = (id: string, over: Partial<Approval> = {}): Approval =>
  ({ id, agent_id: "it-ops-agent", submitted_by: "alice", action: { type: "production.modify", resource: "api", params: {}, cost: { tokens: 0, amount: 0 } }, ...over }) as Approval;

describe("detecting new approvals", () => {
  it("returns only approvals not seen before", () => {
    const seen = new Set(["a", "b"]);
    expect(unseen(seen, [approval("a"), approval("b"), approval("c")]).map((a) => a.id)).toEqual(["c"]);
    expect(unseen(seen, [approval("a")])).toEqual([]);
    expect(unseen(new Set(), [])).toEqual([]);
  });

  it("describes who wants what in plain words", () => {
    expect(describeApproval(approval("x"))).toBe("it-ops-agent (task by alice) wants to production.modify on api");
  });

  it("puts the pending count in the tab title only when something is waiting", () => {
    expect(titleWithPending("Console", 0)).toBe("Console");
    expect(titleWithPending("Console", 2)).toBe("(2) Approval needed · Console");
  });
});

describe("preference storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to off when storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readAlertsPref()).toBe(false);
    expect(() => writeAlertsPref(true)).not.toThrow();
  });

  it("round-trips through storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    expect(readAlertsPref()).toBe(false);
    writeAlertsPref(true);
    expect(readAlertsPref()).toBe(true);
    writeAlertsPref(false);
    expect(readAlertsPref()).toBe(false);
  });
});

describe("the ding", () => {
  let started = 0;
  beforeEach(() => {
    started = 0;
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume = () => Promise.resolve();
      createOscillator() {
        return { type: "", frequency: { setValueAtTime() {} }, connect() {}, start: () => void started++, stop() {} };
      }
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("plays two notes", () => {
    expect(playDing()).toBe(true);
    expect(started).toBe(2);
  });
});

describe("desktop notification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows one when permitted, with a body describing the request", () => {
    const shown: { title: string; body: string; tag: string }[] = [];
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, opts: { body: string; tag: string }) {
        shown.push({ title, ...opts });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    expect(notifyApproval(approval("z"), () => {})).toBe(true);
    expect(shown).toEqual([{ title: "Approval needed", body: "it-ops-agent (task by alice) wants to production.modify on api", tag: "z" }]);
  });

  it("does nothing when blocked or unsupported", () => {
    vi.stubGlobal("Notification", class { static permission = "denied"; });
    expect(notifyApproval(approval("z"), () => {})).toBe(false);
    vi.stubGlobal("Notification", undefined);
    expect(notifyApproval(approval("z"), () => {})).toBe(false);
  });
});
