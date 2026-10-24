import { useState, type FormEvent } from "react";
import { Fingerprint, LogIn, TriangleAlert } from "lucide-react";

import { Button, FieldError, Input, Label, Spinner, TextField } from "@heroui/react";

import { Aurora } from "@/components/layout/Aurora";
import { api, ApiError, type User } from "@/lib/api";

interface LoginViewProps {
  onSuccess: (token: string, user: User) => void;
}

export function LoginView({ onSuccess }: LoginViewProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const name = username.trim();
    if (!name || !password) {
      setError("用户名和密码都不能留空");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const data = await api.login(name, password);
      if (!data.token || !data.user) {
        throw new ApiError("登录响应缺少会话信息");
      }
      onSuccess(data.token, data.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4 py-10">
      <Aurora />

      <div className="animate-rise w-full max-w-[26rem]">
        <div className="glass glass-hairline overflow-hidden rounded-[2rem]">
          <div className="flex h-1.5" aria-hidden>
            <span className="flex-1 bg-[oklch(0.62_0.2_25)]" />
            <span className="flex-1 bg-[oklch(0.62_0.19_254)]" />
            <span className="flex-1 bg-[oklch(0.66_0.16_152)]" />
          </div>

          <div className="px-7 pt-7 pb-8">
            <div className="flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-2xl bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[0_12px_30px_-12px_oklch(0.62_0.19_254/0.95)]">
                <Fingerprint className="size-5" />
              </span>
              <div className="min-w-0">
                <h1 className="text-[17px] font-semibold tracking-tight">卡密控制台</h1>
                <p className="mono text-[10.5px] text-[var(--muted)]">
                  LocalCardService/2.0 · 会话 12h
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-7 space-y-5">
              <TextField isDisabled={submitting} className="w-full">
                <Label>用户名</Label>
                <Input
                  autoComplete="username"
                  placeholder="请输入用户名"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </TextField>

              <TextField isDisabled={submitting} className="w-full">
                <Label>密码</Label>
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {error ? <FieldError>{error}</FieldError> : null}
              </TextField>

              {error ? (
                <div
                  role="alert"
                  className="glass-hairline flex items-start gap-2 rounded-2xl bg-[oklch(0.62_0.2_25/0.14)] px-3.5 py-2.5 text-[12px] text-[var(--danger)]"
                >
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}

              <Button type="submit" size="lg" fullWidth isPending={submitting}>
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : <LogIn className="size-4" />}
                    {isPending ? "正在验证…" : "进入控制台"}
                  </>
                )}
              </Button>
            </form>

            <p className="mt-6 text-[11px] leading-relaxed text-[var(--muted)]">
              首次验证会绑定 app_id 与设备 uuid，之后换设备将被拒绝。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoginView;
