import { LogOut, ShieldCheck, Sparkles } from "lucide-react";

import { Button, Chip, Separator } from "@heroui/react";

import { isAdmin, roleLabel } from "@/lib/format";
import type { User } from "@/lib/api";
import { cn } from "@/lib/utils";

import type { ViewKey } from "./AppShell";
import { NAV_ITEMS } from "./nav-items";

interface SidebarProps {
  user: User;
  view: ViewKey;
  onNavigate: (view: ViewKey) => void;
  onLogout: () => Promise<void> | void;
  className?: string;
}

export function Sidebar({ user, view, onNavigate, onLogout, className }: SidebarProps) {
  const admin = isAdmin(user);
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || admin);

  return (
    <aside
      className={cn(
        "glass glass-hairline flex w-[16.5rem] shrink-0 flex-col rounded-[1.75rem] p-3",
        className,
      )}
    >
      <div className="flex items-center gap-3 px-2 py-2.5">
        <span className="grid size-10 place-items-center rounded-2xl bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[0_10px_26px_-10px_oklch(0.62_0.19_254/0.9)]">
          <Sparkles className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold tracking-tight">卡密控制台</span>
          <span className="mono block truncate text-[10px] text-[var(--muted)]">
            LocalCardService/2.0
          </span>
        </span>
      </div>

      <Separator className="my-2 opacity-60" />

      <nav className="flex flex-col gap-1" aria-label="主导航">
        {items.map((item) => {
          const Icon = item.icon;
          const active = view === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className="nav-tile text-left"
              data-active={active}
              aria-current={active ? "page" : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <span className="nav-tile__glyph">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                <span className="block truncate text-[10.5px] font-normal text-[var(--muted)]">
                  {item.hint}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto space-y-3 pt-3">
        <div className="glass-hairline rounded-2xl bg-[var(--glass-tile)] p-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-3.5 text-[var(--accent)]" />
            <p className="mono text-[10px] tracking-wide text-[var(--muted)]">服务在线 · 会话 12h</p>
          </div>
          <p className="mt-2 truncate text-[12.5px] font-semibold">{user.username}</p>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <Chip color={admin ? "accent" : "default"} variant="soft" size="sm">
              {roleLabel(user.role)}
            </Chip>
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label="退出登录"
              onPress={() => void onLogout()}
            >
              <LogOut className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
