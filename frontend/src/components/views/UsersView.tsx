import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, Power, RefreshCw, Search, ShieldAlert, UserRoundPlus } from "lucide-react";
import { toast } from "sonner";

import {
  Button,
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
import { formatDateTime, isAdmin, isDisabled, roleLabel } from "@/lib/format";
import type { User as UserRecord } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface UsersViewProps {
  user: UserRecord;
}

interface CreateForm {
  username: string;
  password: string;
  role: string;
}

const EMPTY_FORM: CreateForm = {
  username: "",
  password: "",
  role: "user",
};

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "全部角色" },
  { value: "admin", label: "管理员" },
  { value: "user", label: "普通用户" },
];

function SelfTag() {
  return (
    <span className="rounded-full bg-[var(--glass-tile)] px-2 py-0.5 text-[10px] font-normal text-[var(--muted)]">
      当前
    </span>
  );
}

export function UsersView({ user }: UsersViewProps) {
  const admin = isAdmin(user);

  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);

  const [pendingId, setPendingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.users();
      setUsers(data.users ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "账户列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return users.filter((item) => {
      if (roleFilter !== "all" && item.role !== roleFilter) return false;
      if (!needle) return true;
      return item.username.toLowerCase().includes(needle) || String(item.id).includes(needle);
    });
  }, [users, keyword, roleFilter]);

  const summary = useMemo(() => {
    const admins = users.filter((item) => item.role === "admin").length;
    const disabled = users.filter((item) => isDisabled(item.disabled)).length;
    return { total: users.length, admins, normal: users.length - admins, disabled };
  }, [users]);

  const handleCreate = async () => {
    if (creating) return;
    const username = form.username.trim();
    if (username.length < 3 || username.length > 32) {
      toast.error("用户名长度需为 3 到 32 个字符");
      return;
    }
    if (form.password.length < 8 || form.password.length > 256) {
      toast.error("密码长度需为 8 到 256 个字符");
      return;
    }
    if (form.role !== "admin" && form.role !== "user") {
      toast.error("角色不合法");
      return;
    }
    setCreating(true);
    try {
      await api.createUser({ username, password: form.password, role: form.role });
      toast.success(`用户 ${username} 已创建`);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (target: UserRecord) => {
    if (pendingId !== null) return;
    if (target.id === user.id) {
      toast.error("不能禁用当前登录账号");
      return;
    }
    setPendingId(target.id);
    try {
      await api.toggleUser(target.id);
      toast.success(`用户已${isDisabled(target.disabled) ? "启用" : "禁用"}`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "操作失败");
    } finally {
      setPendingId(null);
    }
  };

  if (!admin) {
    return (
      <div className="glass glass-hairline flex flex-col items-center rounded-[1.5rem] px-6 py-16 text-center">
        <ShieldAlert className="size-5 text-[var(--muted)]" />
        <h2 className="mt-3 text-[15px] font-semibold">无访问权限</h2>
        <p className="mt-1.5 text-[12px] text-[var(--muted)]">账户管理仅对管理员开放。</p>
      </div>
    );
  }

  const summaryItems = [
    { label: "账户总数", value: summary.total },
    { label: "管理员", value: summary.admins },
    { label: "普通用户", value: summary.normal },
    { label: "已禁用", value: summary.disabled },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">账户管理</h1>
          <p className="mono mt-1 text-[10.5px] text-[var(--muted)]">
            会话保存在服务进程内存中 · 重启后需重新登录
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onPress={() => void load()} isDisabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
          <Button size="sm" onPress={() => setCreateOpen(true)}>
            <UserRoundPlus className="size-3.5" />
            新建账户
          </Button>
        </div>
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

      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
        <div className="relative w-full lg:w-[280px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-3.5 -translate-y-1/2 text-[var(--muted)]" />
          <Input
            aria-label="搜索账户"
            className="pl-9"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索用户名 / ID"
          />
        </div>

        <Select
          aria-label="角色筛选"
          className="w-full lg:w-[150px]"
          placeholder="全部角色"
          value={roleFilter}
          onChange={(value) => setRoleFilter(String(value ?? "all"))}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {ROLE_OPTIONS.map((item) => (
                <ListBox.Item key={item.value} id={item.value} textValue={item.label}>
                  {item.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      <div className="glass glass-hairline overflow-hidden rounded-[1.5rem]">
        {error ? (
          <div className="p-4">
            <p className="rounded-xl bg-[oklch(0.62_0.2_25/0.14)] px-3.5 py-2.5 text-[12.5px] text-[var(--danger)]">
              {error}
            </p>
          </div>
        ) : loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <Inbox className="size-5 text-[var(--muted)]" />
            <p className="mt-3 text-[13px] font-medium">暂无账户</p>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              {users.length === 0 ? "还没有创建任何账户。" : "没有匹配当前筛选条件的账户。"}
            </p>
          </div>
        ) : (
          <>
            <ul className="lg:hidden">
              {filtered.map((item) => {
                const busy = pendingId === item.id;
                const self = item.id === user.id;
                const disabled = isDisabled(item.disabled);
                return (
                  <li
                    key={item.id}
                    className={cn(
                      "border-b border-[var(--separator)] px-4 py-3.5 last:border-b-0",
                      disabled && "dimmed",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="mono truncate text-[12.5px] font-semibold">
                          {item.username}
                        </span>
                        {self ? <SelfTag /> : null}
                      </span>
                      <Chip color={disabled ? "danger" : "success"} variant="soft" size="sm">
                        {disabled ? "已禁用" : "正常"}
                      </Chip>
                    </div>

                    <div className="mt-2.5 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Chip color={item.role === "admin" ? "accent" : "default"} variant="soft" size="sm">
                          {roleLabel(item.role)}
                        </Chip>
                        <span className="mono text-[10.5px] text-[var(--muted)]">
                          {formatDateTime(item.created_at)}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-3 text-[11.5px]"
                        onPress={() => void handleToggle(item)}
                        isDisabled={busy || self}
                      >
                        {busy ? <Spinner size="sm" color="current" /> : <Power className="size-3" />}
                        {disabled ? "启用" : "禁用"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="hidden lg:block">
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label="账户列表" className="min-w-[640px]">
                    <Table.Header>
                      <Table.Column isRowHeader>用户名</Table.Column>
                      <Table.Column>角色</Table.Column>
                      <Table.Column>状态</Table.Column>
                      <Table.Column>创建时间</Table.Column>
                      <Table.Column>操作</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {filtered.map((item) => {
                        const busy = pendingId === item.id;
                        const self = item.id === user.id;
                        const disabled = isDisabled(item.disabled);
                        return (
                          <Table.Row key={item.id} className={cn(disabled && "dimmed")}>
                            <Table.Cell>
                              <span className="mono flex items-center gap-2 text-[12px] font-semibold">
                                {item.username}
                                {self ? <SelfTag /> : null}
                              </span>
                            </Table.Cell>
                            <Table.Cell>
                              <Chip
                                color={item.role === "admin" ? "accent" : "default"}
                                variant="soft"
                                size="sm"
                              >
                                {roleLabel(item.role)}
                              </Chip>
                            </Table.Cell>
                            <Table.Cell>
                              <Chip color={disabled ? "danger" : "success"} variant="soft" size="sm">
                                {disabled ? "已禁用" : "正常"}
                              </Chip>
                            </Table.Cell>
                            <Table.Cell className="mono text-[11px] whitespace-nowrap tabular-nums text-[var(--muted)]">
                              {formatDateTime(item.created_at)}
                            </Table.Cell>
                            <Table.Cell>
                              <Button
                                variant="ghost"
                                size="sm"
                                isIconOnly
                                aria-label={disabled ? "启用用户" : "禁用用户"}
                                onPress={() => void handleToggle(item)}
                                isDisabled={busy || self}
                              >
                                {busy ? <Spinner size="sm" color="current" /> : <Power className="size-3.5" />}
                              </Button>
                            </Table.Cell>
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

      <p className="mono text-[10.5px] text-[var(--muted)]">
        不能禁用当前登录账号；被禁用的账户将立即失去会话。
      </p>

      <Modal>
        <Modal.Backdrop
          isOpen={createOpen}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) setForm(EMPTY_FORM);
          }}
          variant="blur"
        >
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading className="text-[15px]">新建账户</Modal.Heading>
                <Description className="text-[12px] text-[var(--muted)]">
                  用户名 3-32 字符，密码 8-256 字符，创建后即可登录。
                </Description>
              </Modal.Header>
              <Modal.Body className="space-y-4">
                <TextField>
                  <Label>用户名</Label>
                  <Input
                    autoComplete="off"
                    maxLength={32}
                    placeholder="3-32 个字符"
                    value={form.username}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, username: event.target.value }))
                    }
                  />
                </TextField>
                <TextField>
                  <Label>密码</Label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    maxLength={256}
                    placeholder="至少 8 位"
                    value={form.password}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, password: event.target.value }))
                    }
                  />
                </TextField>
                <Select
                  aria-label="角色"
                  placeholder="选择角色"
                  value={form.role}
                  onChange={(value) => setForm((prev) => ({ ...prev, role: String(value ?? "user") }))}
                >
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="user" textValue="普通用户">
                        普通用户
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="admin" textValue="管理员">
                        管理员
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="outline" onPress={() => setCreateOpen(false)} isDisabled={creating}>
                  取消
                </Button>
                <Button onPress={() => void handleCreate()} isPending={creating}>
                  {({ isPending }) => (
                    <>
                      {isPending ? (
                        <Spinner color="current" size="sm" />
                      ) : (
                        <UserRoundPlus className="size-4" />
                      )}
                      创建
                    </>
                  )}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

export default UsersView;
