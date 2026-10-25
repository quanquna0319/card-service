export type Role = "admin" | "user";

export interface User {
  id: number;
  username: string;
  role: Role | string;
  created_at?: string | null;
  disabled?: boolean | number;
}

export interface Card {
  id: number;
  /** 卡密明文。旧数据库里的历史卡密只存过摘要，这里会是空值。 */
  card_code?: string | null;
  card_type: string;
  status: string;
  created_at?: string | null;
  activated_at?: string | null;
  expire_time?: string | null;
  device_uuid?: string | null;
  app_id?: string | null;
  note?: string | null;
}

export interface Stats {
  cards: number;
  active: number;
  unused: number;
  users: number;
}

export interface LoginResult {
  token: string;
  user: User;
}

export interface GenerateResult {
  cards: string[];
  card_type: string;
  expire_time: string;
}

export interface BackupFile {
  name: string;
  size: number;
  created_at: string;
}

export interface UpdatePackage {
  /** 保留在服务器上的源码包文件名，形如 card-service-1a2b3c4.tar.gz。 */
  name: string;
  size: number;
  created_at: string;
  short?: string;
  commit?: string;
}

export interface ChangelogInfo {
  available: boolean;
  path?: string;
  version?: string;
  size?: number;
  updated_at?: string | null;
  truncated?: boolean;
}

export interface SystemInfo {
  pid: number;
  boot?: string;
  uptime: number;
  copy?: "install" | "image" | "git" | string;
  entry?: string;
  install_dir?: string;
  install_ready?: boolean;
  db: string;
  db_size: number;
  db_sha256: string;
  backup_dir: string;
  backups: BackupFile[];
  git?: GitInfo;
  update_mode?: "git" | "download" | "command" | "none" | string;
  update_repo?: string;
  update_branch?: string;
  update_package_dir?: string;
  update_packages?: UpdatePackage[];
  changelog?: ChangelogInfo;
}

export interface GitInfo {
  available: boolean;
  branch?: string;
  commit?: string;
  short?: string;
  subject?: string;
  date?: string;
  dirty?: boolean;
  pendingRestart?: boolean;
  downloaded?: string;
}

export interface UpdateResult {
  updated: boolean;
  restart_required?: boolean;
  branch: string;
  before: string;
  after: string;
  remote: string;
  commits: string[];
  files: string[];
  /** download 模式下载成功后留存的源码包。 */
  package?: UpdatePackage | Record<string, never>;
}

export interface UpdateRef {
  commit?: string;
  short?: string;
  subject?: string;
  date?: string;
  branch?: string;
}

export interface UpdateCheck {
  /** 实际生效的更新方式：git / download / command。 */
  mode: "git" | "download" | "command" | "none" | string;
  /** false 表示这种更新方式无法比对远端版本（自定义命令、没有工作区等）。 */
  supported: boolean;
  repo?: string;
  branch?: string;
  local?: UpdateRef;
  remote?: UpdateRef;
  /** 远端领先本地的提交列表，形如 "1a2b3c4 提交说明"。 */
  commits: string[];
  files: string[];
  /** 远端领先本地的提交数。 */
  behind: number;
  /** 本地领先远端的提交数。 */
  ahead: number;
  updated: boolean;
  dirty?: boolean;
  pendingRestart?: boolean;
  checked_at?: string | null;
  note?: string;
}

export interface RestoreResult {
  summary: {
    cards: number;
    users: number;
    active: number;
    unused: number;
    disabled: number;
    admins: number;
  };
  safety_backup: string;
  size: number;
  sha256: string;
}
