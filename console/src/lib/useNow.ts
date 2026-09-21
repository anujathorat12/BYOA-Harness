import { useEffect, useState } from "react";

/** Re-renders every `ms` so countdowns and "waiting for…" timers stay live. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function countdown(toIso: string, now: number): string {
  const s = Math.round((new Date(toIso).getTime() - now) / 1000);
  if (s <= 0) return "expired";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function elapsed(fromIso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
