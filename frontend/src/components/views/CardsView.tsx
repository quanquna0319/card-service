import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Inbox,
  KeyRound,
  Pencil,
  Power,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  Button,
  Card,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Skeleton,
  Spinner,
  Table,
  TextField,
} from "@heroui/react";

import { api, ApiError } from "@/lib/api";
import {
  CARD_TYPES,
  STATUS_OPTIONS,
  cardBand,
  cardSerial,
  cardTypeLabel,
  defaultExpireInput,
  deviceLabel,
  formatDate,
  formatDateTime,
  hasCardSerial,
  isAdmin,
  matchesCard,
  statusLabel,
  statusTone,
  toDateInput,
  toIso,
} from "@/lib/format";
import type { Card as CardRecord, User } from "@/lib/types";
import { cn, copyText } from "@/lib/utils";

export interface CardsViewProps {
  user: User;
}

interface GenerateForm {
  count: number;
  card_type: string;
  expire_time: string;
  note: string;
  app_id: string;
}

interface EditForm {
  expire_time: string;
  note: string;
}

const EMPTY_FORM: GenerateForm = {
  count: 10,
  card_type: CARD_TYPES[0]?.value ?? "month",
  expire_time: defaultExpireInput(),
  note: "",
  app_id: "",
};

const STATUS_DOT: Record<string, string> = {
  active: "bg-[oklch(0.66_0.16_152)]",
  unused: "bg-[oklch(0.62_0.19_254)]",
  disabled: "bg-[oklch(0.62_0.2_25)]",
};

