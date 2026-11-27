/**
 * `#210` **定时更新书架**——Legado 的「书架后台更新章节」对齐物。
 *
 * ## 它干什么
 * 每隔 `intervalMin` 分钟，对书架里所有**在线书**（本地书 / 未收藏行 / 关了更新的除外）
 * 逐本重拉一次 `detail`（含目录），和书行上存的 `totalChapterNum` 对比：
 * - 变多了 ⇒ 记 `lastCheckCount`（本次新增几章）、刷新 `latestChapterTitle/Time` 与 `totalChapterNum`；
 * - 变少/相等 ⇒ 只刷新 `lastCheckTime`（表示「查过了」，不制造假更新）；
 * - 拉失败 ⇒ 该书打上 `BookType.updateError` 位（成功时清掉）——**别把失败伪装成「没有更新」**。
 *
 * ## 三个刻意决定（都写在对应位置，别「顺手优化」掉）
 * 1. **只更新书行字段，不写章节表**：统一模型的 `UnifiedChapter` 没有 `url`
 *    （只有引擎私有的 `payload`），而 `ShelfChapter` 的主键之一是 `url`——
 *    在没有定论「章节表为在线书服务什么」之前，先把数据写进**书行**（这正是书架界面要的），
 *    章节表留给阅读链路（阅读器现场拉目录 + IndexedDB 缓存）。
 * 2. **串行 + 间隔**：一次跑完一批书，一次只有一本在飞、本与本之间歇 300ms——
 *    这是对 `#200` 流量护栏的礼貌（护栏兜底是「不能超」，调度器自觉是「不该顶满」）。
 *    请求本身仍走 `detail` 池与全部护栏（超时/截断/熔断都生效）。
 * 3. **配置落 JSON 文件**（`data/shelf-update.json`），**同步写、立即落**：
 *    `#238` 的教训——KV 有 300ms 防抖，进程被杀就丢；配置文件写一次几十字节，不值得赌。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BookType, LOCAL_TAG } from '@yuedu/core';
import type { ShelfBook, UnifiedDetail } from '@yuedu/core';

/* ------------------------------------------------------------------ */
/* 纯函数（单测直接打这里，不碰网络与存储）                             */
/* ------------------------------------------------------------------ */

/** 更新配置（落盘形状） */
export interface ShelfUpdateConfig {
  /** 开关。默认 true —— 装了不更新的话这功能等于不存在；嫌吵可关 */
  enabled: boolean;
  /** 间隔分钟。默认 60；钳制 [5, 1440] */
  intervalMin: number;
}

export const DEFAULT_UPDATE_CONFIG: Readonly<ShelfUpdateConfig> = Object.freeze({ enabled: true, intervalMin: 60 });

/** 配置归一：脏数据回落默认值（文件被手改坏不能让调度器起不来） */
export function normalizeConfig(raw: unknown): { config: ShelfUpdateConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: ShelfUpdateConfig = { ...DEFAULT_UPDATE_CONFIG };
  if (raw !== null && typeof raw === 'object') {
    const src = raw as Record<string, unknown>;
    if (typeof src['enabled'] === 'boolean') config.enabled = src['enabled'];
    else if ('enabled' in src) warnings.push(`enabled 需要 true/false，读到 ${JSON.stringify(src['enabled'])} ⇒ 用默认值`);
    const n = Number(src['intervalMin']);
    if (Number.isFinite(n) && n > 0) {
      if (n < 5 || n > 1440) warnings.push(`intervalMin=${n} 超出 [5,1440] ⇒ 钳制到界内`);
      config.intervalMin = Math.min(1440, Math.max(5, Math.round(n)));
    } else if ('intervalMin' in src) {
      warnings.push(`intervalMin 需要>0 的数字，读到 ${JSON.stringify(src['intervalMin'])} ⇒ 用默认值`);
    }
  }
  return { config, warnings };
}

