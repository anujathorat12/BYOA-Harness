import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { PolicyValidation } from "@/lib/types";

export type Validation =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "valid"; result: PolicyValidation }
  | { state: "invalid"; message: string }
  | { state: "unavailable"; message: string };

/**
 * Validates a policy document against the BACKEND (`POST /v1/policies/validate`) as the operator types.
 * There is deliberately no client-side YAML/policy linter: the server's loader is the only definition of "valid",
 * so what the editor says is exactly what saving would do.
 */
export function useLiveValidation(document: string, delayMs = 400): Validation {
  const [v, setV] = useState<Validation>({ state: "idle" });

  useEffect(() => {
    if (!document.trim()) {
      setV({ state: "idle" });
      return;
    }
    setV({ state: "checking" });
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api
        .validatePolicy(document, ctrl.signal)
        .then((result) => setV({ state: "valid", result }))
        .catch((e) => {
          if (ctrl.signal.aborted) return;
          if (e instanceof ApiError && e.status === 422) setV({ state: "invalid", message: e.message });
          else setV({ state: "unavailable", message: e instanceof Error ? e.message : String(e) });
        });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [document, delayMs]);

  return v;
}
