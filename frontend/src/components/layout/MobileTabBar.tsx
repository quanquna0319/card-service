import { isAdmin } from "@/lib/format";
import type { User } from "@/lib/api";
import { cn } from "@/lib/utils";

import type { ViewKey } from "./AppShell";
import { NAV_ITEMS } from "./nav-items";

interface MobileTabBarProps {
  user: User;
  view: ViewKey;
  onNavigate: (view: ViewKey) => void;
  className?: string;
}

export function MobileTabBar({ user, view, onNavigate, className }: MobileTabBarProps) {
  const admin = isAdmin(user);
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || admin);

  return (
    <nav
      aria-label="底部导航"
      className={cn(
        "glass glass-hairline fixed inset-x-3 z-40 flex items-stretch gap-1 rounded-[1.5rem] p-1.5",
        className,
      )}
      style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = view === item.key;
        return (
          <button
            key={item.key}
            type="button"
            className="tab-item"
            data-active={active}
            aria-current={active ? "page" : undefined}
            onClick={() => onNavigate(item.key)}
          >
            <Icon className="size-[1.15rem]" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default MobileTabBar;