/** 一本书该不该被自动更新（Legado 语义：本地书/未收藏/手动关闭都不查） */
export function isUpdatableBook(b: ShelfBook): boolean {
  if (!b.bookUrl || !b.origin) return false;
  if (b.origin === LOCAL_TAG) return false; // 本地书没有「更新」概念
  if (b.canUpdate === false) return false; // 用户对这本书关了更新
  const t = b.type ?? 0;
  if (t & BookType.notShelf) return false; // 观影历史/临时阅读行不是书架成员
  if (t & (BookType.local | BookType.archive)) return false; // 与 LOCAL_TAG 双保险
  return true;
}

/** 一次对比的结论 */
export interface TocDiff {
  /** 相比旧记录新增的章数（负数按 0 记——目录变小多半是源抽风，不该显示「-3 章」） */
  added: number;
  /** 更新后的目录总长（0 = 目录没取到） */
  total: number;
  /** 最新一章标题（跳过卷名；取不到为 null） */
  latestTitle: string | null;
}

/** 目录对比（Legado：`lastCheckCount = 新目录长度 - 旧长度`，负数归 0） */
export function diffToc(oldCount: number, chapters: NonNullable<UnifiedDetail['chapters']>): TocDiff {
  const total = chapters.length;
  const added = Math.max(0, total - Math.max(0, oldCount));
  const lastReal = [...chapters].reverse().find((c) => !c.isVolume);
  return { added, total, latestTitle: lastReal?.title ?? null };
}

/**
 * 服务端书行的 `bookUrl` → 引擎 `detail` 动作的 `id`。
 *
 * ## 为什么需要（`#302`，2026-10-06 用户实测「定时更新整轮 14 本全失败」的根因之一）
 * 书架行的 `bookUrl` 不是引擎要的 id，而是前端同步来的**主键**：
 * `encodeItemKey(itemKey(sourceId, payload))`（见 `apps/web/src/utils/user-map.ts`）——
 * 形如 `https___…_josn_%00{"vod_id":"194493"}`（`%00` 是 itemKey 的 `\u0000` 分隔符的转义）。
 * 直接把它当 `id` 传给引擎：
 *  · maccms 引擎：`ids` 不是 `{` 开头 ⇒ 不走 JSON 解析分支 ⇒ 拿整串去拼 `ac=detail&ids=…`
 *    ⇒ 源返回空列表 ⇒ `SELECTOR_MISS@parse`（前端自己的「更新目录」没这问题，
 *       因为它传的是 `payload` 本体）；
 *  · legado 引擎：id 多了 `sourceId\u0000` 前缀，URL 对不上。
 *
 * 解法 = 与前端 `decodeItemKey` **同一套可逆转义**（先 `%00`→NUL 再 `%25`→`%`，
 * 顺序与 encode 相反）后取分隔符之后的 id 段：legado 书还原成真 bookUrl、
 * maccms 书还原成 `{"vod_id":…}`（引擎本就接受该 JSON 形态，见 engine-maccms `detail()`）。
 * 没有 NUL 分隔符的（历史裸 URL 行）原样返回。
 */
export function detailIdFromBookUrl(bookUrl: string): string {
  const s = bookUrl.split('%00').join('\u0000').split('%25').join('%');
  const i = s.indexOf('\u0000');
  return i >= 0 ? s.slice(i + 1) : s;
}

/* ------------------------------------------------------------------ */
/* 运行体（依赖注入：存储与 hub 都在 index.ts 里，这里不 import 单例）   */
/* ------------------------------------------------------------------ */

/** 每本书的更新结果（给界面表格） */
export interface BookUpdateResult {
  name: string;
  /** ok=查到了目录；fail=这一本拉失败 */
  status: 'ok' | 'fail' | 'skip';
  oldCount: number;
  newCount: number;
  added: number;
  /** 失败原因（status=fail 时） */
  error?: string;
}

export interface ShelfUpdateStatus {
  config: ShelfUpdateConfig;
  running: boolean;
  /** 上次整轮跑完的时间（null=还没跑过） */
  lastRunAt: string | null;
  lastDurationMs: number | null;
  /** 下次自动跑的时间（enabled=false 时为 null） */
  nextRunAt: string | null;
  /** 上次一轮里「有新增」的书本书名（最多列 8 本） */
  updatedNames: string[];
  /** 最近 N 本的结果（最新的在前） */
  results: BookUpdateResult[];
  /** 上次整轮的失败概要（连续失败要在界面上看得见） */
  lastError: string | null;
  /** 本轮进度（running 时）：第几本 / 共几本 */
  progress: { done: number; total: number } | null;
}

