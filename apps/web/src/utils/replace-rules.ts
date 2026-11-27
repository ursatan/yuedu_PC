/**
 * 用户**全局净化（替换）规则**的应用内核 —— 纯函数，不碰 DOM / store，可单测。
 *
 * ## 上游语义（逐条核实，勿凭印象改）
 * 实体 `ReplaceRule.kt:26-65`（**主构造器 14 字段**）；应用点 `ContentProcessor.getContent()`
 * （`ContentProcessor.kt:101-237`）；作用域查询 `ReplaceRuleDao.findEnabledByContentScope` /
 * `findEnabledByTitleScope`（`ReplaceRuleDao.kt:104-133`）；正则替换 `RegexExtensions.kt:28-96`。
 *
 * ① **应用时机**：**展示时**，不是入库时（上游 `BookHelp` 存的也是原文）。
 *    ⇒ 本仓同样在 `openChapter` 拿到正文后、写进 `chapter.value` 前应用；
 *    **离线缓存存的必须是原文**（否则关掉规则后缓存里仍是净化过的）。
 * ② **顺序**：按 `order`（列名 `sortOrder`）**升序**；`pattern` 为空的规则跳过。
 * ③ **作用范围**：`scopeContent` → 正文；`scopeTitle` → 标题；`scopeSource` → 书源（本仓未做手动校正源）。
 * ④ **匹配口径**（照抄 DAO 的 SQL）：
 *    `scope` 为空/null ⇒ **匹配所有书**；否则 `scope` 里**包含**书名 **或** 包含来源（origin）即命中；
 *    `excludeScope` 命中书名/来源 ⇒ **排除**（null 与空串都不排除）。
 * ⑤ **替换**：`isRegex` ⇒ 正则（**替换全部匹配**）；否则**字面**全替换。
 *    ★★ **替换串的组引用语义走 `js-replace.ts` 的 `expandJavaReplacement`（= Java `Matcher.appendReplacement`）**，
 *    **不能**直接把它交给 JS 的 `String.replace`（两套语法不一样，见下面「已知差异」）。
 * ⑥ 上游还会**逐行 trim** 正文（`ContentProcessor.kt:175`），但**只在启用替换时**做 —— 照抄。
 *
 * ## 本仓的**已知差异**（刻意，不是漏项，都留痕）
 * - ★ `#252` 起**正则走 `utils/regex-android.ts` 折算**（这是修「正文被截断」的关键）：
 *   Android/ICU 的 `\w`/`\d`/`\s` 是 **Unicode 感知**的（`\w` 含中文！），JS 恒为 ASCII
 *   ⇒ 直接用 `new RegExp(pattern)` 会让 `[^\w…]+` 这类「吃标点」的规则**反向命中**、吞掉整章正文
 *   （用户实测《病宠成瘾》第 9 章 1089 字只剩 120 字）。折算后 44 条规则全部可用。
 * - ★★ `#257` 起 **`@js:` 替换已实现**（`utils/js-replace.ts`）；`isRegex=false` 的规则**不求值 JS**
 *   （上游 `ContentProcessor.kt:190` 走的是字面 `String.replace`，`@js:...` 会被**原样插进正文** ——
 *   照抄，另加 `warnOnce` 提醒；用户库里没有这种规则）。
 * - ★★ **替换串的组引用改成「Java/Android 语义」**（`#257`，此前用 JS 的 `String.replace`）：
 *   · `$0` = **整个匹配** —— **JS 不认 `$0`**（会原样输出 `$0`）。用户库里 `'#26 拆分🔻段落'`（**启用中**）
 *     就是 `replacement = '$0\n'` ⇒ 此前会把匹配到的原文换成字面量 `$0`，**这是一条真缺陷**；
 *   · `${name}` = 命名分组（JS 的写法是 `$<name>`，两套不通用）；
 *   · `$$` / `$&` ⇒ **报错**（Java 抛 `Illegal group reference`）⇒ 该规则本次跳过并留痕
 *     （JS 里 `$$` 是转义、`$&` 是整段匹配 ⇒ 两者行为在源里根本不存在，**不能**沿用）；
 *   · **分组未参与匹配 ⇒ 插字面量 `null`**：Android 的 `appendReplacement` 直接 `append(group())`，
 *     而 `group()` 未参与时是 `null`；OpenJDK 有 `start()!=-1` 保护，什么都不加。
 *     **Legado 跑在 Android 上 ⇒ 对齐 Android**（依据与影响面实测见 `js-replace.ts` 的 `NULL_GROUP`）。
 * - ★★ `#259` 起 **`\b` / `\B` 已按 ICU 折算成 Unicode 词边界**（`utils/regex-android.ts`
 *   的 `UNI_WORD_BOUNDARY` / `UNI_NON_WORD_BOUNDARY`）。JS 的 `\b` 恒为 ASCII，而 ICU 的 `\b`
 *   **跟着 `\w` 走**（该文件里列了三条独立证据）⇒ 不折算的后果不是「轻微偏差」，而是**行为相反**：
 *   ★ 实测（2026-10-04，用户库共 102 条规则）**46 条**含 `\b`/`\B`，其中 `#19 拆分🔺长句` /
 *   `#25 拆分🔺长句` 各含 **60~70 处** `，\b`（「拆分长句」的核心形态），在 JS ASCII 语义下
 *   **一处都匹配不到** ⇒ 等同于那两条规则**失效**。真数据 A/B（`scripts/probe-259-word-boundary.mts`）：
 *   折算后 `#19` 命中 0→4、`#25` 0→6、`#26 拆分🔻段落` 1→21，且**没有一条规则命中变少**。
 *   偏差方向是「**该匹配的没匹配到**」（**不会吞字** —— 吞字是 `#252` 的 `\w` 问题）。
 *   代价：折算把 `\b` 展开成零宽断言，规则耗时约为原来的 2~5 倍（实测每 3000 字一章约 +120ms）。
 * - **超时中断未实现**：上游用协程 `select/onTimeout` 中断灾难性正则（`RegexTimeoutException`）
 *   并在超时后**自动禁用该规则**（`ContentProcessor.kt:197-200`）。JS 是单线程、
 *   正则执行无法中断 ⇒ 本仓**做不到**。折中两层：① 替换**完成后**测耗时，超过规则自己的
 *   `timeoutMillisecond` 就 `warnOnce` 留痕（**不自动禁用**）；
 *   ② `#252` 加了**灾难性删除护栏** —— 单条规则删掉 >50% 且 >200 字时本次不采用并留痕
 *   （上游靠超时兜底，本仓没有中断能力 ⇒ 只能按「后果」兜底，且必须留痕）。
 *   ⚠️ `#257` 的 `@js:` 脚本同理**中断不了**（用户脚本里若有死循环，页面会卡住）。
 */
