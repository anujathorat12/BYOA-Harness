import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, credentials, setUnauthorizedHandler } from "./api";
import type { Whoami } from "./types";

interface AuthState {
  status: "checking" | "anonymous" | "authenticated";
  me: Whoami | null;
  login: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>(credentials.get() ? "checking" : "anonymous");
  const [me, setMe] = useState<Whoami | null>(null);

  const logout = useCallback(() => {
    credentials.clear();
    setMe(null);
    setStatus("anonymous");
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    if (!credentials.get()) return;
    api
      .whoami()
      .then((w) => {
        setMe(w);
        setStatus("authenticated");
      })
      .catch(() => logout());
  }, [logout]);

  const login = useCallback(async (token: string) => {
    const w = await api.whoami(token); // throws ApiError(401) for a bad key: nothing is stored
    credentials.set(token);
    setMe(w);
    setStatus("authenticated");
  }, []);

  const value = useMemo(() => ({ status, me, login, logout }), [status, me, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** For pages inside the authenticated shell, where `me` is guaranteed. */
export function useMe(): Whoami {
  const { me } = useAuth();
  if (!me) throw new Error("useMe outside authenticated shell");
  return me;
}
