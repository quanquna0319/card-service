import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  CloudDownload,
  Copy,
  Database,
  Download,
  FileArchive,
  FileText,
  GitBranch,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";

import {
  Button,
  Card,
  Chip,
  Description,
  Input,
  Label,
  Modal,
  TextField,
} from "@heroui/react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { SystemInfo, UpdateCheck } from "@/lib/types";
import { cn, copyText } from "@/lib/utils";

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${Math.max(minutes, 1)} 分钟`;
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(INLINE_PATTERN)
    .filter((part) => part !== "")
    .map((part, index) => {
      const key = `${keyPrefix}-${index}`;
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={key} className="font-semibold text-[var(--foreground)]">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        return (
          <code
            key={key}
            className="mono rounded bg-[var(--glass-tile)] px-1 py-0.5 text-[11px]"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      return <span key={key}>{part}</span>;
    });
}

/** CHANGELOG.md 只有标题、列表和行内强调，用轻量渲染，不引入 Markdown 依赖。 */
function renderChangelog(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const items: string[] = [];

  const pushList = (key: string) => {
    if (!items.length) return;
    nodes.push(
      <ul key={`list-${key}`} className="list-disc space-y-1 pl-5">
        {items.map((item, index) => (
          <li
            key={`${key}-${index}`}
            className="text-[12px] leading-relaxed text-[var(--muted)]"
          >
            {renderInline(item, `${key}-${index}`)}
          </li>
        ))}
      </ul>,
    );
    items.length = 0;
  };

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    const key = String(index);
    if (!line.trim()) {
      pushList(key);
      return;
    }
    if (line.startsWith("### ")) {
      pushList(key);
      nodes.push(
        <h3
          key={`h3-${key}`}
          className="pt-1 text-[12.5px] font-semibold text-[var(--foreground)]"
        >
          {renderInline(line.slice(4), key)}
        </h3>,
      );
      return;
    }
    if (line.startsWith("## ")) {
      pushList(key);
      nodes.push(
        <h2
          key={`h2-${key}`}
          className="mono pt-2 text-[12px] font-semibold tracking-wide text-[var(--accent)]"
        >
          {renderInline(line.slice(3), key)}
        </h2>,
      );
      return;
    }
    if (line.startsWith("# ")) {
      pushList(key);
      nodes.push(
        <h1
          key={`h1-${key}`}
          className="text-[14px] font-semibold text-[var(--foreground)]"
        >
          {renderInline(line.slice(2), key)}
        </h1>,
      );
      return;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      items.push(bullet[1]);
      return;
    }
    pushList(key);
    nodes.push(
      <p
        key={`p-${key}`}
        className="text-[12px] leading-relaxed text-[var(--muted)]"
      >
        {renderInline(line, key)}
      </p>,
    );
  });

  pushList("end");
  return nodes;
}

export function SystemView() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [restartAfterUpdate, setRestartAfterUpdate] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<{
    before: string;
    after: string;
    command: boolean;
    commits: string[];
    files: string[];
  } | null>(null);
  const [error, setError] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [changelogError, setChangelogError] = useState("");
  const [changelog, setChangelog] = useState<{
    text: string;
    version?: string;
    path?: string;
    updated_at?: string | null;
    available?: boolean;
    truncated?: boolean;
  } | null>(null);
  const [packageBusy, setPackageBusy] = useState("");
  const [packageToDelete, setPackageToDelete] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState("");
  const [backupToDelete, setBackupToDelete] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [checkResult, setCheckResult] = useState<UpdateCheck | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setInfo(await api.system());
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "系统信息读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const name = await api.downloadBackup();
      toast.success(`已生成并下载 ${name}`);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof ApiError ? err.message : "备份失败");
    } finally {
      setDownloading(false);
    }
  }, [load]);

  const handlePick = useCallback((file: File | null) => {
    if (!file) return;
    if (!/\.(sqlite3?|db)$/i.test(file.name)) {
      toast.error("请选择 .sqlite3 或 .db 备份文件");
      return;
    }
    setPendingFile(file);
  }, []);

  const handleRestore = useCallback(async () => {
    if (!pendingFile) return;
    setRestoring(true);
    try {
      const result = await api.restoreBackup(pendingFile);
      toast.success(`已恢复 ${result.summary.cards} 张卡密，刷新页面即可看到`);
      setPendingFile(null);
      if (fileInput.current) fileInput.current.value = "";
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof ApiError ? err.message : "恢复失败");
    } finally {
      setRestoring(false);
    }
  }, [pendingFile, load]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    setRestartOpen(false);
    try {
      await api.restart();
    } catch {
      /* 进程退出时连接中断属于正常现象 */
    }
    toast.message("服务正在重启，等待重新连接…");
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        try {
          await api.health();
          toast.success("服务已重新上线");
          await load();
          setRestarting(false);
          return;
        } catch {
          /* 继续等待 */
        }
      }
      toast.error("30 秒内未重新连上，请检查进程管理器是否自动拉起服务");
      setRestarting(false);
    };
    void poll();
  }, [load]);

  const waitForRestart = useCallback(
    async (before: { pid?: number; boot?: string } | undefined) => {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        try {
          const health = await api.health();
          const pid = (health as { pid?: number }).pid;
          const boot = (health as { boot?: string }).boot;
          // 容器里的 1 号进程重启后 PID 仍是 1，只有启动标识变化才说明真的换进程了。
          const changed = before?.boot ? boot !== before.boot : !before?.pid || pid !== before.pid;
          if (!before || changed) {
            await load();
            return true;
          }
        } catch {
          /* 进程退出期间连接会中断，继续等待 */
        }
      }
      return false;
    },
    [load],
  );

  const handleCheckUpdate = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setCheckError("");
    try {
      const result = await api.checkUpdate();
      setCheckResult(result);
      if (!result.supported) {
        toast.message("当前更新方式无法比对远端版本");
      } else if (result.updated) {
        toast.success("当前已经是最新版本");
      } else {
        toast.message("发现 " + result.behind + " 个新提交");
      }
    } catch (err: unknown) {
      const message = err instanceof ApiError ? err.message : "检查更新失败";
      setCheckError(message);
      toast.error(message);
    } finally {
      setChecking(false);
    }
  }, [checking]);

  const handleUpdate = useCallback(async () => {
    if (updating) return;
    setUpdating(true);
    setUpdateOpen(false);
    const before = { pid: info?.pid, boot: info?.boot };
    try {
      const result = await api.updateProject(restartAfterUpdate);
      if (!result.updated) {
        if (result.restart_required) {
          toast.message("新版本已下载，重启服务后生效");
          if (restartAfterUpdate) {
            const ok = await waitForRestart(before);
            if (ok) {
              toast.success("服务已重新上线");
            } else {
              toast.error("45 秒内未重新连上，请检查进程管理器是否自动拉起服务");
            }
          }
        } else {
          toast.success("当前已经是最新版本");
        }
        await load();
        return;
      }
      setLastUpdate({
        before: result.before,
        after: result.after,
        command: result.branch === "custom-command",
        commits: result.commits,
        files: result.files,
      });
      toast.success(
        result.branch === "custom-command"
          ? "更新命令执行完成"
          : `代码已更新：${result.before} → ${result.after}`,
      );
      if (restartAfterUpdate) {
        toast.message("正在重启服务并重新加载新版本…");
        const ok = await waitForRestart(before);
        if (ok) {
          toast.success("服务已重新上线");
        } else {
          toast.error("45 秒内未重新连上，请检查进程管理器是否自动拉起服务");
        }
      } else {
        toast.message("代码已更新，点击重启服务后生效");
      }
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "更新失败");
    } finally {
      setUpdating(false);
    }
  }, [info?.pid, info?.boot, load, restartAfterUpdate, updating, waitForRestart]);

  const openChangelog = useCallback(async () => {
    setChangelogOpen(true);
    setChangelogLoading(true);
    setChangelogError("");
    try {
      setChangelog(await api.changelog());
    } catch (err: unknown) {
      setChangelogError(err instanceof ApiError ? err.message : "更新日志读取失败");
    } finally {
      setChangelogLoading(false);
    }
  }, []);

  const handleDownloadPackage = useCallback(async (name: string) => {
    setPackageBusy(name);
    try {
      await api.downloadUpdatePackage(name);
      toast.success("更新包已开始下载");
    } catch (err: unknown) {
      toast.error(err instanceof ApiError ? err.message : "下载更新包失败");
    } finally {
      setPackageBusy("");
    }
  }, []);

  const handleDeleteBackup = useCallback(async () => {
    if (!backupToDelete) return;
    const target = backupToDelete;
    setBackupBusy(target);
    try {
      const result = await api.deleteBackup(target);
      toast.success(
        result.deleted.length
          ? `已删除 ${result.deleted.length} 份备份`
          : "备份不存在或已被删除",
      );
      setBackupToDelete(null);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof ApiError ? err.message : "删除备份失败");
    } finally {
      setBackupBusy("");
    }
  }, [backupToDelete, load]);

  const handleDeletePackage = useCallback(async () => {
    if (!packageToDelete) return;
    const target = packageToDelete;
    setPackageBusy(target);
    try {
      const result = await api.deleteUpdatePackage(target);
      toast.success(
        result.deleted.length
          ? `已删除 ${result.deleted.length} 个更新包`
          : "没有需要删除的更新包",
      );
      setPackageToDelete(null);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof ApiError ? err.message : "删除更新包失败");
    } finally {
      setPackageBusy("");
    }
  }, [packageToDelete, load]);

  const updateMode = info?.update_mode ?? (info?.git?.available ? "git" : "download");
  const packages = info?.update_packages ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">备份与维护</h1>
          <p className="mono mt-1 text-[10.5px] text-[var(--muted)]">
            SQLite 单文件 · 在线快照 · 原子恢复
          </p>
        </div>
        <Button variant="outline" size="sm" onPress={() => void load()} isDisabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      </header>

      {error ? (
        <div className="glass glass-hairline rounded-2xl px-4 py-3 text-[12.5px] text-[var(--danger)]">
          {error}
        </div>
      ) : null}

      <section className="grid gap-5 lg:grid-cols-2">
        <Card className="glass glass-hairline rounded-[1.5rem]">
          <Card.Header>
            <Card.Title className="flex items-center gap-2 text-[15px]">
              <Database className="size-4 text-[var(--accent)]" />
              当前数据库
            </Card.Title>
            <Card.Description className="break-all">
              {info?.db ?? "读取中…"}
            </Card.Description>
          </Card.Header>
          <Card.Content className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="glass-hairline rounded-xl bg-[var(--glass-tile)] px-3 py-2.5">
                <p className="text-[10.5px] text-[var(--muted)]">文件大小</p>
                <p className="mono mt-1 text-[14px] font-semibold">
                  {info ? formatBytes(info.db_size) : "—"}
                </p>
              </div>
              <div className="glass-hairline rounded-xl bg-[var(--glass-tile)] px-3 py-2.5">
                <p className="text-[10.5px] text-[var(--muted)]">运行时长</p>
                <p className="mono mt-1 text-[14px] font-semibold">
                  {info ? formatUptime(info.uptime) : "—"}
                </p>
              </div>
            </div>
            <div>
              <p className="text-[10.5px] text-[var(--muted)]">SHA256</p>
              <p className="mono mt-1 overflow-x-auto text-[11px] whitespace-nowrap text-[var(--muted)]">
                {info?.db_sha256 || "—"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" onPress={() => void handleDownload()} isPending={downloading}>
                {({ isPending }) => (
                  <>
                    {isPending ? null : <Download className="size-3.5" />}
                    立即备份并下载
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onPress={() => fileInput.current?.click()}
              >
                <Upload className="size-3.5" />
                选择备份文件
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".sqlite3,.sqlite,.db"
              className="hidden"
              onChange={(event) => handlePick(event.target.files?.[0] ?? null)}
            />
          </Card.Content>
        </Card>

        <Card className="glass glass-hairline rounded-[1.5rem]">
          <Card.Header>
            <Card.Title className="flex items-center gap-2 text-[15px]">
              <RotateCcw className="size-4 text-[var(--accent)]" />
              服务重启
            </Card.Title>
            <Card.Description>
              恢复备份后数据立即生效；重启会原地换成最新代码并清空会话，不依赖外部守护进程拉起。
            </Card.Description>
          </Card.Header>
          <Card.Content className="space-y-4">
            <div className="glass-hairline rounded-xl bg-[var(--glass-tile)] px-3 py-2.5">
              <p className="text-[10.5px] text-[var(--muted)]">进程 PID</p>
              <p className="mono mt-1 text-[14px] font-semibold">{info?.pid ?? "—"}</p>
            </div>
            <Button
              variant="danger"
              onPress={() => setRestartOpen(true)}
              isPending={restarting}
            >
              <RotateCcw className="size-3.5" />
              重启服务
            </Button>
            <p className="text-[11.5px] text-[var(--muted)]">
              重启在进程内完成，前台运行 <span className="mono">python server.py</span> 也能直接加载新代码，不会掉线。
            </p>
          </Card.Content>
        </Card>
      </section>

      <Card className="glass glass-hairline rounded-[1.5rem]">
        <Card.Header className="flex flex-row items-start justify-between gap-3">
          <div>
            <Card.Title className="flex items-center gap-2 text-[15px]">
              <GitBranch className="size-4 text-[var(--accent)]" />
              项目更新
            </Card.Title>
            <Card.Description className="break-all">
              {updateMode === "command"
                ? "已配置更新命令，点击按钮后在服务器执行"
                : updateMode === "download"
                  ? info?.git?.pendingRestart
                    ? `已下载 ${info?.git?.downloaded ?? "新版本"} · 重启服务后生效`
                    : `${info?.update_repo ?? "quanquna0319/card-service"} · ${
                        info?.update_branch ?? "main"
                      } · 直接从 GitHub 下载源码包`
                  : info?.git?.available
                ? `${info.git.branch} · ${info.git.short} · ${
                    info.git.dirty ? "工作区有未提交修改" : "工作区干净"
                  }`
                : "当前环境没有 Git 工作区"}
            </Card.Description>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Chip
              variant="soft"
              size="sm"
              color={
                updateMode === "git" && info?.git?.dirty
                  ? "warning"
                  : updateMode === "none"
                    ? "default"
                    : "accent"
              }
            >
              {updateMode === "command"
                ? "自定义命令"
                : updateMode === "download"
                  ? info?.git?.pendingRestart
                    ? "待重启生效"
                    : "可在线更新"
                : info?.git?.available
                  ? info.git.dirty
                    ? "有本地改动"
                    : "可更新"
                  : "不可自动更新"}
            </Chip>
            <Button
              variant="outline"
              size="sm"
              onPress={() => void openChangelog()}
            >
              <FileText className="size-3.5" />
              查看更新日志
            </Button>
          </div>
        </Card.Header>
        <Card.Content className="space-y-3">
          {updateMode !== "none" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="glass-hairline rounded-xl bg-[var(--glass-tile)] px-3 py-2.5">
                  <p className="text-[10.5px] text-[var(--muted)]">
                    {updateMode === "command"
                      ? "更新方式"
                      : updateMode === "download"
                        ? "更新来源"
                        : "当前提交"}
                  </p>
                  <p className="mono copyable mt-1 text-[12px] font-semibold">
                    {updateMode === "command"
                      ? "CARD_UPDATE_COMMAND"
                      : updateMode === "download"
                        ? info?.update_repo
                        : info?.git?.short}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[11px] text-[var(--muted)]">
                    {updateMode === "command"
                      ? "由部署环境提供的更新脚本"
                      : updateMode === "download"
                        ? `分支 ${info?.update_branch ?? "master"} · 更新后写入数据卷`
                        : info?.git?.subject || "—"}
                  </p>
                </div>
                <div className="glass-hairline rounded-xl bg-[var(--glass-tile)] px-3 py-2.5">
                  <p className="text-[10.5px] text-[var(--muted)]">最近提交时间</p>
                  <p className="mono mt-1 text-[12px] font-semibold">
                    {info?.git?.date ? formatDateTime(info.git.date) : "—"}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onPress={() => setUpdateOpen(true)}
                  isPending={updating}
                  isDisabled={updateMode === "git" && Boolean(info?.git?.dirty)}
                >
                  <CloudDownload className="size-3.5" />
                  更新到最新版本
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  isPending={checking}
                  onPress={() => void handleCheckUpdate()}
                >
                  <RefreshCw className="size-3.5" />
                  检查更新
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  isDisabled={!info?.git?.short}
                  onPress={() => {
                    void (async () => {
                      const ok = await copyText(info?.git?.short ?? "");
                      toast[ok ? "success" : "error"](ok ? "提交号已复制" : "复制失败");
                    })();
                  }}
                >
                  <Copy className="size-3.5" />
                  复制提交号
                </Button>
              </div>
              <p className="text-[11.5px] text-[var(--muted)]">
                {updateMode === "command"
                  ? "更新会执行服务器上配置的 CARD_UPDATE_COMMAND。命令需要自行完成拉取与前端构建，并在失败时返回非零退出码。"
                  : updateMode === "download"
                    ? "更新会从 GitHub 下载最新源码包，写入 /data/app，然后自动重启；数据卷里的数据库不受影响。前端静态文件随源码包一起更新，不需要在服务器构建。"
                  : "更新只会执行 git pull --ff-only。工作区有修改时会拒绝执行以免覆盖本地文件；更新完成后建议重启服务让新代码生效。前端改动需要先重新构建 static，服务器没有 Node 时会沿用旧页面。"}
              </p>
            </>
          ) : (
            <div className="space-y-2 text-[12px] text-[var(--muted)]">
              <p>容器镜像内不包含 .git 目录，无法在网页里拉取代码。</p>
              <p className="mono copyable text-[11.5px]">
                docker compose pull &amp;&amp; docker compose up -d
              </p>
            </div>
          )}

          {checkResult || checkError ? (
            <div className="glass-hairline space-y-2 rounded-xl bg-[var(--glass-tile)] px-3 py-2.5">
              {checkResult ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip
                      variant="soft"
                      size="sm"
                      color={
                        !checkResult.supported
                          ? "default"
                          : checkResult.updated
                            ? "accent"
                            : "warning"
                      }
                    >
                      {!checkResult.supported
                        ? "无法比对远端"
                        : checkResult.updated
                          ? "已是最新版本"
                          : "发现 " + checkResult.behind + " 个新提交"}
                    </Chip>
                    <span className="mono text-[11px] text-[var(--muted)]">
                      {checkResult.local?.short ?? "—"} →{" "}
                      {checkResult.remote?.short ?? "—"}
                    </span>
                    {checkResult.checked_at ? (
                      <span className="text-[11px] text-[var(--muted)]">
                        检查于 {formatDateTime(checkResult.checked_at)}
                      </span>
                    ) : null}
                  </div>
                  {checkResult.remote?.subject ? (
                    <p className="text-[11.5px]">{checkResult.remote.subject}</p>
                  ) : null}
                  {checkResult.commits.length ? (
                    <ul className="max-h-40 space-y-1 overflow-y-auto">
                      {checkResult.commits.map((line) => (
                        <li key={line} className="mono copyable text-[11px]">
                          {line}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
                    {checkResult.ahead ? (
                      <span>本地领先 {checkResult.ahead} 个提交</span>
                    ) : null}
                    {checkResult.files.length ? (
                      <span>{checkResult.files.length} 个文件变化</span>
                    ) : null}
                    {checkResult.dirty ? <span>工作区有未提交修改</span> : null}
                    {checkResult.pendingRestart ? (
                      <span>新版本已下载，重启后生效</span>
                    ) : null}
                    {checkResult.repo ? <span>{checkResult.repo}</span> : null}
                  </div>
                  {checkResult.note ? (
                    <p className="text-[11px] text-[var(--muted)]">
                      {checkResult.note}
                    </p>
                  ) : null}
                </>
              ) : null}
              {checkError ? (
                <p className="text-[11px] text-[var(--danger)]">{checkError}</p>
              ) : null}
            </div>
          ) : null}

          {lastUpdate ? (
            <div className="glass-hairline space-y-2 rounded-xl bg-[var(--glass-tile)] px-3 py-2.5">
              <p className="text-[11px] text-[var(--muted)]">
                {lastUpdate.command
                  ? `上次执行自定义更新命令，输出 ${lastUpdate.commits.length} 行`
                  : `上次更新：${lastUpdate.before} → ${lastUpdate.after}，共 ${lastUpdate.commits.length} 个提交，${lastUpdate.files.length} 个文件变化`}
              </p>
              {lastUpdate.commits.length ? (
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {lastUpdate.commits.map((line) => (
                    <li key={line} className="mono copyable text-[11px]">
                      {line}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {packages.length || updateMode === "download" ? (
            <div className="glass-hairline space-y-2 rounded-xl bg-[var(--glass-tile)] px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[11.5px] font-medium">
                    <FileArchive className="size-3.5 text-[var(--accent)]" />
                    GitHub 源码包
                  </p>
                  <p className="mt-1 text-[10.5px] break-all text-[var(--muted)]">
                    {packages.length
                      ? `保留 ${packages.length} 份 · ${info?.update_package_dir ?? "数据目录"}`
                      : "更新时会从 GitHub 下载源码包，下载完成后在这里下载或删除"}
                  </p>
                </div>
                {packages.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => setPackageToDelete("*")}
                  >
                    <Trash2 className="size-3.5" />
                    清空全部
                  </Button>
                ) : null}
              </div>
              {packages.length ? (
                <ul className="flex flex-col">
                  {packages.map((item, index) => (
                    <li
                      key={item.name}
                      className={cn(
                        "flex flex-wrap items-center justify-between gap-2 py-2",
                        index !== packages.length - 1 &&
                          "border-b border-[var(--separator)]",
                      )}
                    >
                      <div className="min-w-0">
                        <p className="mono truncate text-[11.5px]">{item.name}</p>
                        <p className="mt-0.5 text-[10.5px] text-[var(--muted)]">
                          {formatBytes(item.size)} · {formatDateTime(item.created_at)}
                          {item.short ? ` · ${item.short}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          isDisabled={packageBusy === item.name}
                          onPress={() => void handleDownloadPackage(item.name)}
                        >
                          <Download className="size-3.5" />
                          下载
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          isDisabled={packageBusy === item.name}
                          onPress={() => setPackageToDelete(item.name)}
                        >
                          <Trash2 className="size-3.5" />
                          删除
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Card.Content>
      </Card>

      <Card className="glass glass-hairline rounded-[1.5rem]">
        <Card.Header className="flex flex-row items-start justify-between gap-3">
          <div>
            <Card.Title className="flex items-center gap-2 text-[15px]">
              <Archive className="size-4 text-[var(--accent)]" />
              历史备份
            </Card.Title>
            <Card.Description className="break-all">
              {info?.backup_dir ?? "读取中…"} · 最多保留 20 份
            </Card.Description>
          </div>
          <Chip variant="soft" size="sm">
            {info?.backups.length ?? 0} 份
          </Chip>
        </Card.Header>
        <Card.Content>
          {loading ? (
            <p className="text-[12px] text-[var(--muted)]">正在读取…</p>
          ) : (info?.backups.length ?? 0) === 0 ? (
            <p className="text-[12.5px] text-[var(--muted)]">
              还没有备份。点击“立即备份并下载”会同时留存一份到服务器的备份目录。
            </p>
          ) : (
            <ul className="flex flex-col">
              {info?.backups.map((file, index) => (
                <li
                  key={file.name}
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-3 py-2.5",
                    index !== info.backups.length - 1 && "border-b border-[var(--separator)]",
                  )}
                >
                  <div className="min-w-0">
                    <p className="mono truncate text-[12px] font-medium">{file.name}</p>
                    <p className="mt-0.5 text-[10.5px] text-[var(--muted)]">
                      {formatBytes(file.size)} · {formatDateTime(file.created_at)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() =>
                        void api
                          .downloadBackupFile(file.name)
                          .then(() => toast.success("已开始下载"))
                          .catch((err: unknown) =>
                            toast.error(err instanceof ApiError ? err.message : "下载失败"),
                          )
                      }
                    >
                      <Download className="size-3.5" />
                      下载
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[var(--danger)]"
                      onPress={() => setBackupToDelete(file.name)}
                      isDisabled={backupBusy === file.name}
                    >
                      <Trash2 className="size-3.5" />
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>

      <Modal>
        <Modal.Backdrop
          isOpen={updateOpen}
          onOpenChange={setUpdateOpen}
          variant="blur"
        >
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading className="text-[15px]">确认更新项目</Modal.Heading>
                <Description className="text-[12px] text-[var(--muted)]">
                  {updateMode === "command"
                    ? "在服务器执行已配置的更新命令，完成后重启服务加载新版本。"
                    : `从 ${info?.git?.branch ?? "当前分支"} 拉取远端最新提交。只允许快进合并，不会丢弃本地提交。`}
                </Description>
              </Modal.Header>
              <Modal.Body className="space-y-3">
                <label className="flex items-start gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[var(--accent)]"
                    checked={restartAfterUpdate}
                    onChange={(event) => setRestartAfterUpdate(event.target.checked)}
                  />
                  <span>
                    更新完成后自动重启服务
                    <span className="block text-[11px] text-[var(--muted)]">
                      重启会直接加载刚下载的代码，前台运行 python server.py 时同样生效。
                    </span>
                  </span>
                </label>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="outline" onPress={() => setUpdateOpen(false)} isDisabled={updating}>
                  取消
                </Button>
                <Button onPress={() => void handleUpdate()} isPending={updating}>
                  <CloudDownload className="size-4" />
                  开始更新
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal>
        <Modal.Backdrop
          isOpen={pendingFile !== null}
          onOpenChange={(open) => {
            if (!open) setPendingFile(null);
          }}
          variant="blur"
        >
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading className="text-[15px]">确认恢复备份</Modal.Heading>
                <Description className="text-[12px] text-[var(--muted)]">
                  恢复会覆盖当前数据库，服务端会先自动保存一份安全备份。恢复后当前会话仍有效，可刷新页面查看。
                </Description>
              </Modal.Header>
              <Modal.Body className="space-y-3">
                <TextField>
                  <Label>待恢复文件</Label>
                  <Input value={pendingFile?.name ?? ""} readOnly />
                </TextField>
                <p className="text-[11.5px] text-[var(--muted)]">
                  只接受包含 cards 与 users 表、且完整性检查通过的 SQLite 文件。恢复完成后需要重启服务。
                </p>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="outline" onPress={() => setPendingFile(null)} isDisabled={restoring}>
                  取消
                </Button>
                <Button variant="danger" onPress={() => void handleRestore()} isPending={restoring}>
                  确认恢复
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal>
        <Modal.Backdrop
          isOpen={restartOpen}
          onOpenChange={setRestartOpen}
          variant="blur"
        >
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading className="text-[15px]">确认重启服务</Modal.Heading>
                <Description className="text-[12px] text-[var(--muted)]">
                  当前会话会失效，需要重新登录。
                </Description>
              </Modal.Header>
              <Modal.Footer>
                <Button variant="outline" onPress={() => setRestartOpen(false)}>
                  取消
                </Button>
                <Button variant="danger" onPress={() => void handleRestart()}>
                  确认重启
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal>
        <Modal.Backdrop
          isOpen={changelogOpen}
          onOpenChange={setChangelogOpen}
          variant="blur"
        >
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading className="flex items-center gap-2 text-[15px]">
                  <FileText className="size-4 text-[var(--accent)]" />
                  更新日志
                </Modal.Heading>
                <Description className="text-[11.5px] break-all text-[var(--muted)]">
                  {changelog?.version
                    ? `${changelog.version} · ${
                        changelog.updated_at
                          ? formatDateTime(changelog.updated_at)
                          : "CHANGELOG.md"
                      }`
                    : changelog?.path ?? "CHANGELOG.md"}
                </Description>
              </Modal.Header>
              <Modal.Body>
                {changelogLoading ? (
                  <p className="text-[12px] text-[var(--muted)]">正在读取更新日志…</p>
                ) : changelogError ? (
                  <p className="text-[12px] text-[var(--danger)]">{changelogError}</p>
                ) : changelog?.text ? (
                  <div className="max-h-[62vh] space-y-2 overflow-y-auto pr-1">
                    {renderChangelog(changelog.text)}
                    {changelog.truncated ? (
                      <p className="text-[11px] text-[var(--muted)]">
                        日志超过 512 KB，这里只显示前部分；完整内容见项目根目录的 CHANGELOG.md。
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[12px] text-[var(--muted)]">
                    项目根目录没有 CHANGELOG.md。
                  </p>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="outline" onPress={() => setChangelogOpen(false)}>
                  关闭
                </Button>
                <Button
                  variant="outline"
                  onPress={() => void openChangelog()}
                  isPending={changelogLoading}
                >
                  <RefreshCw className="size-3.5" />
                  重新读取
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal>
        <Modal.Backdrop
          isOpen={packageToDelete !== null}
          onOpenChange={(open) => {
            if (!open) setPackageToDelete(null);
          }}
          variant="blur"
        >
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading className="text-[15px]">
                  {packageToDelete === "*" ? "删除全部更新包" : "删除更新包"}
                </Modal.Heading>
                <Description className="text-[12px] text-[var(--muted)]">
                  只删除服务器上保留的源码包，不影响已经生效的版本；再次更新时会重新从 GitHub 下载。
                </Description>
              </Modal.Header>
              <Modal.Body className="space-y-3">
                <TextField>
                  <Label>待删除文件</Label>
                  <Input
                    value={
                      packageToDelete === "*"
                        ? `全部 ${packages.length} 个更新包`
                        : packageToDelete ?? ""
                    }
                    readOnly
                  />
                </TextField>
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="outline"
                  onPress={() => setPackageToDelete(null)}
                  isDisabled={Boolean(packageBusy)}
                >
                  取消
                </Button>
                <Button
                  variant="danger"
                  onPress={() => void handleDeletePackage()}
                  isPending={Boolean(packageBusy)}
                >
                  <Trash2 className="size-3.5" />
                  确认删除
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal>
        <Modal.Backdrop
          isOpen={backupToDelete !== null}
          onOpenChange={(open) => {
            if (!open) setBackupToDelete(null);
          }}
          variant="blur"
        >
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading className="text-[15px]">删除历史备份</Modal.Heading>
                <Description className="text-[12px] text-[var(--muted)]">
                  只删除服务器备份目录里的这份快照，当前正在使用的数据库不受影响，删除后无法恢复。
                </Description>
              </Modal.Header>
              <Modal.Body className="space-y-3">
                <TextField>
                  <Label>待删除文件</Label>
                  <Input value={backupToDelete ?? ""} readOnly />
                </TextField>
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="outline"
                  onPress={() => setBackupToDelete(null)}
                  isDisabled={Boolean(backupBusy)}
                >
                  取消
                </Button>
                <Button
                  variant="danger"
                  onPress={() => void handleDeleteBackup()}
                  isPending={Boolean(backupBusy)}
                >
                  <Trash2 className="size-3.5" />
                  确认删除
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

export default SystemView;
