import type {
  Card,
  ChangelogInfo,
  GenerateResult,
  LoginResult,
  RestoreResult,
  Stats,
  SystemInfo,
  UpdateCheck,
  UpdatePackage,
  UpdateResult,
  User,
} from "./types";

export interface ApiEnvelope<T> {
  status: string;
  message?: string;
  data?: T;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const TOKEN_KEY = "card_session";
const USER_KEY = "card_user";

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export function setToken(next: string | null) {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function getToken(): string | null {
  if (token) return token;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token;
}

export function clearToken() {
  token = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function saveUser(user: User) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* storage unavailable */
  }
}

export function loadUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const current = getToken();
  if (current) headers.Authorization = `Bearer ${current}`;
  return headers;
}

async function download(path: string, fallbackName: string) {
  let response: Response;
  try {
    response = await fetch(path, { headers: authHeaders() });
  } catch {
    throw new ApiError("无法连接服务器", 0);
  }
  if (!response.ok) {
    let message = `下载失败（HTTP ${response.status}）`;
    try {
      const parsed = (await response.json()) as ApiEnvelope<unknown>;
      message = parsed.message || message;
    } catch {
      /* 非 JSON 错误响应 */
    }
    throw new ApiError(message, response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const name = match?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
  const { method = "GET", body, auth = true } = options;
  const headers: Record<string, string> = { Accept: "application/json" };

  if (auth) {
    const current = getToken();
    if (current) headers.Authorization = `Bearer ${current}`;
  }

  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError("无法连接服务器", 0);
  }

  let parsed: ApiEnvelope<T>;
  try {
    parsed = (await response.json()) as ApiEnvelope<T>;
  } catch {
    parsed = { status: "error", message: "服务响应异常" };
  }

  const message = parsed.message || "服务响应异常";

  if (response.status === 401 || /未授权/.test(message)) {
    clearToken();
    onUnauthorized?.();
    throw new ApiError(message, response.status);
  }

  if (!response.ok || parsed.status === "error") {
    throw new ApiError(message, response.status);
  }

  return parsed;
}

function dataOf<T>(envelope: ApiEnvelope<T>): T {
  return (envelope.data ?? ({} as T)) as T;
}

export const api = {
  async health() {
    return dataOf(await request<{ service: string }>("/health", { auth: false }));
  },
  async me() {
    return dataOf(await request<{ user: User }>("/api/me"));
  },
  async login(username: string, password: string) {
    return dataOf(
      await request<LoginResult>("/api/login", {
        method: "POST",
        auth: false,
        body: { username, password },
      }),
    );
  },
  async logout() {
    await request<unknown>("/api/logout", { method: "POST" });
  },
  async dashboard() {
    return dataOf(await request<{ stats: Stats }>("/api/dashboard"));
  },
  async cards() {
    return dataOf(await request<{ cards: Card[] }>("/api/cards"));
  },
  async users() {
    return dataOf(await request<{ users: User[] }>("/api/users"));
  },
  async generateCards(input: {
    count: number;
    card_type: string;
    expire_time: string;
    note?: string;
    app_id?: string;
  }) {
    return dataOf(await request<GenerateResult>("/api/cards/generate", { method: "POST", body: input }));
  },
  async updateCard(input: { id: number; expire_time?: string; note?: string }) {
    await request<unknown>("/api/cards/update", { method: "POST", body: input });
  },
  async toggleCard(id: number) {
    return dataOf(await request<{ status: string }>("/api/cards/toggle", { method: "POST", body: { id } }));
  },
  async deleteCards(ids: number[]) {
    return dataOf(
      await request<{ deleted: number; missing: number }>("/api/cards/delete", {
        method: "POST",
        body: { ids: ids.join(",") },
      }),
    );
  },
  async createUser(input: { username: string; password: string; role: string }) {
    await request<unknown>("/api/users/create", { method: "POST", body: input });
  },
  async toggleUser(id: number) {
    await request<unknown>("/api/users/toggle", { method: "POST", body: { id } });
  },
  async system() {
    return dataOf(await request<SystemInfo>("/api/system"));
  },
  async downloadBackup() {
    return download("/api/backup/download", "cards.sqlite3");
  },
  async downloadBackupFile(name: string) {
    return download(
      `/api/backup/file?name=${encodeURIComponent(name)}`,
      name,
    );
  },
  async restoreBackup(file: File) {
    const response = await fetch("/api/backup/restore", {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/octet-stream",
      },
      body: file,
    });
    let parsed: ApiEnvelope<RestoreResult>;
    try {
      parsed = (await response.json()) as ApiEnvelope<RestoreResult>;
    } catch {
      throw new ApiError("服务响应异常", response.status);
    }
    if (!response.ok || parsed.status === "error") {
      throw new ApiError(parsed.message || "恢复失败", response.status);
    }
    return dataOf(parsed);
  },
  async restart() {
    return dataOf(await request<{ pid: number }>("/api/restart", { method: "POST" }));
  },
  async updateProject(restart: boolean) {
    return dataOf(
      await request<UpdateResult>("/api/update", {
        method: "POST",
        body: { restart: restart ? "1" : "0" },
      }),
    );
  },
  async checkUpdate() {
    return dataOf(await request<UpdateCheck>("/api/update/check"));
  },
  async changelog() {
    return dataOf(
      await request<ChangelogInfo & { text: string }>("/api/changelog"),
    );
  },
  async downloadUpdatePackage(name: string) {
    return download(
      `/api/update/package?name=${encodeURIComponent(name)}`,
      name,
    );
  },
  async deleteBackup(name: string) {
    return dataOf(
      await request<{ deleted: string[]; backups: { name: string; size: number; created_at: string }[] }>(
        "/api/backup/delete",
        { method: "POST", body: { name } },
      ),
    );
  },
  async deleteUpdatePackage(name: string) {
    return dataOf(
      await request<{ deleted: string[]; packages: UpdatePackage[] }>(
        "/api/update/package/delete",
        { method: "POST", body: { name } },
      ),
    );
  },
};

export type {
  Card,
  ChangelogInfo,
  GenerateResult,
  LoginResult,
  Stats,
  SystemInfo,
  UpdateCheck,
  UpdatePackage,
  UpdateResult,
  User,
};
