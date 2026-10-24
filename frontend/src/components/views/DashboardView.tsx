import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Inbox, RefreshCw } from "lucide-react";

import { Button, Card, Chip, Skeleton } from "@heroui/react";

import type { ViewKey } from "@/components/layout/AppShell";
import { api, ApiError } from "@/lib/api";
import {
  cardBand,
  cardCode,
  cardTypeLabel,
  formatDate,
  formatDateTime,
  isAdmin,
  statusLabel,
  statusTone,
} from "@/lib/format";
import type { Card as CardRecord, Stats, User } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface DashboardViewProps {
  user: User;
  onNavigate: (view: ViewKey) => void;
}

const EMPTY_STATS: Stats = { cards: 0, active: 0, unused: 0, users: 0 };

const STATUS_BAR: Record<string, string> = {
  active: "bg-[oklch(0.66_0.16_152)]",
  unused: "bg-[oklch(0.62_0.19_254)]",
  disabled: "bg-[oklch(0.62_0.2_25)]",
};

export function DashboardView({ user, onNavigate }: DashboardViewProps) {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const admin = isAdmin(user);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [dashboard, cardList] = await Promise.all([api.dashboard(), api.cards()]);
      setStats(dashboard.stats ?? EMPTY_STATS);
      setCards(cardList.cards ?? []);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "数据加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const metricItems = useMemo(
    () =>
      [
        { key: "cards", label: "卡密总数", value: stats.cards, adminOnly: false },
        { key: "active", label: "已激活", value: stats.active, adminOnly: false },
        { key: "unused", label: "未使用", value: stats.unused, adminOnly: false },
        {
          key: "disabled",
          label: "已禁用",
          value: Math.max(stats.cards - stats.active - stats.unused, 0),
          adminOnly: false,
        },
        { key: "users", label: "账户", value: stats.users, adminOnly: true },
      ].filter((item) => !item.adminOnly || admin),
    [stats, admin],
  );

  const statusBreakdown = useMemo(() => {
    const total = cards.length;
    const count = (status: string) => cards.filter((item) => item.status === status).length;
    const rows = [
      { status: "active", label: "已激活", value: count("active") },
      { status: "unused", label: "未使用", value: count("unused") },
      { status: "disabled", label: "已禁用", value: count("disabled") },
    ];
    return rows.map((row) => ({
      ...row,
      percent: total > 0 ? Math.round((row.value / total) * 100) : 0,
    }));
  }, [cards]);

  const recentCards = useMemo(() => {
    return [...cards]
      .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
      .slice(0, 6);
  }, [cards]);

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">概览</h1>
          <p className="mono mt-1 text-[10.5px] text-[var(--muted)]">
            LocalCardService/2.0 · 127.0.0.1:8080 · 会话 12h
          </p>
        </div>
        <div className="flex items-center gap-2">
          <p className="mr-1 hidden text-[12px] text-[var(--muted)] sm:block">
            {admin ? "管理员 · 可生成与调整卡密" : "只读账户 · 可查看卡密状态"}
          </p>
          <Button variant="outline" size="sm" onPress={() => void load()} isDisabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
        </div>
      </header>

      {error ? (
        <div className="glass glass-hairline rounded-2xl px-4 py-3 text-[12.5px] text-[var(--danger)]">
          {error}
        </div>
      ) : null}

      <section className="glass glass-hairline grid grid-cols-2 gap-px overflow-hidden rounded-[1.5rem] sm:grid-cols-3 lg:grid-cols-5">
        {metricItems.map((item) => (
          <div key={item.key} className="px-5 py-4">
            <p className="text-[10.5px] font-medium tracking-[0.16em] text-[var(--muted)] uppercase">
              {item.label}
            </p>
            <p className="mono mt-2 text-[26px] leading-none font-semibold tabular-nums">
              {loading ? "—" : item.value}
            </p>
          </div>
        ))}
      </section>

      <section className="grid gap-5 lg:grid-cols-[minmax(280px,1fr)_1.9fr]">
        <Card className="glass glass-hairline rounded-[1.5rem]">
          <Card.Header>
            <Card.Title className="text-[15px]">状态分布</Card.Title>
            <Card.Description>全部 {cards.length} 张卡密的票据状态</Card.Description>
          </Card.Header>
          <Card.Content className="space-y-5">
            {loading ? (
              Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full rounded-xl" />
              ))
            ) : (
              statusBreakdown.map((row) => (
                <div key={row.status} className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <Chip color={statusTone(row.status)} variant="soft" size="sm">
                      {row.label}
                    </Chip>
                    <span className="mono text-[15px] font-semibold tabular-nums">{row.value}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-tile)]">
                    <div
                      className={cn("h-full rounded-full transition-[width] duration-500", STATUS_BAR[row.status])}
                      style={{ width: `${row.percent}%` }}
                    />
                  </div>
                  <p className="mono text-[10px] text-[var(--muted)]">{row.percent}%</p>
                </div>
              ))
            )}
          </Card.Content>
        </Card>

        <Card className="glass glass-hairline rounded-[1.5rem]">
          <Card.Header className="flex flex-row items-start justify-between gap-3">
            <div>
              <Card.Title className="text-[15px]">最近卡密</Card.Title>
              <Card.Description>最新创建的 6 条记录</Card.Description>
            </div>
            <Button variant="ghost" size="sm" onPress={() => onNavigate("cards")}>
              全部
              <ArrowRight className="size-3.5" />
            </Button>
          </Card.Header>
          <Card.Content>
            {loading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full rounded-xl" />
              ))
            ) : recentCards.length === 0 ? (
              <div className="glass-hairline flex flex-col items-center rounded-2xl bg-[var(--glass-tile)] px-4 py-12 text-center">
                <Inbox className="size-5 text-[var(--muted)]" />
                <p className="mt-3 text-[13px] font-medium">暂无卡密记录</p>
                {admin ? (
                  <Button size="sm" variant="outline" className="mt-4" onPress={() => onNavigate("cards")}>
                    去生成
                  </Button>
                ) : null}
              </div>
            ) : (
              <ul className="flex flex-col">
                {recentCards.map((card, index) => (
                  <li
                    key={card.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-xl px-2 py-2.5",
                      index !== recentCards.length - 1 && "border-b border-[var(--separator)]",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="mono truncate text-[12px] font-semibold text-[var(--accent)]">
                        {cardCode(card.id)}
                      </p>
                      <p className="mt-1 flex items-center gap-2 truncate text-[10.5px] text-[var(--muted)]">
                        <span className={cn("tick shrink-0", cardBand(card.card_type))} aria-hidden />
                        <span className="truncate">
                          {cardTypeLabel(card.card_type)} · {formatDate(card.expire_time)}
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Chip color={statusTone(card.status)} variant="soft" size="sm">
                        {statusLabel(card.status)}
                      </Chip>
                      <span className="mono hidden text-[10.5px] tabular-nums text-[var(--muted)] sm:inline">
                        {formatDateTime(card.created_at)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card.Content>
        </Card>
      </section>

      {admin ? (
        <section className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onNavigate("users")}
            className="glass glass-hairline group rounded-[1.5rem] p-5 text-left transition-transform hover:-translate-y-0.5"
          >
            <h3 className="text-[14px] font-semibold">账户管理</h3>
            <p className="mt-1 text-[12px] text-[var(--muted)]">创建账户、启用或禁用访问权限</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent)]">
              进入账户管理
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate("cards")}
            className="glass glass-hairline group rounded-[1.5rem] p-5 text-left transition-transform hover:-translate-y-0.5"
          >
            <h3 className="text-[14px] font-semibold">卡密运营</h3>
            <p className="mt-1 text-[12px] text-[var(--muted)]">批量生成卡密并跟踪激活状态</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent)]">
              生成卡密
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
        </section>
      ) : null}
    </div>
  );
}

export default DashboardView;
