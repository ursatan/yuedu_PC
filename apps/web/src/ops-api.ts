/**
 * `#210` **运维端点**的前端薄封装（shelf-update / diag / system/errors 三组）。
 *
 * 为什么不并进 `user-data.ts`：那是 `/api/user/*` 的接线层（登录态/同步语义）；
 * 运维端点（shelf-update / diag / system/errors）是**无用户概念的本机状态**，
 * 混进去反而让「哪层管什么」变糊。同样只有薄薄一层：URL 与方法只有这一份。
 *
 * 错误语义：非 2xx **照常抛**（`opsError` 带状态码）——运维面板必须能区分
 * 「服务没起」和「这次操作被拒（409 已在跑）」，静默兜底等于把故障藏起来。
 */

/** 统一的小封装（运维端点不需要 FormData / SSE，一个 json fetch 够了） */
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) {
    let detail = '';
    try {
      detail = String((await r.json())?.detail ?? '');
    } catch {
      /* 响应不是 JSON（比如网关 502 文本） */
    }
    throw new Error(`HTTP ${r.status}${detail ? ` · ${detail}` : ''}`);
  }
  return (await r.json()) as T;
}

/* ---------------- /api/shelf-update ---------------- */

export interface BookUpdateResult {
  name: string;
  status: 'ok' | 'fail' | 'skip';
  oldCount: number;
  newCount: number;
  added: number;
  error?: string;
}

export interface ShelfUpdateStatus {
  config: { enabled: boolean; intervalMin: number };
  running: boolean;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  nextRunAt: string | null;
  updatedNames: string[];
  results: BookUpdateResult[];
  lastError: string | null;
  progress: { done: number; total: number } | null;
}

export const getShelfUpdate = () => json<ShelfUpdateStatus>('/api/shelf-update');

export const saveShelfUpdateConfig = (patch: { enabled?: boolean; intervalMin?: number }) =>
  json<{ ok: true; config: ShelfUpdateStatus['config']; warnings: string[]; status: ShelfUpdateStatus }>(
    '/api/shelf-update/config',
    { method: 'POST', body: JSON.stringify(patch) },
  );

export const runShelfUpdate = () =>
  json<{ ok: true; status: ShelfUpdateStatus }>('/api/shelf-update/run', { method: 'POST', body: '{}' });

/* ---------------- `#558` /api/doctor/patrol/config ---------------- */

/**
 * 巡检间隔配置。用户口径：**只给四档**（24h / 3天 / 7天 / 30天），默认 7 天。
 * 档位由服务端给（`options`），前端不硬编码 —— 否则两处漂移。
 */
export interface PatrolConfig {
  hours: number;
  options: number[];
  defaultHours: number;
  everyMs: number;
  /** 被环境变量钉死 ⇒ 改不了（UI 要置灰并说明，不能让人白点） */
  pinned?: boolean;
}
export const getPatrolConfig = () => json<PatrolConfig>('/api/doctor/patrol/config');
export const savePatrolConfig = (hours: number) =>
  json<{ ok: true; hours: number; everyMs: number }>('/api/doctor/patrol/config', {
    method: 'POST',
    body: JSON.stringify({ hours }),
  });

/* ---------------- /api/diag ---------------- */

/**
 * `#732` 外链脚本「请手动下载」提示（同 URL 只提示一次，服务端持久化）。
 * 语义：**网络优先 → 镜像兜底 → 连续失败到阈值提示用户手动下载**。
 */
export interface JsLibHint {
  url: string;
  /** 应放置的绝对路径（Windows 反斜杠） */
  absPath: string;
  fails: number;
  reason: string;
  notifiedAt: string;
  text: string;
}

export interface DiagInfo {
  mem: {
    heapUsedMB: number;
    heapTotalMB: number;
    heapLimitMB: number;
    externalMB: number;
    rssMB: number;
    peakHeapUsedMB: number;
    uptimeSec: number;
  };
  /** 字段与 `packages/core/src/net/index.ts` 的 `netStats` 一一对应（只列界面要展示的） */
  net: {
    requests: number;
    peakInFlight: number;
    inFlight: number;
    bytes: number;
    truncated: number;
    throttledMs: number;
    retries: number;
    errConnectTimeout: number;
    errDns: number;
    errReset: number;
    errTimeout: number;
    errOther: number;
  };
  traffic: {
    global: { inFlight: number; peak: number; limit: number; rpsUsed: number; rpsLimit: number };
    domains: Array<{ domain: string; inFlight: number; limit: number; breakerOpen: boolean; fails: number }>;
    breakers: { tracked: number; open: number; trips: number };
    warnings: string[];
  };
  blocks: Record<string, number>;
  blocksText: string;
  /** `#732` 外链脚本连续失败 ⇒ 「请手动下载」提示（空数组 = 无） */
  jslibHints?: JsLibHint[];
  [k: string]: unknown;
}

export const getDiag = () => json<DiagInfo>('/api/diag');

/* ---------------- /api/system/errors ---------------- */

export interface CrashEntry {
  at: string;
  kind: 'uncaughtException' | 'unhandledRejection' | 'record';
  message: string;
  stack?: string;
}

export const getSystemErrors = () =>
  json<{ recent: CrashEntry[]; logDir: string; files: { name: string; sizeKB: number; mtime: string }[] }>(
    '/api/system/errors',
  );

/* ---------------- /api/system/identity ---------------- */

/**
 * 本服务实例的只读身份（桌面端 / 独立 Web 两张形态靠它区分）。
 * `peer` 仅在 `?peer=1` 时出现：服务端会顺手探一下**另一默认端口**（3000↔3100），
 * 用来判断「两端是否共用同一数据目录」。
 */
export interface SystemIdentity {
  app: string;
  mode: 'desktop' | 'standalone';
  /** `sha1(dataDir).slice(0,8)` */
  instanceId: string;
  pid: number;
  port: number;
  dataDir: string;
  sourceDb: string;
  startedAt: string;
  peer?: SystemIdentity | null;
}

export const getSystemIdentity = (withPeer = true) =>
  json<SystemIdentity>(`/api/system/identity${withPeer ? '?peer=1' : ''}`);
