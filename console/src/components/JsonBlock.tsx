import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { pretty } from "@/lib/format";

type Attrs = Omit<HTMLAttributes<HTMLElement>, "children"> & { "data-testid"?: string };

export function JsonBlock({ value, className, ...rest }: { value: unknown; className?: string } & Attrs) {
  return (
    <pre {...rest} className={cn("max-h-72 overflow-auto rounded-md border bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-100", className)}>
      {typeof value === "string" ? value : pretty(value)}
    </pre>
  );
}

export function Mono({ children, className, ...rest }: { children: ReactNode; className?: string } & Attrs) {
  return (
    <span {...rest} className={cn("font-mono text-[12px]", className)}>
      {children}
    </span>
  );
}
