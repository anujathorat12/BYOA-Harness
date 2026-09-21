import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, Bug, ClipboardCheck, LayoutDashboard, LogOut, ScrollText, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertsButton, useApprovalAlerts } from "@/components/ApprovalAlerts";
import { RoleChips } from "@/components/badges";
import { api } from "@/lib/api";
import { useAuth, useMe } from "@/lib/auth";
import { can } from "@/lib/roles";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/policies", label: "Policy Studio", icon: ShieldCheck },
  { to: "/sessions", label: "Live Sessions", icon: Terminal },
  { to: "/approvals", label: "Approvals", icon: ClipboardCheck, badge: true },
  { to: "/audit", label: "Audit Log", icon: ScrollText },
  { to: "/attack-lab", label: "Attack Lab", icon: Bug },
];

export function Shell() {
  const me = useMe();
  const { logout } = useAuth();
  const canSeeApprovals = can(me.roles, "approval.read");
  const pending = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals("pending"),
    enabled: canSeeApprovals,
    refetchInterval: 3000,
  });
  const ready = useQuery({ queryKey: ["ready"], queryFn: api.readiness, refetchInterval: 10_000 });
  const pendingCount = pending.data?.length ?? 0;
  const canDecide = can(me.roles, "approval.decide");
  const alerts = useApprovalAlerts({ pending: pending.data, active: canDecide });

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col bg-slate-900 text-slate-200">
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-4">
          <Activity className="size-5 text-sky-400" />
          <div className="leading-tight">
            <div className="text-sm font-semibold text-white">BYOA Harness</div>
            <div className="text-[11px] text-slate-400">Operator Console</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/60 hover:text-white",
                )
              }
            >
              <Icon className="size-4" />
              <span className="flex-1">{label}</span>
              {badge && pendingCount > 0 && (
                <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-slate-900" data-testid="pending-badge">
                  {pendingCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-2 border-t border-slate-800 p-3 text-xs">
          <div className="flex items-center gap-2 text-slate-400">
            <span
              className={cn("size-2 rounded-full", ready.data?.status === "ready" ? "bg-emerald-400" : ready.isError || ready.data ? "bg-red-400" : "bg-slate-500")}
            />
            {ready.data?.status === "ready" ? "Harness ready" : ready.data ? "Harness degraded" : ready.isError ? "Harness unreachable" : "Checking…"}
          </div>
          {canDecide && <AlertsButton enabled={alerts.enabled} onToggle={() => void alerts.toggle()} />}
          <div>
            <div className="mb-1 font-medium text-white" data-testid="whoami-name">{me.name}</div>
            <RoleChips roles={me.roles} />
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start px-1 text-slate-300 hover:bg-slate-800 hover:text-white" onClick={logout}>
            <LogOut className="size-4" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
