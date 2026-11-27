/**
 * 用户**全局净化（替换）规则**（`#144`）。
 *
 * ## 上游对应关系
 * 实体 `ReplaceRule`（`ReplaceRule.kt:26-65`，本仓契约已对齐）、表 `replace_rules`；
 * 本仓的服务端端点 `GET/PUT/DELETE /api/user/replace-rules` 与客户端封装 `user-data.ts`
 * **早就封好了**，但此前**前端没有任何界面、引擎侧也没有任何应用点**（`useReplaceRule`
 * 这个字段全仓无人读）⇒ `#144` 要做的就是「把功能接上」，不是再做一遍迁移。
 *
 * ## 应用语义（**都在 `utils/replace-rules.ts`，本文件只负责取数与编排**）
 * 展示时应用（不是入库时）⇒ **离线缓存存的必须是原文**，否则关掉规则后缓存里仍是净化过的。
 *
 * ## 覆盖范围（**刻意不做满，写明理由**）
 * - ✅ 阅读界面的**正文**与**章节标题**（上游 `ContentProcessor.getContent` / `getDisplayTitle`）；
 * - ⏸ **目录列表的标题不净化** —— 上游 `ChapterListAdapter` 用的就是 `chapter.title` 原值
 *   （`getDisplayTitle()` 的调用点：阅读界面 / 书架「继续阅读」/ 导出 / 朗读，见 `BookChapter.kt:124`）；
 * - ⏸ `scopeSource`（手动校正源）与 `BookReadConfig.manualReplaceRuleIds`（手动挑选规则）
 *   均未做 —— 它们依赖「源内容编辑」那一块界面，本仓尚未有对应功能。
 *
 * ## 同步（阶段 1.4 统一策略，`utils/server-sync.ts`）
 * 规则是**低频、少量**（几十条）⇒ 推送走 **`reconcile`（全量对齐）**，不用 `pushDiff`。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { dedupeReplaceRules, type ReplaceRule } from '@yuedu/core/contract';

import {
  deleteReplaceRule as deleteRemote,
  listReplaceRules as listRemote,
  putReplaceRule as putRemote,
} from '../user-data';
import {
  type SyncPlan,
  type SyncSource,
  pull as pullEntity,
  readLocal,
  reconcile as reconcileEntity,
  registerSyncTarget,
  writeLocal,
} from '../utils/server-sync';
import {
  applyReplaceRules, effectiveRules, useReplaceRuleFor,
  manualReplaceSets, manualCandidates, type ManualReplaceSets,
} from '../utils/replace-rules';

const RULES_KEY = 'yuedu-replace-rules';
const RULES_PENDING_KEY = 'yuedu-replace-rules-pending';

/** 应用规则时要知道的「这本书是谁」 */
export interface ReplaceBookCtx {
  /** 书名（上游 `book.name`） */
  name: string;
  /** 来源（上游 `book.origin`；本仓 = `sourceId`） */
  origin: string;
  /** 本书自己的开关（`BookReadConfig.useReplaceRule`；null = 跟随全局） */
  useReplaceRule?: boolean | null;
  /** 图片书源默认关闭净化（上游 `Book.getUseReplaceRule()`） */
  isImage?: boolean;
  /**
   * `#261` **手动规则集**：本书勾中的规则 id（`BookReadConfig.manualReplaceRuleIds`）。
   * 只在**全局手动模式**打开时才起作用（见 `manualMode`）；非空即接管 ⇒ 全局规则一条都不跑。
   */
  manualRuleIds?: number[] | null;
  /** `#261` 全局手动模式开关（`GlobalReaderPrefs.manualReplaceRuleEnabled`）。 */
  manualMode?: boolean;
}

/** `#257`：`@js:` 脚本的 `chapter` / `book` 绑定（上游 `RegexExtensions.replace(…, chapter, replaceBook)`） */
export interface ReplaceJsContext {
  chapter?: unknown;
  book?: unknown;
}

const emptyRule = (): ReplaceRule => ({
  id: Date.now(),
  name: '',
  group: null,
  pattern: '',
  replacement: '',
  scope: null,
  scopeTitle: false,
  scopeSource: false,
  scopeContent: true,
  excludeScope: null,
  isEnabled: true,
  isRegex: true,
  timeoutMillisecond: 3000,
  order: 0,
});

