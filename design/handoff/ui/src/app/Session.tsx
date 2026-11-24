import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { AuthUser } from "../contract.ts";
import { provider } from "./providers.ts";
import { ProviderError } from "../../../integration/provider.ts";
interface Session {
  user: AuthUser | null;
  checking: boolean;
  expired: boolean;
  error: string | null;
  expire: () => void;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
}
const Context = createContext<Session | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setChecking(true);
    setError(null);
    void provider
      .getSession()
      .then((value) => {
        if (current) setUser(value);
      })
      .catch((e) => {
        if (current && !(e instanceof ProviderError && e.status === 401))
          setError("No se pudo contactar con el panel.");
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [revision]);
  const expire = useCallback(() => {
    setUser(null);
    setExpired(true);
  }, []);
  const login = async (username: string, password: string) => {
    const value = await provider.login(username, password);
    setUser(value);
    setExpired(false);
  };
  const logout = async () => {
    try {
      await provider.logout();
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 401))
        throw error;
    }
    setUser(null);
    setExpired(false);
  };
  return (
    <Context.Provider
      value={{
        user,
        checking,
        expired,
        error,
        expire,
        login,
        logout,
        retry: () => setRevision((v) => v + 1),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("Falta sesión");
  return value;
}
