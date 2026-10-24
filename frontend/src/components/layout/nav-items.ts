import { CreditCard, DatabaseBackup, LayoutDashboard, Users } from "lucide-react";

import type { ViewKey } from "./AppShell";

export interface NavItem {
  key: ViewKey;
  label: string;
  hint: string;
  icon: typeof LayoutDashboard;
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "overview", label: "概览", hint: "全局指标与最近动态", icon: LayoutDashboard },
  { key: "cards", label: "卡密", hint: "生成、检索与生命周期", icon: CreditCard },
  { key: "users", label: "账户", hint: "角色与访问权限", icon: Users, adminOnly: true },
  { key: "system", label: "维护", hint: "备份、恢复与重启", icon: DatabaseBackup, adminOnly: true },
];

export const VIEW_TITLES: Record<ViewKey, string> = {
  overview: "概览",
  cards: "卡密",
  users: "账户",
  system: "维护",
};
