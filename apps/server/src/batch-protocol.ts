/**
 * `#746` B1 / `#753` B2：主进程 ↔ 批处理子进程的 **IPC 协议**（唯一实现，两侧共用）。
 *
 * 为什么要单独一个文件：主进程（`batch-runner.ts`）与子进程（`batch-child.ts`）必须
 * 对「消息长什么样」有**同一份**定义，否则一侧改字段另一侧静默收不到（那是静默失败）。
 *
 * 单写者约定：
 *  · B1（`YUEDU_BATCH_PROCESS`）：子进程**只读** `data/yuedu.db` 与 `data/kv.json`
 *    （`SourceDb.openReadOnly`）；它产生的**任何写**（源变量 / 缓存）都以 `kv-write`
 *    交回主进程执行；体检结果 / 批量校验结果同样只回主进程，由主进程落盘。
 *  · B2（`YUEDU_B2_PROCESS=1`，默认关）：登录求值也搬进子进程。**同一键只有一条写入发起路径**
 *    —— 登录路由不再自己 `persistSourceCookies()` / `setSourceLoginInfo()`，一切写都由子进程以
 *    `kv-write` / `cookie-write` 发起、主进程执行（物理落盘仍收口在主进程，理由见
 *    `batch-runner.ts` 头注：两个进程各有整份 `kv.json` 内存副本，直接双写会互相覆盖）。
 *
 * `version`（B2 新增）：主进程每收到一次「源变更」（导入/删除/编辑/开关/恢复）就 +1，并把
 * `reload` 推给子进程；子进程在结果里**原样回带**它开始时看到的版本。主进程比对
 * `pending.version` 与当前版本 —— 不匹配的结果**直接丢弃**（防止旧进程结果覆盖新状态）。
 */

/** 本轮搬进子进程的批处理种类（登录在 B2 才启用，见 `YUEDU_B2_PROCESS`） */
export type BatchJobKind = 'patrol' | 'validate-all' | 'verify' | 'login' | 'warmup';

/** 主 → 子：一个任务 */
export interface BatchJobMessage {
  t: 'job';
  id: string;
  kind: BatchJobKind;
  payload: unknown;
  /** 单任务超时（ms）——子进程内也按它自设上限，避免主进程先杀 */
  timeoutMs: number;
  /** 源库版本号（主进程维护）；结果必须原样带回，见文件头 `version` 说明 */
  version: number;
}

/** 子 → 主：任务结果（`ok=false` 时带 `error`） */
export interface BatchResultMessage {
  t: 'result';
  id: string;
  ok: boolean;
  result?: unknown;
  /** 子进程内耗时（ms），主进程日志直接用它（不含冷启动） */
  ms?: number;
  error?: string;
  /** 子进程执行该任务时看到的源库版本（旧子进程可能不填） */
  version?: number;
}

/** 主 → 子：源库变了（重载快照；在飞任务结束后再生效） */
export interface BatchReloadMessage {
  t: 'reload';
  version: number;
  /** 变更原因（只用于日志） */
  reason?: string;
}

/** 子 → 主：一次存储写回（`value === null` = 删除） */
export interface BatchKvWriteMessage {
  t: 'kv-write';
  key: string;
  value: string | null;
}

/**
 * 子 → 主：登录产出的 Cookie（**整源替换**，`null` = 清空）。
 *
 * 为什么不回传整份 `cookies.json`：主进程还有验证码/反爬收割等其他写路径，
 * 只回传**该源**的 map，由主进程合并进自己的 CookieJar 再统一落盘 —— 不会互相覆盖。
 */
export interface BatchCookieWriteMessage {
  t: 'cookie-write';
  sourceId: string;
  cookies: Record<string, string> | null;
}

/** 子 → 主：日志（主进程原样打 `[batch]` 前缀） */
export interface BatchLogMessage {
  t: 'log';
  msg: string;
}

/** 子 → 主：资源状态（B2：并发档位 / 内存占用，主进程只记日志与 `status()`） */
export interface BatchStatusMessage {
  t: 'status';
  version: number;
  /** 本次任务实际使用的并发 */
  concurrency: number;
  /** 子进程 RSS（MB） */
  rssMb: number;
  /** 子进程已用堆（MB） */
  heapMb: number;
  /** worker 池单个 worker 的内存上限（MB，`0` = 未设） */
  workerMemMb: number;
}

export type BatchChildMessage =
  | BatchResultMessage
  | BatchKvWriteMessage
  | BatchCookieWriteMessage
  | BatchLogMessage
  | BatchStatusMessage;

/** `verify` 任务的入参（与 `/api/sources/verify-batch` 的请求体对齐） */
export interface BatchVerifyPayload {
  ids: string[];
  opts: {
    keyword?: string;
    concurrency?: number;
    markOnError?: boolean;
    checkDiscoveryDeep?: boolean;
  };
}

/**
 * `login` 任务的入参（与 `POST /api/sources/:id/login` 的请求体对齐）。
 * 只下放「纯 HTTP 登录脚本」；脚本里出现浏览器 API（startBrowserAwait / webView /
 * getVerificationCode …）时由调用方判据挡在主进程（见 index.ts `loginNeedsBrowser`）。
 */
export interface BatchLoginPayload {
  sourceId: string;
  opts: {
    info?: Record<string, unknown>;
    action?: string;
    loginState?: string;
    loginForm?: string;
  };
}

/**
 * `login` 任务的回传（B2：**登录结果 + 该源运行时状态快照**）。
 *
 * 主进程据此做「内存态采纳」——不落盘（落盘已由子进程经 `kv-write` / `cookie-write` 发起）。
 */
export interface BatchLoginResult {
  login: unknown;
  /** 该源 Cookie（`k=v` 串）——主进程用来同步自己的 CookieJar 内存 */
  cookie: string;
  /** 该源登录信息快照（账号/密码） */
  loginInfo: Record<string, string>;
  /** 该源源变量（Legado `source.setVariable`） */
  variable: string;
}

/** `patrol` 任务回传的行（B2 摘要：**不含 raw**，省约 1MB 回传） */
export interface BatchPatrolRow {
  id: string;
  name?: string;
  kind: string;
  raw?: Record<string, unknown>;
  issues?: unknown[];
  /** B2 摘要模式：子进程已算好的 lint / 结构校验结果 */
  lint?: unknown[];
  struct?: unknown[];
}

/**
 * `verify` 任务的**标记回传**（单写者：子进程只在内存里打标，真正写库在主进程）。
 *
 * 只回「注释 / 分组」两个字段（`markVerifyFailure` / `clearVerifyMark` 只动这两个），
 * 避免整份 raw 回写覆盖主进程期间的用户编辑。
 */
export interface BatchVerifyMark {
  id: string;
  comment?: string;
  group?: string;
}

export interface BatchVerifyResult {
  results: unknown[];
  changed: BatchVerifyMark[];
}
