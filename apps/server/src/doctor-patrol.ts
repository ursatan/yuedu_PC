/**
 * `#552` **源医生 v2-F：离线巡检的调度 / 落盘 / 播报出口**（无 LLM、**不联网**）。
 *
 * 判据与差分全在 core（`diag/patrol.ts` + `diag/rule-lint.ts`），本模块只管三件事：
 *  ① **定时**（启动后一次 + 每 6h，`YUEDU_DOCTOR_PATROL=0` 关）
 *  ② **落盘**（`DATA_DIR/doctor-patrol.json`，**跨重启保留基线**）
 *  ③ **给前端一个可消费的出口**（`?since=` 避免同一条播报反复弹）
 *
 * ★★ 两条最容易做错的，都在这里钉死：
 *
 * **① 基线必须跨重启持久化。** 首轮只建基线、不播报（core 里已锁），
 * 若基线只存在内存 ⇒ **每次重启都是「首轮」⇒ 源医生永远不播报** —— 那是永久静默
 * （铁律 3：fallback 必须可观测，静默等于没做）。故落盘并在启动时读回。
 *
 * **② 全量 lint 必须分片让出事件循环。** 实测 733 源全量 `lintSource` =
 * **247ms**（p50 0.12ms / p95 1.19ms / max 21.3ms）。现在这个量级一次跑完也不至于 stall，
 * 但源会变多、规则会变长（max 已到 21ms/源）⇒ 按 64 源一片 `setImmediate` 让出，
 * 成本可忽略（让出本身是微秒级），换来「将来不会退化成一次长停顿」。
 *
 * 联网冒烟**不做**（那是 `verify-batch` 的职责）：巡检每 6h 自动跑，一旦联网就会撞 CF/限流
 * 并污染打点 —— 用户口径也是「联网校验仍手动」。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSnapshot,
  diffSnapshots,
  patrolToastText,
  lintSource,
  sourceKindOf,
  type PatrolDelta,
  type PatrolRow,
  type PatrolSnapshot,
} from '@yuedu/core';
import type { ValidationIssue } from '@yuedu/core';

/** 落盘文件名（与 `stall-report.log` 同目录） */
export const PATROL_FILE = 'doctor-patrol.json';

export interface DoctorPatrolDeps {
  /**
   * 全量离线采集（结构校验是纯内存计算，实测 501 源 < 50ms）。
   * 抽成注入项是为了可测 —— 测试给 3 个源就能锁住调度与差分，不用起 hub。
   *
   * `#746` 允许返回 Promise：B1 把采集搬到批处理子进程后，这里是「等 IPC 回包」。
   * `#751` B2：子进程可以只回**摘要**（`lint` + `struct` 已算好、不回 `raw`），
   * 本模块按「有 lint 就用、没有才自己算」走 —— 回传体积从 ~1MB 降到几 KB。
   */
  collect: () =>
    | Array<PatrolCollectRow>
    | Promise<Array<PatrolCollectRow>>;
  dataDir: string;
  log?: (msg: string) => void;
  now?: () => number;
  /** 分片大小（每片之间让出事件循环一次） */
  chunk?: number;
}

export interface PatrolCollectRow {
  id: string;
  name?: string;
  kind: string;
  /** B1：原始源（主进程自己 lint）——与 `lint` 二选一 */
  raw?: Record<string, unknown>;
  /** B1：结构校验结果（与 `struct` 二选一） */
  issues?: ValidationIssue[];
  /** B2：子进程算好的 lint（有它就不再回传 raw） */
  lint?: unknown[];
  /** B2：子进程算好的结构校验 */
  struct?: unknown[];
}

export interface PatrolView {
  /** 最近一次巡检时间（前端用它做「已消费到哪」的游标） */
  at: number | null;
  /** `since >= at` ⇒ false（没有比前端已消费的更新的东西） */
  fresh: boolean;
  running: boolean;
  runs: number;
  snapshot: PatrolSnapshot | null;
  delta: PatrolDelta | null;
  /** 要弹的那一条（`null` = 不弹）；文案由 core 生成，本模块不重写 */
  toast: { text: string; level: 'warn' | 'ok' } | null;
  /** 关闭开关时给出原因，别让「没数据」看起来像「坏了」 */
  disabled?: boolean;
}

