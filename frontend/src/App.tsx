import { useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";

import { Aurora } from "@/components/layout/Aurora";
import { AppShell, type ViewKey } from "@/components/layout/AppShell";
import { LoginView } from "@/components/views/LoginView";
import { Spinner } from "@heroui/react";
import { useTheme } from "@/lib/theme";
import {
  api,
  clearToken,
  getToken,
  loadUser,
  saveUser,
  setToken,
  setUnauthorizedHandler,
  type User,
} from "@/lib/api";

function readView(): ViewKey {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "cards" || hash === "users" || hash === "system") return hash;
  return "overview";
}

function BootScreen() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4">
      <Aurora />
      <div className="glass glass-hairline animate-rise flex items-center gap-3 rounded-[1.25rem] px-6 py-4">
        <Spinner size="sm" />
        <span className="text-[12.5px] text-[var(--muted)]">正在校验会话…</span>
      </div>
    </div>
  );
}

export default function App() {
  const { mode, toggle } = useTheme();
  const [user, setUser] = useState<User | null>(() => loadUser());
  const [view, setView] = useState<ViewKey>(() => readView());
  const [booting, setBooting] = useState<boolean>(() => Boolean(getToken()));

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      setUser(null);
      setBooting(false);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setBooting(false);
      return;
    }
    let alive = true;
    api
      .me()
      .then((data) => {
        if (!alive) return;
        setUser(data.user);
        saveUser(data.user);
      })
      .catch(() => {
        if (!alive) return;
        clearToken();
        setUser(null);
      })
      .finally(() => {
        if (alive) setBooting(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onHash = () => setView(readView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((next: ViewKey) => {
    setView(next);
    window.location.hash = next === "overview" ? "/" : `/${next}`;
  }, []);

  const handleLogin = useCallback((token: string, nextUser: User) => {
    setToken(token);
    saveUser(nextUser);
    setUser(nextUser);
    setBooting(false);
    window.location.hash = "/";
    setView("overview");
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* 退出失败也要清本地会话 */
    }
    clearToken();
    setUser(null);
    window.location.hash = "/";
    setView("overview");
  }, []);

  return (
    <>
      {booting ? (
        <BootScreen />
      ) : user ? (
        <AppShell
          user={user}
          view={view}
          theme={mode}
          onToggleTheme={toggle}
          onNavigate={navigate}
          onLogout={handleLogout}
          onUserChange={(next) => {
            setUser(next);
            saveUser(next);
          }}
        />
      ) : (
        <LoginView onSuccess={handleLogin} />
      )}
      <Toaster
        theme={mode}
        position="top-right"
        toastOptions={{ classNames: { toast: "font-sans" } }}
      />
    </>
  );
}
