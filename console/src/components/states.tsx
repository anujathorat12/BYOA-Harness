import type { ReactNode } from "react";
import { Lock, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { can, requirement, type Capability } from "@/lib/roles";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorNote({ error, title = "Request failed" }: { error: unknown; title?: string }) {
  const e = error instanceof ApiError ? error : null;
  const forbidden = e?.status === 403;
  return (
    <Alert variant={forbidden ? "default" : "destructive"}>
      {forbidden ? <Lock className="size-4" /> : <TriangleAlert className="size-4" />}
      <AlertTitle>{forbidden ? "Not permitted for your role" : title}</AlertTitle>
      <AlertDescription>
        {error instanceof Error ? error.message : String(error)}
        {e?.requestId && <span className="ml-2 font-mono text-xs opacity-70">request {e.requestId}</span>}
      </AlertDescription>
    </Alert>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

/** Renders children only if the current role has the capability; otherwise says exactly what is required. */
export function Restricted({ cap, children, what }: { cap: Capability; children: ReactNode; what: string }) {
  const me = useMe();
  if (can(me.roles, cap)) return <>{children}</>;
  return (
    <Alert>
      <Lock className="size-4" />
      <AlertTitle>{what} is not available to your role</AlertTitle>
      <AlertDescription>
        You are signed in as <b>{me.name}</b> ({me.roles.join(", ")}). This screen requires: <b>{requirement(cap)}</b>. The server
        enforces this independently of the UI.
      </AlertDescription>
    </Alert>
  );
}
