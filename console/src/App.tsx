import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Shell } from "@/components/Shell";
import { LoadingRows } from "@/components/states";
import { useAuth } from "@/lib/auth";
import { LoginPage } from "@/features/auth/LoginPage";
import { OverviewPage } from "@/features/overview/OverviewPage";

// Route-level code splitting: only the landing page ships in the first bundle.
const AgentsPage = lazy(() => import("@/features/agents/AgentsPage").then((m) => ({ default: m.AgentsPage })));
const PolicyStudioPage = lazy(() => import("@/features/policies/PolicyStudioPage").then((m) => ({ default: m.PolicyStudioPage })));
const SessionsPage = lazy(() => import("@/features/sessions/SessionsPage").then((m) => ({ default: m.SessionsPage })));
const SessionDetailPage = lazy(() => import("@/features/sessions/SessionDetailPage").then((m) => ({ default: m.SessionDetailPage })));
const ApprovalsPage = lazy(() => import("@/features/approvals/ApprovalsPage").then((m) => ({ default: m.ApprovalsPage })));
const AuditPage = lazy(() => import("@/features/audit/AuditPage").then((m) => ({ default: m.AuditPage })));
const AttackLabPage = lazy(() => import("@/features/attacks/AttackLabPage").then((m) => ({ default: m.AttackLabPage })));

export function App() {
  const { status } = useAuth();
  if (status === "checking") {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (status === "anonymous") return <LoginPage />;
  return (
    <Suspense fallback={<LoadingRows />}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<OverviewPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="policies" element={<PolicyStudioPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="sessions/:id" element={<SessionDetailPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="attack-lab" element={<AttackLabPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
