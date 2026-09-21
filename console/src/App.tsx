import { Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Shell } from "@/components/Shell";
import { useAuth } from "@/lib/auth";
import { LoginPage } from "@/features/auth/LoginPage";
import { AgentsPage } from "@/features/agents/AgentsPage";
import { PolicyStudioPage } from "@/features/policies/PolicyStudioPage";
import { ApprovalsPage } from "@/features/approvals/ApprovalsPage";
import { SessionDetailPage } from "@/features/sessions/SessionDetailPage";
import { SessionsPage } from "@/features/sessions/SessionsPage";
import { OverviewPage } from "@/features/overview/OverviewPage";

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
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<OverviewPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="policies" element={<PolicyStudioPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="sessions/:id" element={<SessionDetailPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
