import type { Card, User } from "./types";

export interface CardTypeOption {
  value: string;
  label: string;
}

export const CARD_TYPES: CardTypeOption[] = [
  { value: "month", label: "月卡" },
  { value: "half_year", label: "半年卡" },
  { value: "year", label: "年卡" },
];

export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "unused", label: "未使用" },
  { value: "active", label: "已激活" },
  { value: "disabled", label: "已禁用" },
];

export function formatDate(value?: string | null): string {
  if (!value) return "激活后计算";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function toDateInput(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function defaultExpireInput(): string {
  const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function toIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("到期时间格式不正确");
  }
  return date.toISOString();
}

export function cardTypeLabel(type: string): string {
  const found = CARD_TYPES.find((item) => item.value === type);
  return found ? found.label : type || "未知";
}

export function statusLabel(status: string): string {
  switch (status) {
    case "unused":
      return "未使用";
    case "active":
      return "已激活";
    case "disabled":
      return "已禁用";
    default:
      return status || "未知";
  }
}

export function statusTone(status: string): "default" | "accent" | "success" | "warning" | "danger" {
  switch (status) {
    case "active":
      return "success";
    case "unused":
      return "accent";
    case "disabled":
      return "danger";
    default:
      return "default";
  }
}

export function roleLabel(role: string): string {
  return role === "admin" ? "管理员" : "普通用户";
}

export function isAdmin(user: User | null | undefined): boolean {
  return user?.role === "admin";
}

export function isDisabled(value: boolean | number | undefined | null): boolean {
  return value === true || value === 1;
}

export function cardCode(id: number): string {
  return `CARD-${String(id).padStart(5, "0")}`;
}

/** 有明文优先显示明文；旧数据只有摘要，回退到内部编号。 */
export function cardSerial(card: Card): string {
  return card.card_code?.trim() || cardCode(card.id);
}

/** 旧数据库生成的卡密无法找回原文，只能提示重新生成。 */
export function hasCardSerial(card: Card): boolean {
  return Boolean(card.card_code?.trim());
}

export function cardBand(type: string): string {
  switch (type) {
    case "month":
      return "band-month";
    case "half_year":
      return "band-half";
    case "year":
      return "band-year";
    default:
      return "";
  }
}

export function deviceLabel(value?: string | null): string {
  if (!value) return "未绑定";
  return value.length > 18 ? `${value.slice(0, 18)}…` : value;
}

export function matchesCard(card: Card, keyword: string): boolean {
  if (!keyword) return true;
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    String(card.id),
    card.card_code,
    card.device_uuid,
    card.note,
    card.card_type,
    card.app_id,
    card.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}