export function CardsView({ user }: CardsViewProps) {
  const admin = isAdmin(user);

  const [cards, setCards] = useState<CardRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("all");

  const [generateOpen, setGenerateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [form, setForm] = useState<GenerateForm>(EMPTY_FORM);
  const [resultCodes, setResultCodes] = useState<string[]>([]);
  const [resultOpen, setResultOpen] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  const [editing, setEditing] = useState<CardRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>({ expire_time: "", note: "" });

  const [pendingId, setPendingId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [deleteTargets, setDeleteTargets] = useState<CardRecord[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.cards();
      setCards(data.cards ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "卡密列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // 列表刷新后剔除已经被删除的选择，避免批量操作点到不存在的卡。
    setSelected((prev) => prev.filter((id) => cards.some((card) => card.id === id)));
  }, [cards]);

  useEffect(() => {
    // 切换筛选条件时清空勾选，避免误删当前看不见的卡密。
    setSelected([]);
  }, [keyword, status]);

  const filtered = useMemo(() => {
    return cards.filter((card) => {
      if (status !== "all" && card.status !== status) return false;
      return matchesCard(card, keyword);
    });
  }, [cards, keyword, status]);

  const summary = useMemo(() => {
    const active = cards.filter((card) => card.status === "active").length;
    const unused = cards.filter((card) => card.status === "unused").length;
    const disabled = cards.filter((card) => card.status === "disabled").length;
    return { total: cards.length, active, unused, disabled };
  }, [cards]);

  const legacyCount = useMemo(
    () => cards.filter((card) => !hasCardSerial(card)).length,
    [cards],
  );

  const openEdit = (card: CardRecord) => {
    setEditing(card);
    setEditForm({ expire_time: toDateInput(card.expire_time), note: card.note ?? "" });
  };

  const handleCopy = async (text: string, label = "卡密") => {
    const ok = await copyText(text);
    if (ok) {
      toast.success(`${label}已复制`);
    } else {
      toast.error("复制失败，请长按卡密手动选择复制");
    }
  };

  const handleGenerate = async () => {
    if (generating) return;
    let expire: string;
    try {
      expire = toIso(form.expire_time);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "到期时间格式不正确");
      return;
    }
    setGenerating(true);
    try {
      const result = await api.generateCards({
        count: form.count,
        card_type: form.card_type,
        expire_time: expire,
        note: form.note.trim() || undefined,
        app_id: form.app_id.trim() || undefined,
      });
      const codes = result.cards ?? [];
      setResultCodes(codes);
      setGenerateOpen(false);
      setForm((prev) => ({ ...EMPTY_FORM, card_type: prev.card_type }));
      await load();
      if (codes.length) {
        setCopiedAll(false);
        setResultOpen(true);
        toast.success(`已生成 ${codes.length} 张卡密`);
      } else {
        toast.success("卡密生成完成");
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editing || saving) return;
    const payload: { id: number; expire_time?: string; note?: string } = { id: editing.id };
    const trimmed = editForm.note.trim();
    try {
      if (editForm.expire_time) {
        payload.expire_time = toIso(editForm.expire_time);
      }
      payload.note = trimmed;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "到期时间格式不正确");
      return;
    }
    setSaving(true);
    try {
      await api.updateCard(payload);
      toast.success("卡密已更新");
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (card: CardRecord) => {
    if (pendingId !== null) return;
    setPendingId(card.id);
    try {
      const result = await api.toggleCard(card.id);
      toast.success(`卡密已${result.status === "disabled" ? "禁用" : "启用"}`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "操作失败");
    } finally {
      setPendingId(null);
    }
  };

  const toggleSelect = (id: number, checked: boolean) => {
    setSelected((prev) =>
      checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((item) => item !== id),
    );
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelected(checked ? filtered.map((card) => card.id) : []);
  };

  const openDelete = (targets: CardRecord[]) => {
    if (!targets.length) return;
    setDeleteTargets(targets);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (deleting || deleteTargets.length === 0) return;
    setDeleting(true);
    try {
      const result = await api.deleteCards(deleteTargets.map((card) => card.id));
      const suffix = result.missing ? `，${result.missing} 张已不存在` : "";
      toast.success(`已删除 ${result.deleted} 张卡密${suffix}`);
      setDeleteOpen(false);
      setDeleteTargets([]);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const summaryItems = [
    { label: "卡密总数", value: summary.total },
    { label: "已激活", value: summary.active },
    { label: "未使用", value: summary.unused },
    { label: "已禁用", value: summary.disabled },
  ];

  const selectedCards = useMemo(
    () => cards.filter((card) => selected.includes(card.id)),
    [cards, selected],
  );
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((card) => selected.includes(card.id));

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">卡密管理</h1>
          <p className="mono mt-1 text-[10.5px] text-[var(--muted)]">
            /api/verify_card.php · 会话 12h · 首次验证绑定设备
          </p>
        </div>
        <p className="mono text-[11px] text-[var(--muted)]">
          共 {filtered.length} 张
          {filtered.length !== cards.length ? ` / ${cards.length}` : ""}
        </p>
      </header>

      <section className="glass glass-hairline grid grid-cols-2 gap-px overflow-hidden rounded-[1.5rem] sm:grid-cols-4">
        {summaryItems.map((item) => (
          <div key={item.label} className="px-5 py-4">
            <p className="text-[10.5px] font-medium tracking-[0.16em] text-[var(--muted)] uppercase">
              {item.label}
            </p>
            <p className="mono mt-2 text-[26px] leading-none font-semibold tabular-nums">
              {item.value}
            </p>
          </div>
        ))}
      </section>

      {admin && legacyCount > 0 ? (
        <div className="glass glass-hairline rounded-2xl px-4 py-3 text-[12px] text-[var(--muted)]">
          有 <span className="font-semibold text-[var(--foreground)]">{legacyCount}</span>{" "}
          张卡密当前无法回显明文。旧版本数据库只保存过摘要，无法还原；需要明文时请重新生成，并停用这些旧卡。
        </div>
      ) : null}

      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
        <div className="relative w-full lg:w-[300px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-3.5 -translate-y-1/2 text-[var(--muted)]" />
          <Input
            aria-label="搜索卡密"
            className="pl-9"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索卡号 / 备注 / 设备"
          />
        </div>

        <Select
          aria-label="状态筛选"
          className="w-full lg:w-[150px]"
          placeholder="全部状态"
          value={status}
          onChange={(value) => setStatus(String(value ?? "all"))}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {STATUS_OPTIONS.map((item) => (
                <ListBox.Item key={item.value} id={item.value} textValue={item.label}>
                  {item.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        <div className="hidden flex-1 lg:block" />

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onPress={() => void load()} isDisabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
          {admin ? (
            <Button size="sm" onPress={() => setGenerateOpen(true)}>
              <KeyRound className="size-3.5" />
              生成卡密
            </Button>
          ) : null}
        </div>
      </div>

      {admin && selected.length > 0 ? (
        <div className="glass glass-hairline flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3">
          <p className="text-[12px]">
            已选择 <span className="font-semibold">{selected.length}</span> 张卡密
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onPress={() => setSelected([])}
              isDisabled={deleting}
            >
              取消选择
            </Button>
            <Button
              variant="danger"
              size="sm"
              onPress={() => openDelete(selectedCards)}
              isDisabled={deleting}
            >
              <Trash2 className="size-3.5" />
              删除所选
            </Button>
          </div>
        </div>
      ) : null}

      <div className="glass glass-hairline overflow-hidden rounded-[1.5rem]">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4">
            <p className="rounded-xl bg-[oklch(0.62_0.2_25/0.14)] px-3.5 py-2.5 text-[12.5px] text-[var(--danger)]">
              {error}
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <Inbox className="size-5 text-[var(--muted)]" />
            <p className="mt-3 text-[13px] font-medium">暂无卡密</p>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              {cards.length === 0 ? "还没有生成任何卡密。" : "没有符合当前筛选条件的卡密。"}
            </p>
          </div>
        ) : (
          <>
            <ul className="lg:hidden">
              {filtered.map((card) => {
                const off = card.status === "disabled";
                const busy = pendingId === card.id;
                return (
                  <li
                    key={card.id}
                    className={cn(
                      "border-b border-[var(--separator)] px-4 py-3.5 last:border-b-0",
                      off && "dimmed",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2.5">
                        {admin ? (
                          <input
                            type="checkbox"
                            className="size-4 shrink-0 accent-[var(--accent)]"
                            aria-label={`选择卡密 ${cardSerial(card)}`}
                            checked={selected.includes(card.id)}
                            onChange={(event) => toggleSelect(card.id, event.target.checked)}
                          />
                        ) : null}
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            STATUS_DOT[card.status] ?? "bg-[var(--muted)]",
                          )}
                          aria-hidden
                        />
                        {hasCardSerial(card) ? (
                          <span className="mono copyable truncate text-[12.5px] font-semibold text-[var(--accent)]">
                            {cardSerial(card)}
                          </span>
                        ) : (
                          <span className="truncate text-[11.5px] text-[var(--muted)]">
                            {admin ? "旧版卡密无法回显" : "不显示明文"}
                          </span>
                        )}
                        {hasCardSerial(card) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            isIconOnly
                            aria-label="复制卡密"
                            className="size-6 shrink-0"
                            onPress={() => void handleCopy(cardSerial(card))}
                          >
                            <Copy className="size-3" />
                          </Button>
                        ) : (
                          <span className="shrink-0 text-[10px] text-[var(--muted)]">
                            {admin ? "仅摘要" : "受限"}
                          </span>
                        )}
                      </span>
                      <Chip color={statusTone(card.status)} variant="soft" size="sm">
                        {statusLabel(card.status)}
                      </Chip>
                    </div>

                    <div className="mono mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[18px] text-[10.5px] text-[var(--muted)]">
                      <span className={cn("tick shrink-0", cardBand(card.card_type))} aria-hidden />
                      <span>{cardTypeLabel(card.card_type)}</span>
                      <span className="text-[var(--separator)]">/</span>
                      <span>{formatDate(card.expire_time)}</span>
                      {card.note ? (
                        <>
                          <span className="text-[var(--separator)]">/</span>
                          <span className="truncate">{card.note}</span>
                        </>
                      ) : null}
                    </div>

                    {admin ? (
                      <div className="mt-3 flex items-center gap-2 pl-[18px]">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-[11.5px]"
                          onPress={() => openEdit(card)}
                          isDisabled={busy}
                        >
                          <Pencil className="size-3" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-[11.5px]"
                          onPress={() => void handleToggle(card)}
                          isDisabled={busy}
                        >
                          {busy ? (
                            <Spinner size="sm" color="current" />
                          ) : (
                            <Power className="size-3" />
                          )}
                          {card.status === "disabled" ? "启用" : "禁用"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-[11.5px] text-[var(--danger)]"
                          onPress={() => openDelete([card])}
                          isDisabled={busy}
                        >
                          <Trash2 className="size-3" />
                          删除
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div className="hidden lg:block">
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label="卡密列表" className="min-w-[880px]">
                    <Table.Header>
                      {admin ? (
                        <Table.Column className="w-10">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--accent)]"
                            aria-label="选择当前筛选的全部卡密"
                            checked={allFilteredSelected}
                            ref={(node) => {
                              if (node) {
                                node.indeterminate = selected.length > 0 && !allFilteredSelected;
                              }
                            }}
                            onChange={(event) => toggleSelectAll(event.target.checked)}
                          />
                        </Table.Column>
                      ) : null}
                      <Table.Column isRowHeader>卡号</Table.Column>
                      <Table.Column>类型</Table.Column>
                      <Table.Column>状态</Table.Column>
                      <Table.Column>到期时间</Table.Column>
                      <Table.Column>绑定设备</Table.Column>
                      <Table.Column>备注</Table.Column>
                      <Table.Column>创建时间</Table.Column>
                      {admin ? <Table.Column>操作</Table.Column> : null}
                    </Table.Header>
                    <Table.Body>
                      {filtered.map((card) => {
                        const busy = pendingId === card.id;
                        const off = card.status === "disabled";
                        return (
                          <Table.Row key={card.id} className={cn(off && "dimmed")}>
                            {admin ? (
                              <Table.Cell>
                                <input
                                  type="checkbox"
                                  className="size-4 accent-[var(--accent)]"
                                  aria-label={`选择卡密 ${cardSerial(card)}`}
                                  checked={selected.includes(card.id)}
                                  onChange={(event) => toggleSelect(card.id, event.target.checked)}
                                />
                              </Table.Cell>
                            ) : null}
                            <Table.Cell>
                              <span className="mono flex items-center gap-2.5 text-[12px] font-semibold text-[var(--accent)]">
                                <span
                                  className={cn(
                                    "size-2 shrink-0 rounded-full",
                                    STATUS_DOT[card.status] ?? "bg-[var(--muted)]",
                                  )}
                                  aria-hidden
                                />
                                {hasCardSerial(card) ? (
                                  <span className="copyable">{cardSerial(card)}</span>
                                ) : (
                                  <span className="font-sans text-[11px] font-normal text-[var(--muted)]">
                                    {admin ? "旧版卡密无法回显" : "不显示明文"}
                                  </span>
                                )}
                                {hasCardSerial(card) ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    isIconOnly
                                    aria-label="复制卡密"
                                    className="size-6 shrink-0"
                                    onPress={() => void handleCopy(cardSerial(card))}
                                  >
                                    <Copy className="size-3" />
                                  </Button>
                                ) : (
                                  <span
                                    className="text-[10px] font-normal text-[var(--muted)]"
                                    title={
                                      admin
                                        ? "旧版数据库只保存了卡密摘要，无法还原明文，请重新生成"
                                        : "普通账户不显示卡密明文"
                                    }
                                  >
                                    {admin ? "仅摘要" : "受限"}
                                  </span>
                                )}
                              </span>
                            </Table.Cell>
                            <Table.Cell>
                              <span className="flex items-center gap-2 text-[12.5px]">
                                <span
                                  className={cn("tick shrink-0", cardBand(card.card_type))}
                                  aria-hidden
                                />
                                {cardTypeLabel(card.card_type)}
                              </span>
                            </Table.Cell>
                            <Table.Cell>
                              <Chip color={statusTone(card.status)} variant="soft" size="sm">
                                {statusLabel(card.status)}
                              </Chip>
                            </Table.Cell>
                            <Table.Cell className="mono text-[11px] whitespace-nowrap tabular-nums">
                              {formatDate(card.expire_time)}
                            </Table.Cell>
                            <Table.Cell className="mono max-w-[10rem] text-[11px] text-[var(--muted)]">
                              <span
                                className="block truncate"
                                title={card.device_uuid ?? undefined}
                              >
                                {deviceLabel(card.device_uuid)}
                              </span>
                            </Table.Cell>
                            <Table.Cell className="max-w-[12rem] text-[12px] text-[var(--muted)]">
                              <span className="block truncate" title={card.note ?? undefined}>
                                {card.note || "—"}
                              </span>
                            </Table.Cell>
                            <Table.Cell className="mono text-[11px] whitespace-nowrap tabular-nums text-[var(--muted)]">
                              {formatDateTime(card.created_at)}
                            </Table.Cell>
                            {admin ? (
                              <Table.Cell>
                                <div className="flex items-center gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    isIconOnly
                                    aria-label="编辑卡密"
                                    onPress={() => openEdit(card)}
                                    isDisabled={busy}
                                  >
                                    <Pencil className="size-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    isIconOnly
                                    aria-label={card.status === "disabled" ? "启用卡密" : "禁用卡密"}
                                    onPress={() => void handleToggle(card)}
                                    isDisabled={busy}
                                  >
                                    {busy ? (
                                      <Spinner size="sm" color="current" />
                                    ) : (
                                      <Power className="size-3.5" />
                                    )}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    isIconOnly
                                    aria-label="删除卡密"
                                    className="text-[var(--danger)]"
                                    onPress={() => openDelete([card])}
                                    isDisabled={busy}
                                  >
                                    <Trash2 className="size-3.5" />
                                  </Button>
                                </div>
                              </Table.Cell>
                            ) : null}
                          </Table.Row>
                        );
                      })}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </div>
          </>
        )}
      </div>

      {admin ? (
        <Modal>
          <Modal.Backdrop
            isOpen={generateOpen}
            onOpenChange={(open) => {
              setGenerateOpen(open);
              if (!open) setForm((prev) => ({ ...EMPTY_FORM, card_type: prev.card_type }));
            }}
            variant="blur"
          >
            <Modal.Container size="md">
              <Modal.Dialog>
                <Modal.Header>
                  <Modal.Heading className="text-[15px]">批量生成卡密</Modal.Heading>
                  <Description className="text-[12px] text-[var(--muted)]">
                    一次最多生成 1000 张，生成后会直接显示完整卡密，可逐张复制或复制全部。
                  </Description>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <TextField>
                      <Label>数量</Label>
                      <Input
                        type="number"
                        min={1}
                        max={1000}
                        value={String(form.count)}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, count: Number(event.target.value) }))
                        }
                      />
                    </TextField>
                    <Select
                      aria-label="卡密类型"
                      placeholder="选择类型"
                      value={form.card_type}
                      onChange={(value) =>
                        setForm((prev) => ({ ...prev, card_type: String(value ?? "month") }))
                      }
                    >
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {CARD_TYPES.map((item) => (
                            <ListBox.Item key={item.value} id={item.value} textValue={item.label}>
                              {item.label}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  </div>

                  <TextField>
                    <Label>到期时间</Label>
                    <Input
                      type="datetime-local"
                      value={form.expire_time}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, expire_time: event.target.value }))
                      }
                    />
                    <Description className="text-[11px] text-[var(--muted)]">
                      未激活卡密会按激活时间顺延，此处为兜底到期时间。
                    </Description>
                  </TextField>

                  <TextField>
                    <Label>应用 ID（可选）</Label>
                    <Input
                      placeholder="例如 app-demo"
                      value={form.app_id}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, app_id: event.target.value }))
                      }
                    />
                  </TextField>

                  <TextField>
                    <Label>备注（可选）</Label>
                    <Input
                      placeholder="最多 80 字"
                      maxLength={80}
                      value={form.note}
                      onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
                    />
                  </TextField>
                </Modal.Body>
                <Modal.Footer>
                  <Button
                    variant="outline"
                    onPress={() => setGenerateOpen(false)}
                    isDisabled={generating}
                  >
                    取消
                  </Button>
                  <Button onPress={() => void handleGenerate()} isPending={generating}>
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : <KeyRound className="size-4" />}
                        生成
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}

      {admin ? (
        <Modal>
          <Modal.Backdrop
            isOpen={resultOpen}
            onOpenChange={(open) => {
              setResultOpen(open);
              if (!open) setCopiedAll(false);
            }}
            variant="blur"
          >
            <Modal.Container size="md">
              <Modal.Dialog>
                <Modal.Header>
                  <Modal.Heading className="text-[15px]">
                    本次生成 {resultCodes.length} 张卡密
                  </Modal.Heading>
                  <Description className="text-[12px] text-[var(--muted)]">
                    卡密已保存到数据库，随时可以在列表中再次查看。手机端可长按卡密手动选择复制，或点右侧复制按钮。
                  </Description>
                </Modal.Header>
                <Modal.Body className="space-y-3">
                  <div className="glass-hairline max-h-[46vh] overflow-y-auto rounded-xl bg-[var(--glass-tile)] p-2">
                    <ul className="flex flex-col">
                      {resultCodes.map((code) => (
                        <li
                          key={code}
                          className="flex items-center justify-between gap-2 border-b border-[var(--separator)] px-2 py-2 last:border-b-0"
                        >
                          <span className="mono copyable min-w-0 flex-1 text-[12.5px] font-semibold text-[var(--accent)]">
                            {code}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 shrink-0 px-2 text-[11px]"
                            onPress={() => void handleCopy(code)}
                          >
                            <Copy className="size-3" />
                            复制
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <p className="text-[11px] text-[var(--muted)]">
                    关闭后不会再次自动弹出，列表中的卡密仍可查看与复制。
                  </p>
                </Modal.Body>
                <Modal.Footer>
                  <Button
                    variant="outline"
                    onPress={() => {
                      setResultOpen(false);
                      setCopiedAll(false);
                    }}
                  >
                    关闭
                  </Button>
                  <Button
                    onPress={() => {
                      void (async () => {
                        const ok = await copyText(resultCodes.join("\n"));
                        if (ok) {
                          setCopiedAll(true);
                          toast.success(`已复制 ${resultCodes.length} 张卡密`);
                        } else {
                          toast.error("复制失败，请长按卡密手动选择复制");
                        }
                      })();
                    }}
                  >
                    {copiedAll ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copiedAll ? "已复制" : "复制全部"}
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}

      {admin ? (
        <Modal>
          <Modal.Backdrop
            isOpen={editing !== null}
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
            variant="blur"
          >
            <Modal.Container size="sm">
              <Modal.Dialog>
                <Modal.Header>
                  <Modal.Heading className="text-[15px]">编辑卡密</Modal.Heading>
                  <Description className="mono text-[12px] text-[var(--muted)]">
                    {editing
                      ? `${hasCardSerial(editing) ? cardSerial(editing) : "旧版卡密"} · 修改到期时间或备注`
                      : ""}
                  </Description>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <TextField>
                    <Label>到期时间</Label>
                    <Input
                      type="datetime-local"
                      value={editForm.expire_time}
                      onChange={(event) =>
                        setEditForm((prev) => ({ ...prev, expire_time: event.target.value }))
                      }
                    />
                  </TextField>
                  <TextField>
                    <Label>备注</Label>
                    <Input
                      maxLength={80}
                      placeholder="最多 80 字"
                      value={editForm.note}
                      onChange={(event) =>
                        setEditForm((prev) => ({ ...prev, note: event.target.value }))
                      }
                    />
                  </TextField>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="outline" onPress={() => setEditing(null)} isDisabled={saving}>
                    取消
                  </Button>
                  <Button onPress={() => void handleSaveEdit()} isPending={saving}>
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        保存
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}

      {admin ? (
        <Modal>
          <Modal.Backdrop
            isOpen={deleteOpen}
            onOpenChange={(open) => {
              setDeleteOpen(open);
              if (!open && !deleting) setDeleteTargets([]);
            }}
            variant="blur"
          >
            <Modal.Container size="sm">
              <Modal.Dialog>
                <Modal.Header>
                  <Modal.Heading className="text-[15px]">确认删除卡密</Modal.Heading>
                  <Description className="text-[12px] text-[var(--muted)]">
                    删除后数据库记录会一并移除，无法在列表里恢复，只能通过备份恢复。
                    已激活的卡密删除后客户端会立即验证失败。
                  </Description>
                </Modal.Header>
                <Modal.Body className="space-y-3">
                  <div className="glass-hairline max-h-[34vh] overflow-y-auto rounded-xl bg-[var(--glass-tile)] p-2">
                    <ul className="flex flex-col">
                      {deleteTargets.map((card) => (
                        <li
                          key={card.id}
                          className="flex items-center justify-between gap-2 border-b border-[var(--separator)] px-2 py-2 last:border-b-0"
                        >
                          <span className="mono copyable min-w-0 flex-1 truncate text-[12px]">
                            {hasCardSerial(card) ? cardSerial(card) : `CARD-${String(card.id).padStart(5, "0")}`}
                          </span>
                          <Chip color={statusTone(card.status)} variant="soft" size="sm">
                            {statusLabel(card.status)}
                          </Chip>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <p className="text-[11.5px] text-[var(--muted)]">
                    共 {deleteTargets.length} 张。删除操作会记录在服务日志里。
                  </p>
                </Modal.Body>
                <Modal.Footer>
                  <Button
                    variant="outline"
                    onPress={() => setDeleteOpen(false)}
                    isDisabled={deleting}
                  >
                    取消
                  </Button>
                  <Button variant="danger" onPress={() => void handleDelete()} isPending={deleting}>
                    <Trash2 className="size-4" />
                    确认删除
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}

      {admin ? (
        <Card className="glass glass-hairline rounded-[1.5rem]">
          <Card.Content className="flex flex-wrap items-center justify-between gap-3 py-4">
            <p className="mono text-[10.5px] text-[var(--muted)]">
              卡密明文仅管理员可见；禁用会立即让客户端验证失败。
            </p>
            <Button variant="ghost" size="sm" onPress={() => setGenerateOpen(true)}>
              <KeyRound className="size-3.5" />
              再生成一批
            </Button>
          </Card.Content>
        </Card>
      ) : null}
    </div>
  );
}

export default CardsView;
