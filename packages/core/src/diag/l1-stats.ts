/**
 * `#749` D2：L1 求值路由 / `l1w-drop` / 单段超时 / `curl` 回退的**进程内计数**。
 *
 * 为什么单独一份而不是塞进 `block-stats`：`block-stats` 记的是「阻塞时长」（kind + ms），
 * 用来解释「服务为什么假死」；这里记的是**判定结果**（为什么没走 worker、丢了哪些绑定、
 * 超时/回退各多少次），用来回答「`YUEDU_L1_WORKER` 能不能默认开」。两者量纲不同，
 * 混在一起会让 `formatBlocks()` 的汇总多出一堆 ms=0 的行（实际发生过：早期把路由计数
 * 记成 recordBlock，结果总阻塞被算成 0）。
 *
 * 开销：每个求值段几次自增 + 一个 Map；无环境变量开关（诊断数据本身必须一直在）。
 */

export type L1RouteReason =
  | 'java-bridge'
  | 'document'
  | 'dom-binding'
  | 'non-cloneable'
  | 'non-pure-http'
  /** 纯 HTTP 子集但开关未开（`YUEDU_L1_WORKER` 默认关） */
  | 'switch-off'
  /** L1 到点中止（`L1_TIMEOUT`）；这条是**结果**，不是路由原因，单独计在 timeout 里 */
  | 'l1-timeout';

export interface L1StatsSnapshot {
  /** 当前进程是否开了 D1 子集下放（只做展示，判定仍以每次调用为准） */
  workerEnabled: boolean;
  /** 实际落点计数（worker = 下放到 worker 池；l1 = 宿主同步求值） */
  routed: { worker: number; l1: number };
  /** 命中 D1 判据（纯 HTTP + 文本）的求值段数：= 可下放总数，与 routed.worker 的差即「判据漏放」 */
  eligible: number;
  /** `l1w-drop`：不可克隆但脚本未引用 ⇒ 被丢掉的绑定名（名 → 次数） */
  drops: { count: number; bindings: Record<string, number> };
  /** 回落 L1 的原因分布（原因 → 次数） */
  reasons: Record<string, number>;
  /** 单段硬超时 `L1_TIMEOUT` 的触发统计 */
  timeout: { n: number; maxMs: number; lastLimitMs: number; lastDetail: string };
  /** `curl` 兜底：实际启用 / 被拦下（默认拦下）的原因分布 */
  curl: { fallback: number; blocked: number; reasons: Record<string, number> };
}

const state = {
  routed: { worker: 0, l1: 0 },
  eligible: 0,
  dropCount: 0,
  drops: new Map<string, number>(),
  reasons: new Map<string, number>(),
  timeoutN: 0,
  timeoutMaxMs: 0,
  timeoutLastLimitMs: 0,
  timeoutLastDetail: '',
  curlFallback: 0,
  curlBlocked: 0,
  curlReasons: new Map<string, number>(),
};

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** 本段命中了 D1 的「纯 HTTP + 文本」判据（不论最终是否因绑定而回落） */
export function noteL1Eligible(): void {
  state.eligible += 1;
}

/** 本段落到了 worker 池 */
export function noteL1RoutedWorker(): void {
  state.routed.worker += 1;
}

/** 本段回落宿主 L1（`reason` 是**第一个**拦下它的判据） */
export function noteL1RoutedL1(reason: L1RouteReason | string): void {
  state.routed.l1 += 1;
  bump(state.reasons, String(reason));
}

/** 记录一次 `l1w-drop`（不可克隆且脚本未引用的绑定名） */
export function noteL1Drops(names: readonly string[]): void {
  if (!names.length) return;
  state.dropCount += names.length;
  for (const n of names) bump(state.drops, n);
}

/** 单段 L1 求值到点中止 */
export function noteL1Timeout(limitMs: number, elapsedMs: number, detail: string): void {
  state.timeoutN += 1;
  if (elapsedMs > state.timeoutMaxMs) state.timeoutMaxMs = elapsedMs;
  state.timeoutLastLimitMs = limitMs;
  state.timeoutLastDetail = detail.slice(0, 160);
}

/**
 * `curl` 兜底的取舍记录。
 * `action='curl'` = 真的起了 `execFileSync curl`；`action='blocked'` = 按默认策略返回空响应。
 */
export function noteCurlFallback(reason: string, action: 'curl' | 'blocked'): void {
  if (action === 'curl') state.curlFallback += 1;
  else state.curlBlocked += 1;
  bump(state.curlReasons, `${action}:${reason}`);
}

/** `/api/diag` 快照（深拷贝，调用方可以安全序列化） */
export function l1StatsSnapshot(): L1StatsSnapshot {
  return {
    workerEnabled: process.env['YUEDU_L1_WORKER'] === '1',
    routed: { ...state.routed },
    eligible: state.eligible,
    drops: { count: state.dropCount, bindings: Object.fromEntries(state.drops) },
    reasons: Object.fromEntries(state.reasons),
    timeout: {
      n: state.timeoutN,
      maxMs: state.timeoutMaxMs,
      lastLimitMs: state.timeoutLastLimitMs,
      lastDetail: state.timeoutLastDetail,
    },
    curl: {
      fallback: state.curlFallback,
      blocked: state.curlBlocked,
      reasons: Object.fromEntries(state.curlReasons),
    },
  };
}

/** 清空（`/api/diag?reset=1` 与基准测量前调用） */
export function resetL1Stats(): void {
  state.routed.worker = 0;
  state.routed.l1 = 0;
  state.eligible = 0;
  state.dropCount = 0;
  state.drops.clear();
  state.reasons.clear();
  state.timeoutN = 0;
  state.timeoutMaxMs = 0;
  state.timeoutLastLimitMs = 0;
  state.timeoutLastDetail = '';
  state.curlFallback = 0;
  state.curlBlocked = 0;
  state.curlReasons.clear();
}
