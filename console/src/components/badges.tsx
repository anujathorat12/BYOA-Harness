import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ApprovalStatus, Effect, SessionStatus } from "@/lib/types";

const base = "border font-medium";

export function EffectBadge({ effect, className }: { effect: Effect | string | null | undefined; className?: string }) {
  if (!effect) return <span className="text-muted-foreground">—</span>;
  const tone =
    effect === "allow"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : effect === "deny"
        ? "bg-red-50 text-red-700 border-red-200"
        : "bg-amber-50 text-amber-800 border-amber-200";
  return (
    <Badge variant="outline" className={cn(base, tone, className)}>
      {effect}
    </Badge>
  );
}

export function StatusBadge({ status, frozen, className }: { status: SessionStatus | string; frozen?: boolean; className?: string }) {
  if (frozen) {
    return (
      <Badge variant="outline" className={cn(base, "bg-amber-100 text-amber-900 border-amber-300", className)}>
        frozen · awaiting approval
      </Badge>
    );
  }
  const tone: Record<string, string> = {
    queued: "bg-slate-100 text-slate-700 border-slate-200",
    running: "bg-sky-50 text-sky-700 border-sky-200",
    succeeded: "bg-emerald-50 text-emerald-700 border-emerald-200",
    failed: "bg-red-50 text-red-700 border-red-200",
    cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  };
  return (
    <Badge variant="outline" className={cn(base, tone[status] ?? "", className)}>
      {status}
    </Badge>
  );
}

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  const tone: Record<ApprovalStatus, string> = {
    pending: "bg-amber-50 text-amber-800 border-amber-200",
    approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    denied: "bg-red-50 text-red-700 border-red-200",
    expired: "bg-slate-100 text-slate-600 border-slate-200",
  };
  return (
    <Badge variant="outline" className={cn(base, tone[status])}>
      {status}
    </Badge>
  );
}

export function RoleChips({ roles }: { roles: readonly string[] }) {
  return (
    <span className="inline-flex gap-1">
      {roles.map((r) => (
        <Badge key={r} variant="secondary" className="bg-sky-500/15 text-sky-200 border border-sky-400/30">
          {r}
        </Badge>
      ))}
    </span>
  );
}