export interface DoctorPatrol {
  /** 跑一轮（重入安全：并发调用只跑一次，其余拿当前结果） */
  run(): Promise<PatrolSnapshot | null>;
  /** 取可消费视图 */
  view(since?: number): PatrolView;
  /** 启动定时（返回停止句柄，便于测试与优雅退出） */
  start(): { stop(): void };
  /** `#558` 当前生效的间隔（ms） */
  everyMs(): number;
  /** `#558` 改间隔并立即重排（设置页保存后调；不传则按配置文件重读） */
  setEveryMs(ms?: number): number;
  /** 当前是否已跑过至少一轮 */
  readonly ready: boolean;
}

export function patrolEnabled(): boolean {
  return process.env['YUEDU_DOCTOR_PATROL'] !== '0';
}

/** 启动后首次巡检的延迟（避开启动高峰；测试可设 0） */
export function patrolDelayMs(): number {
  const n = Number(process.env['YUEDU_DOCTOR_PATROL_DELAY_MS'] ?? 30_000);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

/**
 * `#558` **巡检间隔可配**（用户 2026-10-21：「巡检频率太高，设置页提供接口」）。
 *
 * 可选档位只有四档，**不让用户填任意值**：巡检要遍历全源 + lint，间隔太短等于持续占 CPU，
 * 而它的结论（规则结构问题）本来就不会分钟级变化。默认 **7 天**（此前硬编码 6h —— 一天跑 4 轮，
 * 每轮结论几乎一样，纯浪费）。
 *
 * 优先级：环境变量（测试/CI 要能钉死）> 配置文件 > 默认 7 天。
 */
export const PATROL_HOUR_OPTIONS = [24, 72, 168, 720] as const;
export const PATROL_DEFAULT_HOURS = 168;
export const PATROL_CONFIG_FILE = 'doctor-config.json';

interface PatrolConfig {
  /** 巡检间隔（小时） */
  patrolHours?: number;
}

function configPath(dataDir: string): string {
  return join(dataDir, PATROL_CONFIG_FILE);
}

/** 读配置（坏文件当没有 —— 不能因为一个坏 JSON 让服务起不来） */
function readConfig(dataDir: string): PatrolConfig {
  try {
    const p = configPath(dataDir);
    if (!existsSync(p)) return {};
    const j = JSON.parse(readFileSync(p, 'utf-8')) as PatrolConfig;
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 当前生效的巡检间隔（小时） */
export function patrolHours(dataDir?: string): number {
  const envN = Number(process.env['YUEDU_DOCTOR_PATROL_EVERY_MS']);
  if (Number.isFinite(envN) && envN > 0) return envN / 3_600_000;
  if (dataDir) {
    const h = readConfig(dataDir).patrolHours;
    if (typeof h === 'number' && (PATROL_HOUR_OPTIONS as readonly number[]).includes(h)) return h;
  }
  return PATROL_DEFAULT_HOURS;
}

/** 写配置；只接受四档之一（越界直接拒绝，不悄悄纠正） */
export function setPatrolHours(dataDir: string, hours: number): { ok: boolean; error?: string } {
  if (!(PATROL_HOUR_OPTIONS as readonly number[]).includes(hours)) {
    return { ok: false, error: `巡检间隔只支持 ${PATROL_HOUR_OPTIONS.join(' / ')} 小时这四档` };
  }
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const next: PatrolConfig = { ...readConfig(dataDir), patrolHours: hours };
    writeFileSync(configPath(dataDir), JSON.stringify(next, null, 2), 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写配置失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 巡检间隔（ms）。`dataDir` 给了才读用户配置；不给走环境变量/默认值。 */
export function patrolEveryMs(dataDir?: string): number {
  return Math.round(patrolHours(dataDir) * 3_600_000);
}

export function createDoctorPatrol(deps: DoctorPatrolDeps): DoctorPatrol {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const chunk = Math.max(1, deps.chunk ?? 64);
  const file = join(deps.dataDir, PATROL_FILE);

  /** 上一轮快照（**跨重启从磁盘读回**，见文件头 ①） */
  let prev: PatrolSnapshot | null = load();
  let last: PatrolSnapshot | null = prev;
  let lastDelta: PatrolDelta | null = null;
  let running = false;
  let runs = 0;
  let timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null = null;
  /** `#558` 生效中的间隔（ms）—— 启动时从配置读一次，设置页改了就重排 */
  let everyMs = patrolEveryMs(deps.dataDir);
  /** 定时是否已进入「按间隔循环」阶段（首轮的 setTimeout 不算） */
  let cycling = false;

  function load(): PatrolSnapshot | null {
    try {
      if (!existsSync(file)) return null;
      const j = JSON.parse(readFileSync(file, 'utf-8')) as PatrolSnapshot;
      // 形态校验：坏文件宁可当没有基线（⇒ 首轮重建），也不能让后面差分时炸
      if (!j || typeof j.at !== 'number' || !Array.isArray(j.issues)) return null;
      return j;
    } catch {
      return null;
    }
  }

  function save(s: PatrolSnapshot): void {
    try {
      if (!existsSync(deps.dataDir)) mkdirSync(deps.dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(s), 'utf-8');
    } catch (e) {
      // 落盘失败**必须可见**：否则「基线只存在内存」会退化成「每次重启都首轮 ⇒ 永远不播报」
      log(`巡检基线落盘失败（重启后会退化成首轮、不再播报）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * **在飞的那一轮**（重入 = 共享，不是各跑各的）。
   *
   * 为什么不能简单「running 时返回 last」：那样后来者拿到的是 **null（首轮）或上一轮的旧快照**，
   * 调用方（手动触发的路由）分不清「跑完了、结论是没有问题」和「还没跑完、这是旧数据」——
   * 那正是静默失败的形状。共享同一个 Promise ⇒ 并发调用都拿到**本轮**结果，且只跑一次。
   */
  let inflight: Promise<PatrolSnapshot | null> | null = null;

  function run(): Promise<PatrolSnapshot | null> {
    if (inflight) return inflight;
    inflight = runOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function runOnce(): Promise<PatrolSnapshot | null> {
    running = true;
    /** 墙钟起点（**真实时钟**：注入的 `now()` 在测试里是假时钟，不能拿它计时） */
    const wall0 = performance.now();
    try {
      const src = await deps.collect();
      const rows: PatrolRow[] = [];
      /**
       * 两种耗时必须分开记（**都用 `performance.now()`，不能用注入的 `now()`** ——
       * 测试注入的是假时钟，拿它计时会得到荒谬值）：
       *  · `cpuMs` = 纯计算耗时（各片累加）⇒ 巡检的**成本**；
       *  · `maxChunkMs` = 单片最长 ⇒ **会不会卡 UI** 的指标（分片后每次让出之间最多堵多久）。
       * 墙钟（含让出）会被「让出期间被别的请求占用」污染 —— 实测 501 源墙钟 1.4s，
       * 但那 1.4s 里大部分是**让给了别的任务**，不是堵着。只报墙钟会让人误判成「巡检卡了 1.4s」。
       */
      let cpuMs = 0;
      let maxChunkMs = 0;
      for (let i = 0; i < src.length; i += chunk) {
        const c0 = performance.now();
        for (const s of src.slice(i, i + chunk)) {
          rows.push({
            id: s.id,
            kind: s.kind,
            ...(s.name ? { name: s.name } : {}),
            // B2 摘要行直接复用子进程结果；B1 旧行（只有 raw/issues）仍由这里 lint
            lint: (s.lint ?? lintSource(s.raw ?? {}, sourceKindOf(s.raw ?? {}))) as PatrolRow['lint'],
            struct: (s.struct ?? s.issues ?? []) as PatrolRow['struct'],
          });
        }
        const c1 = performance.now();
        cpuMs += c1 - c0;
        if (c1 - c0 > maxChunkMs) maxChunkMs = c1 - c0;
        // 每片之间让出一次事件循环（让出本身是微秒级，换来「不退化成一次长停顿」）
        if (i + chunk < src.length) await new Promise<void>((r) => setImmediate(r));
      }
      const snap = buildSnapshot(rows, now(), Math.round(cpuMs));
      const delta = diffSnapshots(prev, snap);
      prev = snap;
      last = snap;
      lastDelta = delta;
      runs += 1;
      save(snap);
      // ★ 每轮都要留痕（可观测）：不弹 toast 的轮次也必须能从日志看出「跑过了、结论是什么」
      log(
        `巡检 #${runs}：${snap.sources} 源 · error ${snap.issues.length} 源/${snap.counts.error} 条` +
          ` · warn ${snap.warned.length} 源 · 新增 ${delta.added.length} · 恢复 ${delta.fixed.length}` +
          ` · 存量 ${delta.persisted.length}${delta.baseline ? ' · **首轮建基线，不播报**' : ''}` +
          ` · cpu ${snap.ms}ms / 单片最长 ${Math.round(maxChunkMs)}ms / 墙钟 ${Math.round(performance.now() - wall0)}ms`,
      );
      return snap;
    } catch (e) {
      log(`巡检失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      running = false;
    }
  }

  function view(since?: number): PatrolView {
    const at = last?.at ?? null;
    const fresh = at !== null && (since === undefined || since < at);
    return {
      at,
      fresh,
      running,
      runs,
      snapshot: last,
      delta: lastDelta,
      // 只有「有更新」才给 toast 文案 —— 前端按 `fresh` 走，避免同一条反复弹
      toast: fresh && lastDelta ? patrolToastText(lastDelta) : null,
      ...(patrolEnabled() ? {} : { disabled: true }),
    };
  }

  return {
    run,
    view,
    everyMs() {
      return everyMs;
    },
    /**
     * 改间隔：清掉现有循环、按新值重排。
     * ⚠️ 只重排 `setInterval` 那一段；首轮那个 `setTimeout` 若还在等，**不要**动它
     * （否则「设置页点一下保存」就等于把首轮巡检推迟一整个间隔）。
     */
    setEveryMs(ms?: number) {
      everyMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : patrolEveryMs(deps.dataDir);
      if (cycling && timer) {
        clearInterval(timer as ReturnType<typeof setInterval>);
        timer = setInterval(() => void run(), everyMs);
        (timer as ReturnType<typeof setInterval>).unref?.();
      }
      log(`巡检间隔已改为每 ${Math.round(everyMs / 3_600_000)}h 一轮`);
      return everyMs;
    },
    start() {
      if (!patrolEnabled()) {
        log('巡检已关闭（YUEDU_DOCTOR_PATROL=0）');
        return { stop() {} };
      }
      const tick = (): void => {
        void run();
      };
      timer = setTimeout(() => {
        tick();
        timer = setInterval(tick, everyMs);
        cycling = true;
        // `unref`：巡检是后台任务，不该因为它而让进程（或测试）退不出去
        (timer as ReturnType<typeof setInterval>).unref?.();
      }, patrolDelayMs());
      timer.unref?.();
      // 文案要区分「真首轮」与「有基线」：写错会让人以为基线没读回来（那等于每次重启都首轮 ⇒ 永不播报）
      log(
        `巡检已启动：${patrolDelayMs()}ms 后跑一轮（` +
          `${prev ? '与磁盘基线对比，只报新增' : '**首轮建基线，不播报**'}），` +
          `之后每 ${Math.round(everyMs / 3_600_000)}h 一轮`,
      );
      return {
        stop() {
          if (timer) clearTimeout(timer as ReturnType<typeof setTimeout>);
          if (timer) clearInterval(timer as ReturnType<typeof setInterval>);
          timer = null;
          cycling = false;
        },
      };
    },
    get ready() {
      return last !== null;
    },
  };
}