export const useReplaceRulesStore = defineStore('replaceRules', () => {
  const rules = ref<ReplaceRule[]>([]);

  const PLAN: SyncPlan<ReplaceRule> = {
    localKey: RULES_KEY,
    pendingKey: RULES_PENDING_KEY,
    list: async () => (await listRemote()) as ReplaceRule[],
    put: (r) => putRemote(r as never),
    remove: (id) => deleteRemote(id),
    toRemote: (r) => ({ ...r }) as unknown as Record<string, unknown>,
    idOf: (r) => String(r.id),
  };

  registerSyncTarget({
    localKey: RULES_KEY,
    pendingKey: RULES_PENDING_KEY,
    label: '净化规则',
    resync: () => reconcileEntity(PLAN, rules.value),
  });

  /** 写盘：先本地（服务端没起也能用），再推服务端 */
  function save(): void {
    writeLocal(RULES_KEY, rules.value);
    void reconcileEntity(PLAN, rules.value)
      .then((r) => {
        if (r.offline) {
          console.warn('[replace-rules] 已存本地，服务端不可达 ⇒ 标记 pendingSync，下次启动重传');
        }
      })
      .catch((e) => console.warn('[replace-rules] 推送服务端失败（本地已保存，数据未丢）：', e));
  }

  /** 启动时与服务端对齐（阶段 1.4 策略：服务端非空 ⇒ 服务端为准） */
  async function hydrate(): Promise<SyncSource> {
    // `#191`：合并语义 ⇒ 一端新增的净化规则不会被另一端（或另一个 origin）的对齐清掉
    const r = await pullEntity(PLAN, rules.value, { mergeLocal: true });
    if (r.items) {
      // ★ `#266` 追加（用户 2026-10-04「先把现有库去重」）：合并结果可能仍含重复
      //   （历史导入的两批同内容规则 id 不同 ⇒ 合并按 id 判「独有」拦不住）。
      //   在**写权威**这一侧按 `name+pattern` 去重：本地不再持有 ⇒ 下一次 reconcile
      //   会把服务端那几条多余的也删掉；只删服务端则会被 localStorage 复活。
      const d = dedupeReplaceRules(r.items);
      // ★ 先落数据再推送：reconcile 拿的必须是**去重后**的列表（第一版在赋值前调，
      //   传成合并前的旧列表 ⇒ 把刚删的重复条目又 PUT 回去了）
      rules.value = d.rules;
      writeLocal(RULES_KEY, rules.value);
      if (d.removed.length) {
        console.warn(`[replace-rules] 启动去重：移除 ${d.removed.length} 条重复规则`,
          d.removed.map((x) => `${x.name || '(未命名)'}#${x.id}`));
        // ★ 立即把去重结果全量对齐回服务端（reconcile 会删掉服务端那些多余条目）——
        //   不推的话本地界面虽是干净的，服务端 DB 仍是 102 条，下次启动再走一遍去重。
        void reconcileEntity(PLAN, rules.value)
          .then((x) => { if (x.offline) console.warn('[replace-rules] 去重结果暂存本地（服务端不可达）'); })
          .catch((e) => console.warn('[replace-rules] 去重结果推送失败（本地已保存）：', e));
      }
    }
    return r.source;
  }

  /** 首次进入前调用一次（同步 `hydrate` 之外的场景，如设置页打开时才拉） */
  function ensureLoaded(): void {
    if (!rules.value.length) rules.value = readLocal<ReplaceRule>(RULES_KEY);
    // ★ `#266` 追加：本地缓存也可能带着历史重复（去重前的快照）⇒ 展示层先去重；
    //   不在这里推送 —— hydrate / 下一次 save 的 reconcile 会把服务端对齐掉。
    const d = dedupeReplaceRules(rules.value);
    if (d.removed.length) rules.value = d.rules;
  }

  /** 按 `order` 排好（管理页与规则应用共用同一顺序 —— 两处顺序不一致是「看起来没生效」的经典来源） */
  const sorted = computed(() => rules.value.slice().sort((a, b) => a.order - b.order || a.id - b.id));

  /** 全部用到的分组名（管理页的分组筛选；上游 `ReplaceRuleDao.allGroupsUnProcessed`） */
  const groupNames = computed(() =>
    [...new Set(rules.value.map((r) => (r.group ?? '').trim()).filter((g) => g !== ''))].sort(),
  );

  function upsert(r: ReplaceRule): void {
    const i = rules.value.findIndex((x) => x.id === r.id);
    if (i >= 0) rules.value[i] = { ...r };
    else rules.value.push({ ...r });
    save();
  }

  /**
   * `#266` 批量 upsert：**只落一次盘**（逐条 `upsert` 会触发 N 次 reconcile 全量对齐 ——
   * 导入 50 条就是 50 次网络推送）。内存语义与逐条 upsert 完全一致。
   */
  function upsertMany(list: ReplaceRule[]): void {
    for (const r of list) {
      const i = rules.value.findIndex((x) => x.id === r.id);
      if (i >= 0) rules.value[i] = { ...r };
      else rules.value.push({ ...r });
    }
    if (list.length) save();
  }

  function newRule(): ReplaceRule {
    /** 新规则排最后（`order` 取当前最大值 + 1；上游默认 `Int.MIN_VALUE`，那条会被排到最前） */
    const maxOrder = rules.value.reduce((m, r) => Math.max(m, r.order), 0);
    return { ...emptyRule(), order: maxOrder + 1 };
  }

  function remove(id: number): void {
    rules.value = rules.value.filter((r) => r.id !== id);
    save();
  }

  /**
   * `#271` 批量删除所选：**只落一次盘**（逐条 `remove` 会触发 N 次 reconcile 全量对齐）。
   * 内存语义与逐条 remove 完全一致。
   */
  function removeMany(ids: readonly number[]): void {
    if (!ids.length) return;
    const s = new Set(ids);
    rules.value = rules.value.filter((r) => !s.has(r.id));
    save();
  }

  function toggle(id: number): void {
    const r = rules.value.find((x) => x.id === id);
    if (!r) return;
    upsert({ ...r, isEnabled: !r.isEnabled });
  }

  /* ---------------- 应用 ---------------- */

  /**
   * 这本书**要不要**跑净化规则。
   *
   * @param globalDefault 全局默认（契约 `GlobalReaderPrefs.replaceEnableDefault`，
   *                      上游 `AppConfig.kt:680`，默认 **true**）—— 由调用方从 prefs 传入，
   *                      **不要**在这里再去读一次（避免两处来源不一致）。
   */
  /**
   * `#261` 这本书**本次**用哪套规则 + 到底跑不跑。
   *
   * ★ 优先级（照抄上游 `ReadBook.kt:1270-1289`）：
   *   全局手动模式 **且** 本书勾了规则 ⇒ **手动集接管**：
   *   · 跑不跑 = 手动集非空（书的 `useReplaceRule` 与全局 `replaceEnableDefault` **都失效**）；
   *   · 用哪些 = 手动集（**按 id** 取 ⇒ 无视 `isEnabled` / `scope`，只按 scopeTitle/scopeContent 分流）；
   *   否则 ⇒ 老路径（全局规则 + scope 匹配 + 本书开关/全局默认三分支）。
   */
  function planFor(book: ReplaceBookCtx, globalDefault: boolean): {
    enabled: boolean;
    manual: ManualReplaceSets | null;
  } {
    const ids = book.manualRuleIds ?? null;
    if (book.manualMode && ids && ids.length) {
      const manual = manualReplaceSets(rules.value, ids);
      return { enabled: manual.enabled, manual };
    }
    return { enabled: useReplaceRuleFor(book, globalDefault), manual: null };
  }

  function enabledFor(book: ReplaceBookCtx, globalDefault: boolean): boolean {
    return planFor(book, globalDefault).enabled;
  }

  /**
   * 净化**正文**（段落数组）。
   *
   * ⚠️ 为什么在这里把段落拼回一整段再替换：上游替换是**在整章文本上**跑的
   * （`ContentProcessor.kt:172-207`），跨段落的正则（比如「广告段 + 空行」）才有意义；
   * 逐段跑会把这类规则切成两半 ⇒ 命中不了。
   *
   * ★ `#260`：返回值带上 `used`（**真正改动了正文的**规则 id）——
   * 上游 `BookContent.effectiveReplaceRules` 就是它，「起效的替换规则」列表读这个，
   * 而**不是**读「被选中的规则」（两者差别很大：一条选中的规则可以一点都没匹配上）。
   */
  function applyContent(
    paragraphs: string[],
    book: ReplaceBookCtx,
    globalDefault: boolean,
    js?: ReplaceJsContext,
  ): { paragraphs: string[]; used: number[] } {
    const plan = planFor(book, globalDefault);
    if (!plan.enabled) return { paragraphs, used: [] };
    // ★ `#261`：手动集非空 ⇒ **只跑手动集**（全局规则一条都不跑）
    const rs = plan.manual ? plan.manual.content : effectiveRules(rules.value, 'content', { name: book.name, origin: book.origin });
    if (!rs.length) return { paragraphs, used: [] };
    const joined = paragraphs.join('\n');
    const { text, used } = applyReplaceRules(joined, rs, {
      trimLines: true,
      chapter: js?.chapter,
      book: js?.book,
    });
    return { paragraphs: text.split('\n'), used };
  }

  /** 净化**章节标题**（`keepNonEmpty`：被整条规则清空时保留原标题，照抄上游） */
  function applyTitle(
    title: string,
    book: ReplaceBookCtx,
    globalDefault: boolean,
    js?: ReplaceJsContext,
  ): { title: string; used: number[] } {
    const plan = planFor(book, globalDefault);
    if (!plan.enabled) return { title, used: [] };
    const rs = plan.manual ? plan.manual.title : effectiveRules(rules.value, 'title', { name: book.name, origin: book.origin });
    if (!rs.length) return { title, used: [] };
    const r = applyReplaceRules(title, rs, {
      keepNonEmpty: true,
      chapter: js?.chapter,
      book: js?.book,
    });
    return { title: r.text, used: r.used };
  }

  return {
    rules,
    sorted,
    groupNames,
    hydrate,
    ensureLoaded,
    upsert,
    upsertMany,
    newRule,
    remove,
    removeMany,
    toggle,
    // `#261` 手动规则集：候选列表（排除纯源规则，不排除已停用）—— 对**当前库**求值
    manualCandidates: () => manualCandidates(rules.value),
    manualSets: (ids: readonly number[]) => manualReplaceSets(rules.value, ids),
    enabledFor,
    applyContent,
    applyTitle,
  };
});