/**
 * ⚠️ **必须走 `@yuedu/core/contract`（契约子路径），不能用根出口 `@yuedu/core`**（踩过：2026-09-30
 * 构建直接失败）：根出口是 `export *`，会连带 `user-store` / `dom` ⇒ 那些模块 import 了
 * `node:fs` / `jsdom` ⇒ Vite 报「"readFileSync" is not exported by "__vite-browser-external"」。
 * 契约出口只允许 `import type` + 纯函数 ⇒ 浏览器可打包（详见 `contract/index.ts` 文件头）。
 */
import type { ReplaceRule } from '@yuedu/core/contract';
import { replaceRuleTimeout } from '@yuedu/core/contract';
import { compileRuleRegex } from './regex-android';
import {
  createJsEvaluator,
  expandJavaReplacement,
  isJsReplacement,
  jsScriptOf,
  parseReplaceCallbackArgs,
} from './js-replace';
import { warnOnce } from './warn-once';

/** 规则作用的**目标书**（上游 `findEnabledByContentScope(name, origin)` 的两个参数） */
export interface ReplaceTarget {
  /** 书名（上游 `book.name`） */
  name: string;
  /** 来源（上游 `book.origin`；本仓 = `sourceId`） */
  origin: string;
}

/** 规则被应用在哪一类文本上（上游 `scopeContent` / `scopeTitle` / `scopeSource`） */
export type ReplaceScope = 'content' | 'title' | 'source';

function includes(haystack: string | null | undefined, needle: string): boolean {
  /**
   * ⚠️ 空 `needle` 会命中一切（`LIKE '%%'`）—— **这是上游行为，照抄**。
   * 影响：书名为空时，任何非空 `scope` 的规则都会命中。上游如此，别「顺手修好」。
   */
  if (!haystack) return false;
  if (!needle) return true;
  return haystack.includes(needle);
}

