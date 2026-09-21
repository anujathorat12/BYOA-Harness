import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, notifyUnauthorized } from "@/lib/api";
import { streamSse } from "@/lib/sse";
import type { AuditEvent } from "@/lib/types";

export type StreamState = "connecting" | "live" | "reconnecting" | "ended" | "error";

/**
 * Live audit/progress stream of one session (SSE). Resumes from the last seen event id after a dropped
 * connection, stops when the server says the session has ended, and nudges related queries so the rest
 * of the UI (session header, approval queue, overview) reflects each change immediately.
 */
export function useSessionEvents(sessionId: string | undefined) {
  const qc = useQueryClient();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [state, setState] = useState<StreamState>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    setError(null);
    setState("connecting");
    const ctrl = new AbortController();
    let last = 0;
    let attempt = 0;
    let ended = false;

    const run = async () => {
      while (!ctrl.signal.aborted && !ended) {
        try {
          await streamSse(
            `/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${last}`,
            (frame) => {
              if (frame.event === "end") {
                ended = true;
                setState("ended");
                void qc.invalidateQueries({ queryKey: ["session", sessionId] });
                void qc.invalidateQueries({ queryKey: ["approvals"] });
                void qc.invalidateQueries({ queryKey: ["overview"] });
                return;
              }
              const ev = JSON.parse(frame.data) as AuditEvent;
              last = Math.max(last, ev.id);
              attempt = 0;
              setEvents((prev) => (prev.some((p) => p.id === ev.id) ? prev : [...prev, ev]));
              if (ev.kind.startsWith("approval.") || ev.kind.startsWith("action.") || ev.kind.startsWith("session.")) {
                void qc.invalidateQueries({ queryKey: ["session", sessionId] });
                void qc.invalidateQueries({ queryKey: ["approvals"] });
              }
            },
            ctrl.signal,
            () => setState("live"),
          );
        } catch (e) {
          if (ctrl.signal.aborted) return;
          if (e instanceof ApiError) {
            if (e.status === 401) return notifyUnauthorized();
            if (e.status === 403 || e.status === 404) {
              setError(e.message);
              return setState("error");
            }
          }
        }
        if (ended || ctrl.signal.aborted) return;
        setState("reconnecting");
        attempt += 1;
        await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** attempt)));
      }
    };
    void run();
    return () => ctrl.abort();
  }, [sessionId, qc]);

  return { events, state, error };
}