/** 调度器依赖 */
export interface ShelfUpdaterDeps {
  /** 数据目录（配置文件与告警都落这） */
  dataDir: string;
  listBooks(): Promise<ShelfBook[]>;
  saveBook(b: Partial<ShelfBook> & { bookUrl: string }): Promise<void>;
  /** 拉 detail（index.ts 里包一层 hub.run，护栏/池/trace 都在那层生效） */
  fetchDetail(sourceId: string, bookUrl: string): Promise<UnifiedDetail>;
  /** 连续失败升级为崩溃留痕 */
  recordCrash(message: string): void;
  now?(): number;
  /** 本与本之间的歇息毫秒（测试传 0） */
  gapMs?: number;
}

export class ShelfUpdater {
  private cfg: ShelfUpdateConfig = { ...DEFAULT_UPDATE_CONFIG };
  private timer: NodeJS.Timeout | null = null;
  private runningFlag = false;
  private lastRunAtMs: number | null = null;
  private lastDurationMs: number | null = null;
  private lastError: string | null = null;
  private results: BookUpdateResult[] = [];
  private updatedNames: string[] = [];
  private progress: { done: number; total: number } | null = null;
  private readonly gap: number;

  constructor(private readonly deps: ShelfUpdaterDeps) {
    this.gap = deps.gapMs ?? 300;
  }

  /* ---------- 配置 ---------- */

