import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
import {
  describeApproval, notifyApproval, playDing, readAlertsPref, requestNotifyPermission, titleWithPending, unlockAudio, unseen,
  writeAlertsPref,
} from "@/lib/alerts";
import type { Approval } from "@/lib/types";
import { cn } from "@/lib/utils";

const BASE_TITLE = "BYOA Harness · Operator Console";

/**
 * When a NEW approval appears (not the ones already waiting at page load): show a toast always, and if the operator
 * turned alerts on, play a ding and show a desktop notification. The tab title also shows the waiting count, so a
 * frozen agent is noticeable even from another tab.
 */
export function useApprovalAlerts({ pending, active }: { pending: Approval[] | undefined; active: boolean }) {
  const navigate = useNavigate();
  const [enabled, setEnabled] = useState(readAlertsPref);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const seen = useRef<Set<string> | null>(null); // null until the first list arrives, so existing approvals stay silent

  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => window.removeEventListener("pointerdown", unlockAudio);
  }, []);

  useEffect(() => {
    if (!active || !pending) return;
    if (seen.current === null) {
      seen.current = new Set(pending.map((a) => a.id));
      return;
    }
    const fresh = unseen(seen.current, pending);
    for (const a of pending) seen.current.add(a.id);
    if (fresh.length === 0) return;
    const review = (id: string) => navigate(`/approvals?selected=${id}`);
    for (const a of fresh) {
      toast.warning("Approval needed", {
        description: describeApproval(a),
        duration: 20_000,
        action: { label: "Review", onClick: () => review(a.id) },
      });
    }
    if (enabledRef.current) {
      playDing();
      for (const a of fresh.slice(0, 3)) notifyApproval(a, () => review(a.id));
    }
  }, [pending, active, navigate]);

  const count = active ? (pending?.length ?? 0) : 0;
  useEffect(() => {
    document.title = titleWithPending(BASE_TITLE, count);
    return () => {
      document.title = BASE_TITLE;
    };
  }, [count]);

  const toggle = useCallback(async () => {
    if (enabled) {
      setEnabled(false);
      writeAlertsPref(false);
      return;
    }
    const permission = await requestNotifyPermission();
    playDing(); // proves it works, and this click unlocks audio for later
    setEnabled(true);
    writeAlertsPref(true);
    toast.success("Approval alerts are on", {
      description:
        permission === "granted"
          ? "You will hear a ding and get a desktop notification when an approval arrives."
          : "You will hear a ding. Desktop notifications are not allowed in this browser.",
    });
  }, [enabled]);

  return { enabled, toggle };
}

export function AlertsButton({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const Icon = enabled ? Bell : BellOff;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      data-testid="alerts-toggle"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs transition-colors hover:bg-slate-800",
        enabled ? "text-amber-300" : "text-slate-400",
      )}
    >
      <Icon className="size-4" />
      {enabled ? "Approval alerts on" : "Approval alerts off — click to enable"}
    </button>
  );
}
