import { Aurora } from "./Aurora";
import { MobileTabBar } from "./MobileTabBar";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { CardsView } from "@/components/views/CardsView";
import { DashboardView } from "@/components/views/DashboardView";
import { SystemView } from "@/components/views/SystemView";
import { UsersView } from "@/components/views/UsersView";
import type { User } from "@/lib/api";

export type ViewKey = "overview" | "cards" | "users" | "system";

export interface AppShellProps {
  user: User;
  view: ViewKey;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onNavigate: (view: ViewKey) => void;
  onLogout: () => Promise<void> | void;
  onUserChange: (user: User) => void;
}

export function AppShell({
  user,
  view,
  theme,
  onToggleTheme,
  onNavigate,
  onLogout,
}: AppShellProps) {
  return (
    <div className="relative min-h-dvh">
      <Aurora />

      <div className="mx-auto flex w-full max-w-[92rem] gap-5 px-3 pt-3 pb-28 sm:px-5 lg:px-7 lg:pb-7">
        <Sidebar
          user={user}
          view={view}
          onNavigate={onNavigate}
          onLogout={onLogout}
          className="sticky top-3 hidden h-[calc(100dvh-1.5rem)] lg:flex"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            user={user}
            view={view}
            theme={theme}
            onToggleTheme={onToggleTheme}
            onLogout={onLogout}
          />

          <main key={view} className="animate-rise mt-5 min-w-0 flex-1">
            {view === "overview" ? <DashboardView user={user} onNavigate={onNavigate} /> : null}
            {view === "cards" ? <CardsView user={user} /> : null}
            {view === "users" ? <UsersView user={user} /> : null}
            {view === "system" ? <SystemView /> : null}
          </main>
        </div>
      </div>

      <MobileTabBar user={user} view={view} onNavigate={onNavigate} className="lg:hidden" />
    </div>
  );
}

export default AppShell;