  /** 读配置文件（不存在/坏行回落默认值并告警） */
  loadConfig(): { config: ShelfUpdateConfig; warnings: string[] } {
    const file = path.join(this.deps.dataDir, 'shelf-update.json');
    let raw: unknown = undefined;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* 没有文件 = 首跑，用默认值 */
    }
    const { config, warnings } = normalizeConfig(raw);
    this.cfg = config;
    this.restartTimer();
    return { config: { ...config }, warnings };
  }

  setConfig(patch: { enabled?: boolean; intervalMin?: number }): { config: ShelfUpdateConfig; warnings: string[] } {
    const { config, warnings } = normalizeConfig({ ...this.cfg, ...patch });
    this.cfg = config;
    const file = path.join(this.deps.dataDir, 'shelf-update.json');
    try {
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    } catch (e) {
      warnings.push(`配置写入失败（仍对本次生效，重启后回落默认）：${String(e instanceof Error ? e.message : e)}`);
    }
    this.restartTimer();
    return { config: { ...config }, warnings };
  }

  /** 下次自动跑的时间（ms）；关着或还没基准时为 null */
  private nextRunMs(): number | null {
    if (!this.cfg.enabled) return null;
    if (this.lastRunAtMs === null) return null; // 还没跑过 ⇒ 起个随机相位见 restartTimer
    return this.lastRunAtMs + this.cfg.intervalMin * 60_000;
  }

  /**
   * 60s 一跳的懒时钟：到点才跑，而不是 setTimeout(interval) 精确排程——
   * 改间隔/开关只需要重启这一个 timer，语义简单到不会写错。
   * 没跑过首轮时（刚启动）首个滴答就跑 ⇒ 服务起来约 1 分钟内书架就有新鲜度，
   * 也免掉「随机相位」这种把伪造时间写进 lastRunAt 的把戏——状态必须只报告真跑过的时刻。
   */
  private restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.cfg.enabled || this.runningFlag) return;
      const now = this.deps.now?.() ?? Date.now();
      if (this.lastRunAtMs === null || now - this.lastRunAtMs >= this.cfg.intervalMin * 60_000) {
        void this.runPass('auto');
      }
    }, 60_000);
    this.timer.unref();
  }

  /* ---------- 一轮更新 ---------- */

  /** 跑一轮（手动触发 / 定时到点共用）。已有一轮在跑时返回 false。 */
  async runPass(_trigger: 'auto' | 'manual'): Promise<boolean> {
    if (this.runningFlag) return false;
    this.runningFlag = true;
    const t0 = this.deps.now?.() ?? Date.now();
    this.lastError = null;
    this.updatedNames = [];
    try {
      const all = await this.deps.listBooks();
      const books = all.filter(isUpdatableBook);
      this.progress = { done: 0, total: books.length };
      const results: BookUpdateResult[] = [];
      for (const b of books) {
        const r = await this.updateOne(b);
        results.push(r);
        this.progress = { done: this.progress.done + 1, total: books.length };
        if (r.status === 'ok' && r.added > 0) {
          this.updatedNames.push(r.name);
          if (this.updatedNames.length >= 8) break; // 名单只列前 8 本，循环照跑
        }
        if (this.gap > 0) await new Promise((res) => setTimeout(res, this.gap));
      }
      this.results = results.reverse().slice(0, 200); // 表格只留最近 200 条
      this.lastRunAtMs = t0;
      this.lastDurationMs = (this.deps.now?.() ?? Date.now()) - t0;
      const failed = results.filter((r) => r.status === 'fail');
      if (failed.length === books.length && books.length > 0) {
        // 一整轮全挂 ⇒ 大概率是网络/服务侧问题，升级留痕（别只在表格里静默躺平）
        this.lastError = `整轮 ${books.length} 本全部失败，示例：${failed[0]?.name} ${failed[0]?.error ?? ''}`;
        this.deps.recordCrash(`[shelf-update] ${this.lastError}`);
      } else if (failed.length > 0) {
        this.lastError = `${failed.length}/${books.length} 本失败（详情见表格）`;
      }
      return true;
    } catch (e) {
      this.lastError = String(e instanceof Error ? e.message : e);
      this.deps.recordCrash(`[shelf-update] 整轮异常：${this.lastError}`);
      return false;
    } finally {
      this.runningFlag = false;
      this.progress = null;
    }
  }

  /** 更新一本。失败打 updateError 位；成功清掉（Legado 同语义）。 */
  private async updateOne(b: ShelfBook): Promise<BookUpdateResult> {
    const name = b.name || b.bookUrl;
    const oldCount = Math.max(0, b.totalChapterNum ?? 0);
    try {
      const d = await this.deps.fetchDetail(b.origin, b.bookUrl);
      if (!d.chapters || d.chapters.length === 0) {
        const why = d.tocError ?? '目录为空';
        await this.deps.saveBook({ bookUrl: b.bookUrl, type: (b.type ?? 0) | BookType.updateError });
        return { name, status: 'fail', oldCount, newCount: 0, added: 0, error: why };
      }
      const { added, total, latestTitle } = diffToc(oldCount, d.chapters);
      const patch: Partial<ShelfBook> & { bookUrl: string } = {
        bookUrl: b.bookUrl,
        totalChapterNum: total,
        lastCheckTime: Date.now(),
        lastCheckCount: added,
        type: (b.type ?? 0) & ~BookType.updateError, // 成功 ⇒ 清失败位
      };
      if (added > 0) {
        patch.latestChapterTitle = latestTitle;
        patch.latestChapterTime = Date.now();
      }
      await this.deps.saveBook(patch);
      return { name, status: 'ok', oldCount, newCount: total, added };
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
      try {
        await this.deps.saveBook({ bookUrl: b.bookUrl, type: (b.type ?? 0) | BookType.updateError });
      } catch {
        /* 存储也挂了：让外层整轮 catch 兜 */
      }
      return { name, status: 'fail', oldCount, newCount: 0, added: 0, error: msg };
    }
  }

  /* ---------- 状态 ---------- */

  status(): ShelfUpdateStatus {
    return {
      config: { ...this.cfg },
      running: this.runningFlag,
      lastRunAt: this.lastRunAtMs === null ? null : new Date(this.lastRunAtMs).toISOString(),
      lastDurationMs: this.lastDurationMs,
      nextRunAt: this.nextRunMs() === null ? null : new Date(this.nextRunMs()!).toISOString(),
      updatedNames: [...this.updatedNames],
      results: this.results.slice(0, 50),
      lastError: this.lastError,
      progress: this.progress ? { ...this.progress } : null,
    };
  }
}