/**
 * 挑出**对这本书生效**的规则（照抄 DAO 的 WHERE）。
 *
 * @param kind 'content' 用 `scopeContent` / 'title' 用 `scopeTitle` / 'source' 用 `scopeSource`
 *             （'source' 不看 scope，上游 `findEnabledBySourceScope` 只按 `isEnabled + scopeSource`）
 */
export function effectiveRules(rules: ReplaceRule[], kind: ReplaceScope, t: ReplaceTarget): ReplaceRule[] {
  return rules
    .filter((r) => {
      if (!r.isEnabled) return false;
      if (kind === 'content' && !r.scopeContent) return false;
      if (kind === 'title' && !r.scopeTitle) return false;
      if (kind === 'source' && !r.scopeSource) return false;
      // 'source' 类不看 scope / excludeScope（上游 SQL 里确实没有这两个条件）
      if (kind === 'source') return true;
      const scoped = !r.scope || includes(r.scope, t.name) || includes(r.scope, t.origin);
      if (!scoped) return false;
      return !includes(r.excludeScope, t.name) && !includes(r.excludeScope, t.origin);
    })
    .sort((a, b) => a.order - b.order || a.id - b.id);
}

/**
 * `#261` **手动规则集**（上游 `ReadBook.manualReplaceRules` / `ReplaceRuleDao.findByIds`）。
 *
 * ★ 语义与「全局规则 + scope 匹配」**完全不同**，逐条照抄上游（不是本仓发明）：
 * ① **只按 id 取** ⇒ **无视 `isEnabled`**（停用的规则照样跑）、**无视 `scope`/`excludeScope`**
 *    （不再按书名/来源筛选）；
 * ② 仍按 `scopeTitle` / `scopeContent` 分流到标题 / 正文 —— 这是**唯一**还生效的两个开关；
 * ③ `enabled = title.length || content.length` ⇒ 勾了至少一条，替换就**强制开启**
 *    （书的 `useReplaceRule` 与全局 `replaceEnableDefault` **都失效**）；
 * ④ 手动集非空 ⇒ **全局规则一条都不跑**（上游 `ReadBook.kt:1270-1289`）。
 *
 * ⚠️ 为什么 ①② 这么反直觉还要照抄：这是上游现状，用户从 Legado 带过来的配置就是这么用的；
 *   本仓不发明新语义，但**界面上必须写清**（否则用户会觉得「停用/作用范围怎么不生效」）。
 */
export interface ManualReplaceSets {
  title: ReplaceRule[];
  content: ReplaceRule[];
  /** 该不该跑替换（≠ 书的开关、≠ 全局默认 —— 手动集一旦非空就恒为 true） */
  enabled: boolean;
}

export function manualReplaceSets(rules: readonly ReplaceRule[], ids: readonly number[]): ManualReplaceSets {
  const want = new Set(ids);
  const title: ReplaceRule[] = [];
  const content: ReplaceRule[] = [];
  for (const r of rules) {
    if (!want.has(r.id)) continue;
    if (r.scopeTitle) title.push(r);
    if (r.scopeContent) content.push(r);
  }
  const byOrder = (a: ReplaceRule, b: ReplaceRule) => a.order - b.order || a.id - b.id;
  title.sort(byOrder);
  content.sort(byOrder);
  return { title, content, enabled: title.length > 0 || content.length > 0 };
}

/**
 * 手动规则集对话框的**候选列表**（上游 `ReplaceRuleDao.findManualCandidates`）：
 * 全部规则里**只排除「纯书源规则」**（`scopeSource=1 且 scopeTitle=0 且 scopeContent=0`）。
 * ⚠️ **不排除 `isEnabled=0`** ⇒ 用户能选中「已停用」的规则并用它（上游现状，界面写明）。
 */
export function manualCandidates(rules: readonly ReplaceRule[]): ReplaceRule[] {
  return rules
    .filter((r) => !(r.scopeSource && !r.scopeTitle && !r.scopeContent))
    .sort((a, b) => a.order - b.order || a.id - b.id);
}

/** 一条规则的替换结果 */
export interface ReplaceOutcome {
  text: string;
  /** 真正改动的规则 id（上游 `BookContent.effectiveReplaceRules`） */
  used: number[];
}

