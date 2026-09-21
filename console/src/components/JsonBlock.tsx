import { cn } from "@/lib/utils";
import { pretty } from "@/lib/format";

export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("max-h-72 overflow-auto rounded-md border bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-100", className)}>
      {typeof value === "string" ? value : pretty(value)}
    </pre>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[12px]", className)}>{children}</span>;
}
