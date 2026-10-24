import { useEffect, useState } from "react";
import { ChevronDown, LogOut, Moon, Sun, UserRound } from "lucide-react";

import {
  Button,
  Description,
  Dropdown,
  Label,
  Separator,
} from "@heroui/react";

import { formatDateTime, isAdmin, roleLabel } from "@/lib/format";
import type { User } from "@/lib/api";

import type { ViewKey } from "./AppShell";
import { VIEW_TITLES } from "./nav-items";

interface TopbarProps {
  user: User;
  view: ViewKey;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onLogout: () => Promise<void> | void;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="mono hidden text-[11px] tabular-nums text-[var(--muted)] sm:inline">
      {formatDateTime(now.toISOString())}
    </span>
  );
}

export function Topbar({ user, view, theme, onToggleTheme, onLogout }: TopbarProps) {
  const admin = isAdmin(user);

  return (
    <header className="glass glass-hairline sticky top-3 z-30 flex items-center gap-3 rounded-[1.25rem] px-3 py-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-[0.7rem] bg-[var(--accent)] text-[var(--accent-foreground)] lg:hidden">
        <UserRound className="size-4" />
      </span>

      <nav className="flex min-w-0 flex-1 items-center gap-2 text-[12px] text-[var(--muted)]">
        <span className="hidden truncate sm:inline">卡密控制台</span>
        <span className="hidden text-[var(--separator)] sm:inline">/</span>
        <span className="truncate text-[13px] font-semibold text-[var(--foreground)]">
          {VIEW_TITLES[view]}
        </span>
      </nav>

      <Clock />

      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
        onPress={onToggleTheme}
      >
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>

      <Dropdown>
        <Dropdown.Trigger>
          <Button variant="ghost" size="sm" className="gap-1.5 px-2">
            <UserRound className="size-3.5" />
            <span className="hidden max-w-[8rem] truncate text-[12.5px] font-medium sm:inline">
              {user.username}
            </span>
            <ChevronDown className="size-3.5" />
          </Button>
        </Dropdown.Trigger>
        <Dropdown.Popover>
          <Dropdown.Menu
            aria-label="账户菜单"
            onAction={(key) => {
              if (key === "logout") void onLogout();
            }}
          >
            <Dropdown.Item id="identity" textValue={user.username} isDisabled>
              <span className="flex flex-col">
                <Label>{user.username}</Label>
                <Description>
                  {roleLabel(user.role)}
                  {admin ? " · 全部权限" : " · 只读部分功能"}
                </Description>
              </span>
            </Dropdown.Item>
            <Separator />
            <Dropdown.Item id="logout" textValue="退出登录" variant="danger">
              <LogOut className="size-4" />
              <Label>退出登录</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </header>
  );
}

export default Topbar;