/** 字面全替换（不用 `String.replace(string,…)` —— 它只换第一处，且 `$&` 会被当引用） */
function replaceAllLiteral(text: string, find: string, rep: string): string {
  if (!find) return text;
  return text.split(find).join(rep);
}

/**
 * 按规则依次替换一段文本（正文或标题）。
 *
 * ⚠️ `trimLines` 是上游的**副作用**：启用替换时正文会被**逐行 trim**
 * （`ContentProcessor.kt:175`）。关掉净化就不会 trim ⇒ 别把它挪到别处去做。
 *
 * ⚠️ `keepNonEmpty`：参见下面循环里的注释（只给标题用）。
 *
 * ⚠️ `chapter` / `book`（`#257`）：只给 `@js:` 脚本当绑定用
 * （上游 `RegexExtensions.replace(…, chapter, replaceBook)`）。标题/正文都是**同一章**的对象。
 */
export function applyReplaceRules(
  text: string,
  rules: ReplaceRule[],
  opts: { trimLines?: boolean; keepNonEmpty?: boolean; chapter?: unknown; book?: unknown } = {},
): ReplaceOutcome {
  let out = opts.trimLines
    ? text
        .split('\n')
        .map((l) => l.trim())
        .join('\n')
    : text;
  const used: number[] = [];
  for (const r of rules) {
    if (!r.pattern) continue;
    const t0 = Date.now();
    let next: string;
    try {
      /**
       * ★★ `#252`：**必须走 `compileRuleRegex`（Android/ICU → JS 的折算），不能 `new RegExp(pattern,'g')`**。
       * 直接编译有两个致命后果（用户实测「第 9 章 1089 字只剩 120 字」）：
       *   ① Java 内联标志 `(?i)/(?m)` 在 JS 里是**非法分组** ⇒ 整条规则静默失效（46 条启用规则里 18 条）；
       *   ② **`\w` 语义不同**：Android/ICU 的 `\w` 含中文，JS 的 `\w` 只含 ASCII
       *      ⇒ `[^\w…]+` 这类「吃标点」的表达式会把**整段中文**当垃圾吃掉。
       * 详见 `utils/regex-android.ts` 文件头。
       */
      const re = r.isRegex ? compileRuleRegex(r) : null;
      if (!r.isRegex) {
        /**
         * ★ `#257`：`isRegex=false` 时**上游不求值 JS**（`ContentProcessor.kt:190` 走字面 `String.replace`）
         * ⇒ `@js:...` 会被**原样插进正文**。照抄（保真优先），但必须留痕 ——
         * 写这种规则的作者多半是想写正则模式，看到 `@js:` 出现在正文里才知道错了。
         */
        if (isJsReplacement(r.replacement)) {
          warnOnce(
            `replace-rule:js-nonregex:${r.id}`,
            `净化规则「${r.name}」用了 @js: 但没勾「正则」⇒ 上游此时不会求值 JS，`
              + '@js:… 会被原样插入正文（本仓照抄上游行为）；请把这条规则改成正则模式',
          );
        }
        next = replaceAllLiteral(out, r.pattern, r.replacement);
      } else if (!re) {
        next = out; /* 编译失败 ⇒ compileRuleRegex 已 warnOnce，本条按「不改动」处理 */
      } else {
        const jsScript = isJsReplacement(r.replacement) ? jsScriptOf(r.replacement) : null;
        const evalJs =
          jsScript === null
            ? null
            : createJsEvaluator({
                ruleId: r.id,
                ruleName: r.name,
                chapter: opts.chapter,
                book: opts.book,
              });
        /**
         * ★★ `#257`：**必须用函数型回调**（而不是把替换串直接交给 JS 的 `String.replace`）——
         * JS 与 Java 的替换串语法**不一样**（`$0` / `${name}` / `$$` / `$&` / 未参与分组），
         * 详见 `js-replace.ts` 的 `expandJavaReplacement`。`@js:` 则先求值、再把结果按同一套语义展开。
         */
        const literal = jsScript === null ? r.replacement : '';
        next = out.replace(re, (...args: unknown[]) => {
          const m = parseReplaceCallbackArgs(args);
          return evalJs ? evalJs(jsScript as string, m) : expandJavaReplacement(literal, m.groups, m.named);
        });
      }
    } catch (e) {
      /**
       * ⚠️ 这里的措辞**不能写成「正则无法编译」**：这条 catch 还兜着
       * `@js:` 求值失败、替换串引用了不存在的分组（`$9`）等 —— Java 那边同样是抛
       * `IndexOutOfBoundsException` 后按「该条不生效」处理。报错原因说错了会把排查方向带偏。
       */
      warnOnce(
        `replace-rule:apply-fail:${r.id}`,
        `净化规则「${r.name}」本次替换失败 ⇒ 跳过（正文保持原样）：${String(
          e instanceof Error ? e.message : e,
        ).slice(0, 160)}`,
      );
      continue;
    }
    const cost = Date.now() - t0;
    if (cost > replaceRuleTimeout(r)) {
      /**
       * 超时**只留痕，不禁用规则** —— 上游能中断并自动禁用（`ContentProcessor.kt:197-200`），
       * 本仓在单线程里中断不了；没有中断能力却偷偷改用户设置，比慢更糟。
       */
      warnOnce(
        `replace-rule:slow:${r.id}`,
        `净化规则「${r.name}」单次替换耗时 ${cost}ms（超过设定的 ${replaceRuleTimeout(r)}ms）⇒ 这条正则可能有问题`,
      );
    }
    /**
     * ★ `keepNonEmpty`（**只对标题开**）：照抄 `BookChapter.getDisplayTitle()`
     * （`BookChapter.kt:147-149` 的 `if (mDisplayTitle.isNotBlank())`）——
     * 一条规则把标题**整个替换成空**时，**保留原标题**（否则用户会看到一条没有名字的章节）。
     * 正文**不**开这个保护：正文被清空是用户的正当意图（例如整段广告）。
     */
    if (next !== out && !(opts.keepNonEmpty && next.trim() === '')) {
      /**
       * ★★ `#252` **灾难性删除护栏**（本仓特有，上游没有 —— 因为上游有超时中断兜底）。
       *
       * ## 为什么必须有
       * 上游出问题会抛 `RegexTimeoutException` 并**自动禁用该规则**（`ContentProcessor.kt:197-200`）；
       * 而 JS 是单线程、正则**中断不了**。更要命的是：本仓的正则语义与 Android/ICU 有差距
       * （见 `utils/regex-android.ts`）⇒ 一条在 Legado 里只删「行尾垃圾」的规则，
       * 在本仓可能把**整章正文**吞掉（用户实测：第 9 章 1089 字 → 120 字）。
       *
       * ## 判据
       * 单条规则**删掉的字数**同时超过「剩余正文的 50%」和「200 字」⇒ 判定为异常
       * ⇒ **本次不采用这条规则**（保留替换前的文本）+ `warnOnce` 点名。
       * ⚠️ 只跳过**这一条**、不连带其它规则；也不改用户设置（没有中断能力却偷偷禁用更糟）。
       */
      const removed = out.length - next.length;
      if (removed > 0 && removed > 200 && removed > out.length * 0.5) {
        warnOnce(
          `replace-rule:devour:${r.id}`,
          `净化规则「${r.name}」本次要删掉 ${removed} 字（占正文 ${((removed / Math.max(1, out.length)) * 100).toFixed(0)}%）`
            + ' ⇒ 判定为灾难性删除，**该条本次不生效**（正文保持原样）。'
            + '若这是你想要的，请到净化设置里检查这条规则的正则（多半是 \\w 在本仓按 ASCII 解释导致的误命中）',
        );
        continue;
      }
      used.push(r.id);
      out = next;
    }
  }
  return { text: out, used };
}

/**
 * 这本书**要不要用**净化规则（上游 `Book.getUseReplaceRule()`，`Book.kt:226-236`）：
 * 本书设置非 null ⇒ 用它；否则走**全局默认**（`AppConfig.replaceEnableDefault`，默认 **true**）。
 *
 * ⚠️ 上游还有一条：`isImage || isEpub` 的书**默认关闭**净化（`Book.kt:231-233`）。
 * 本仓没有 epub 本地书（Phase 未做），图片书源用 `type` 区分 ⇒ 由调用方传 `isImage`。
 */
export function useReplaceRuleFor(
  book: { useReplaceRule?: boolean | null; isImage?: boolean },
  globalDefault: boolean,
): boolean {
  if (book.useReplaceRule != null) return book.useReplaceRule;
  if (book.isImage) return false;
  return globalDefault;
}
