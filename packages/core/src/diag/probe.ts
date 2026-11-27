/**
 * `#551` **源医生 v2-B/C：单字段试跑 + 选择器探针**（无 LLM）。
 *
 * 背景（`#550` 之后缺的那一环）：`#542` 的 lint 能判「规则**像**写错了」，`#550` 的归因表能说
 * 「运行时为什么坏」——但用户在编辑器里改一条字段时，**不知道这条字段解出什么**。
 * 现在的做法只能「整源跑一个 action」，坏了也不知道是 6 条字段里的哪一条。
 *
 * 本模块补的就是「**写一条、验一条**」：给一条字段规则 + 一份内容 → 报
 * **解出的值 / 命中数 / 耗时 / 错误码**；0 命中时再给**启发式候选**（纯规则，不调 LLM）。
 *
 * 纪律（与 `#542`/`#550` 同一套）：
 *  · **不写第二份求值**：规则求值一律走引擎同一份 `AnalyzeRule`（`selector/analyze.ts`），
 *    JS 走 `createHybridJsEvaluator`（同一条 L1/worker 分流），规则桥走 `makeRuleBridge` 的唯一实现。
 *    ⇒ 探针对同一条规则给出的结果，与真跑引擎时**必然一致**（否则就是 bug，不是「探针近似」）。
 *    （旧教训：`#158`「两处各写一份后来漂了」锁住 6 个源；`#313` 三处规则桥类型对不上。）
 *  · **源桩也只有一份**（`#553`）：`source.getKey()` / `getVariable()` / `get`/`put` /
 *    `getLoginInfoMap()` 全部走 `core/source-stub.ts` 的 `makeSourceStub` —— 与引擎
 *    `bindings["source"]` 同一个函数。`#551` 曾在这里另写「字段快照 + 自补 getKey」，
 *    结果 `source.getVariable()` 之类静默回落空串（`entityStub` 的可下钻空桩）。
 *  · **0 命中必须可见**：命中数 0 时给 `SELECTOR_MISS` 码 + 候选列表，绝不静默返回空串。
 *  · **一份内容只解析一次**：候选用**同一个 AnalyzeRule 实例**逐个试（`domCache` 只留一槽，
 *    换实例 = 每候选重新 parse 一次；实测 6.19MB 目录页单次 parse 常驻 530MB，多解析会 OOM）。
 *  · **探针不发网络请求**：内容由调用方给（粘贴的 HTML/JSON，或服务端取好页再传进来）。
 *    core 侧没有 HttpClient，也不该有。
 */

import { createVariableStore } from '../store';
import { resolveUrl } from '../net/url-resolve';
import { AnalyzeRule } from '../selector/analyze';
import { getResultLast } from '../selector/css';
// `#553` 源桩唯一实现 + 可克隆字段快照（引擎同一份，探针不再自建半套）
import { makeSourceStub } from '../source-stub';
import { cloneableFieldsOf, createHybridJsEvaluator } from '../selector/js';
import { makeRuleBridge } from '../selector/rule-bridge';
import { diagnoseFailure } from './diagnose';
// `#562` 挑战页判定（叶子判据，与发现试跑/物料链同一份）
import { isChallengePage } from './self-fetch';
import type { AnalyzeEnv, JsEvaluator } from '../selector/types';
import type { JsSandboxPool } from '../contract/engine';

/** 试跑取值形态：单值 / 字符串列表 / 元素列表（覆盖 Legado 的 getString/getStringList/getElements） */
export type ProbeMode = 'string' | 'list' | 'elements';

/** 探针链路自己的失败码（与 `diagnose.ts` 的 `DIAGNOSE_CODES` 互补，不重叠） */
export const PROBE_CODES = {
  /** 没给规则（空串 / 字段不存在） */
  NO_RULE: 'NO_RULE',
  /** 没给试跑内容 */
  NO_CONTENT: 'NO_CONTENT',
} as const;

export interface ProbeRequest {
  /** 字段规则串（如 `.book-name@text` / `$.data.title` / `@js: ...`） */
  rule: string;
  /** 试跑内容：HTML / JSON 文本（也可直接给已解析的对象/元素） */
  content?: unknown;
  /** 绝对化基准（`@href`/`@src` 会用到）；给 URL 试跑时必填，否则相对链接原样返回 */
  baseUrl?: string;
  mode?: ProbeMode;
  /** `getString(rule, isUrl)` 的第二参：该字段产出的是 URL ⇒ 走 URL 绝对化 */
  isUrl?: boolean;
  /** 源 jsLib（每次求值前置注入，Legado `AnalyzeRule.getJSLib` 语义） */
  lib?: string;
  /**
   * **源的原始 JSON**（未桩化）—— 桩由本模块用 `makeSourceStub` 建（`#553`，与引擎同一份）。
   * 传「已经桩好的对象」也不会坏（方法会被 `...rule` 覆盖），但那等于调用方自己再造一份桩，
   * 正是 `#553` 要消灭的东西。
   */
  source?: Record<string, unknown>;
  /** book 实体桩（目录/正文规则常读 `book.bookUrl`） */
  book?: Record<string, unknown>;
  /** chapter 实体桩 */
  chapter?: Record<string, unknown>;
  /** 预置变量（`@get:` / `{{}}` 会读到） */
  vars?: Record<string, unknown>;
  /** worker 池（带品牌标记才生效；不传则全走 L1 —— 与引擎同一条分流） */
  pool?: JsSandboxPool & { __yueduWorkerPool?: boolean };
  /** 字段路径（仅回显，不构成判据） */
  field?: string;
  /**
   * **列表项作用域**（`#555`）：先按这条规则取列表项，再**在每个项内**求值 `rule`。
   *
   * 为什么需要：`ruleSearch.name` / `ruleToc.chapterName` 这类字段的语义是
   * 「在**一个列表项**里取书名/章节名」，而此前试跑把它们直接对着**整页**求值 ⇒
   * 命中的是页面上所有同类节点，`getString` 按 `\n` 拼成一大坨（用户实测反馈的原始症状）。
   * 传了 `scopeRule`（如 `ruleSearch.bookList`）后，结果变成「列表 10 项 → 每项解出什么」。
   */
  scopeRule?: string;
  /** 作用域取前 N 项（默认 3，上限 10）—— 只影响回显条数，不影响 `itemCount` */
  scopeLimit?: number;
  /**
   * **预处理规则**（`#565`：`ruleBookInfo.init`）—— 先它在**物料**上求值，其结果
   * **替换**后续字段的求值内容（引擎 `BookInfo.kt:58`：`setContent(analyzeRule.getElement(it))`）。
   *
   * 为什么必须接：黄金屋这类源的详情字段全是 `@js:JSON.parse(result).x`，而 `result`
   * 是 **init 从详情页 og:meta 挖出来又 stringify 的 JSON**。不先跑 init 就试跑这些字段，
   * 等于对整页 HTML 做 `JSON.parse` ⇒ 必抛错 ⇒ 用户看到「规则错」的假象。
   * ⚠️ 只在 `field` 属于 `ruleBookInfo.*`（且不是 init 自己）时由调用方给出。
   */
  initRule?: string;
  /**
   * `#556` **列表容器回显条数**（`mode='elements'`）：默认 `ELEMENT_SAMPLE_N`（30），上限 30。
   *
   * 为什么单独给：列表容器（`bookList`/`chapterList`）的价值就在「**看到真正的列表项 HTML**」——
   * 用户拿它去对照站点结构写行内规则。只给 3 条 220 字（`SAMPLE_MAX`，为候选预览定的）
   * 经常连一个完整 item 都装不下，等于没给。
   */
  sampleLimit?: number;
  /** 列表容器每个样本的字符上限（默认 `ELEMENT_SAMPLE_MAX` = 4000） */
  sampleMax?: number;
}

export interface ProbeResult {
  ok: boolean;
  mode: ProbeMode;
  /** 解出的值（超长截断，见 `VALUE_MAX`） */
  value: string;
  /** `mode='list'` 时的完整列表（每项超长截断） */
  values: string[];
  /** 命中元素数；**纯 JS 规则不适用 ⇒ null**（诚实：不给假数字） */
  hitCount: number | null;
  /** 元素样本（outerHTML 截断）：`mode='elements'` 时按 `sampleLimit`/`sampleMax` 给（默认 30 条 × 4000 字） */
  samples: string[];
  /** 解出值的原始长度（截断前的真实长度） */
  length: number;
  ms: number;
  /** 失败信息（人类可读） */
  error?: string;
  /** 失败码（`diagnose.ts` 的码 + `PROBE_CODES`） */
  code?: string;
  truncated?: boolean;
  field?: string;
  /**
   * **规则写的提示**（纯判据，不是 LLM 建议）：例如「单值字段却命中了 N 个元素」。
   * 与 `code` 的区别：code 是「这次试跑失败了」，hints 是「跑通了但形状可疑」。
   */
  hints?: string[];
  /**
   * 列表项数（只在给了 `scopeRule` 时有值）；此时 `values` = 各项解出的值，
   * `hitCount` 同样表示**列表项数**（不是元素命中数——作用域模式下一个字段本来就没有这个数）。
   */
  itemCount?: number;
  /** 作用域规则原文（回显，便于前端写清「在什么范围内求值」） */
  scopeRule?: string;
  /** `#565` 这次试跑**先跑过预处理 init**（字段实际在 init 的结果上求值） */
  initApplied?: boolean;
  /** init 规则原文（回显；超长截断） */
  initRule?: string;
}

export interface SelectorProbeRequest {
  selector: string;
  content: string;
  baseUrl?: string;
  lib?: string;
  /** 源的**原始 JSON**（同上，桩由 `makeSourceStub` 内部建） */
  source?: Record<string, unknown>;
  pool?: JsSandboxPool & { __yueduWorkerPool?: boolean };
  /** 候选上限（默认 8） */
  maxCandidates?: number;
  /**
   * `#677` **样本条数**（默认 `SAMPLE_N` = 3）。
   *
   * 用户实测（物料源码查看器）：「命中 10 项，但下面列表还是显示 3 项」——
   * `samplesOf()` 的默认只回 3 条（那是给「0 命中的候选预览」定的），
   * 而查看器要的是**全量对照**。这里放开成请求参数，调用方自己决定。
   */
  sampleLimit?: number;
  /** `#677` 每条样本的字符上限（默认 `SAMPLE_MAX` = 220；查看器传 4000） */
  sampleMax?: number;
  /**
   * `#677` **值模式**：`samples` 回落**解出的值**（而不是元素 outerHTML）。
   *
   * 为什么需要（用户实测两个现象）：
   *  · `img@src` 在查看器里「0 命中」—— `getElements('img@src')` 会把 `src` 当**标签名**
   *    再选一次（上游 `getElements` 的 `@` 分段语义就是这样），必然 0；
   *    `class.item@tag.a@href` 同理。取值的规则在引擎里走的是 `getStringList`，不是 `getElements`。
   *  · `a@text` 「显示的是节点，不是节点的 text」—— 元素 outerHTML 确实不是用户要看的字段值。
   *
   * 打开后：末段是 `@属性/文本` 的规则 → 逐项取**值**；纯选择器（列表规则）仍给元素 HTML。
   * 元素 HTML 另外放 `htmlSamples`（定位源码 / 二次匹配要用，不能被值替换掉）。
   */
  valueMode?: boolean;
}

export interface SelectorCandidate {
  selector: string;
  hitCount: number;
  /** 这个候选是怎么想到的（变体规则 / 页面统计），人审用 */
  why: string;
}

export interface SelectorProbeResult {
  ok: boolean;
  hitCount: number;
  samples: string[];
  /**
   * `#677` **每个命中元素的 outerHTML**（与 `samples` 同一批、同一顺序）。
   *
   * 只在 `valueMode` 下与 `samples` 不同（`samples` 是取到的值，这里仍是元素 HTML）；
   * 非值模式下两者相同。查看器拿它做「定位源码行」与「二次匹配的物料」——
   * 用户点 `img@src` 那条值时，二次匹配的物料必须是 `<img …>` 这块 HTML，不是 `https://…jpg`。
   */
  htmlSamples?: string[];
  /** 0 命中时的启发式候选（按命中数降序）；命中时为空数组 */
  candidates: SelectorCandidate[];
  ms: number;
  error?: string;
  code?: string;
  /**
   * `#678` **命中但取值全空**时的解释（值模式）。
   *
   * 典型：`h3@a` —— `@` 的最后一段一律当**属性名**（`attr("a")` ⇒ 空），
   * 要看文字必须写 `h3@a@text`。不说清的话界面上只有一片「（空值）」，看不出该改哪里。
   */
  note?: string;
}

/** 单值展示上限（超长只回前缀，避免把 6MB 页面回灌给前端） */
export const VALUE_MAX = 2_000;
/** 元素样本 outerHTML 截断长度（选择器探针的候选预览用） */
export const SAMPLE_MAX = 220;
/** 样本条数（选择器探针的候选预览用） */
export const SAMPLE_N = 3;
/**
 * `#556` **列表容器**的样本上限：4000 字 / 30 条。
 *
 * 与 `SAMPLE_MAX` 分开的理由：选择器候选是「一眼看命中没命中」，220 字够；
 * 而 `bookList` 的样本是**用户照着写行内规则的实物**（一个 `<div class="item">` 里含封面、
 * 书名、作者、三个章节链接和两个 `<span>`），220 字连第一个 `<li>` 都没到，等于没给。
 * 上限 4000 是「一个典型卡片 + 少量富余」，超过这个长度说明选择器把整页当成了一个 item，
 * 那正是要报错的情形，不该靠文本回显解决。
 *
 * 条数取 30：搜索/发现页一屏通常 10~30 条，**列全**才谈得上「逐行核对」；
 * 超过 30 的（目录页几百章）再多也没人逐条看，直接截断并提示。
 */
export const ELEMENT_SAMPLE_MAX = 4_000;
/** 列表容器默认回显条数（超过则截断并在 `hints` 里说明） */
export const ELEMENT_SAMPLE_N = 30;

/** 整条规则就是 JS（`<js>…</js>` 全包 / 整字段 `@js:`）⇒ 没有「命中数」可言 */
const JS_ONLY_RE = /^(?:@js:[\w\W]*|<js>[\w\W]*<\/js>)$/;

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

function isBlankContent(c: unknown): boolean {
  if (c == null) return true;
  if (typeof c === 'string') return c.trim() === '';
  if (Array.isArray(c)) return c.length === 0;
  if (typeof c === 'object') return Object.keys(c as Record<string, unknown>).length === 0;
  return false;
}

/**
 * 造一份**与引擎同构**的求值环境。
 *
 * 差异只有「能力弱一些」：探针没有 CookieStore / 登录头 / WebView（这些要服务端注入，
 * core 侧不该有），所以脚本里 `java.ajax` 会走 L1 的缺省同步 HTTP、`java.webView` 走静态抓取。
 * ⚠️ 这是**能力边界**，不是「另一套实现」——需要完整能力的场景请走 `/api/run` 真跑。
 *
 * `#556` 起对 `diag/explore-probe.ts` 公开：`exploreUrl` 也要在**同一个环境**里跑 JS
 * （同一个源桩、同一套 `java.*` 桩），否则「发现试跑」与「字段试跑」会给出两套口径。
 * ⚠️ 它是 **diag 内部**的共享点，不是对外稳定 API（签名随探针演进）。
 */
export function makeProbeEnv(req: {
  baseUrl?: string;
  lib?: string;
  /** 源的**原始 JSON**（桩由 `makeSourceStub` 内部建，见 `#553`） */
  source?: Record<string, unknown>;
  book?: Record<string, unknown>;
  chapter?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  pool?: JsSandboxPool & { __yueduWorkerPool?: boolean };
}): { env: AnalyzeEnv; javaExtra: Record<string, unknown> } {
  const variables = createVariableStore(req.vars ?? {});
  const javaExtra: Record<string, unknown> = {};
  const base = req.baseUrl;
  /**
   * 求值器**先占个位**再换真的：规则桥与 `javaExtra` 都要在 `AnalyzeRule` 构造时就拿到 env，
   * 而 `createHybridJsEvaluator` 又要拿 env 去装规则桥 —— 两者互相依赖，只能靠这层间接。
   * （不是「两套实现」：占位只在构造期存在，构造完成后 `jsEvalImpl` 立刻换成真的。）
   */
  let jsEvalImpl: JsEvaluator = () => '';
  /**
   * `#553` **源桩唯一实现**：这里吃的是**源原始 JSON**（未桩化），桩由 `makeSourceStub` 建 ——
   * 与引擎 `bindings["source"]` 同一份（`core/source-stub.ts`）。
   *
   * 为什么不能像 `#551` 那样只给字段快照：`source.getKey()` / `getVariable()` / `get/put` /
   * `getLoginInfoMap()` 全是**方法**，字段快照里没有 ⇒ 只能靠 `entityStub` 的「可下钻空桩」兜底，
   * 于是 `source.getKey()` **静默返回空串**（`#551` 实测踩到，才临时补了 `getKey`/
   * 那半套就是第二份实现，必然漂移）。
   *
   * 两处副作用被**有意隔离**（见 `source-stub.ts` 头注）：
   *  · 不注入 `onPutConcurrent` ⇒ 试跑**不改本进程限频表**；
   *  · 不注入 `sourceHeaders` ⇒ `getHeaderMap()` 给 `{}`（探针没有请求上下文，诚实边界）。
   */
  const srcStub = req.source ? makeSourceStub({ variables }, req.source) : undefined;
  const env: AnalyzeEnv = {
    variables,
    javaExtra,
    ...(base ? { baseUrl: base } : {}),
    // 与引擎同形：活对象（含方法）给 sourceData，可克隆字段快照给 sourceFields（worker 重建用）
    ...(srcStub ? { sourceData: srcStub, sourceFields: cloneableFieldsOf(srcStub) ?? undefined } : {}),
    ...(req.book ? { bookData: req.book } : {}),
    ...(req.chapter ? { chapterData: req.chapter } : {}),
    toAbsolute: (u) => resolveUrl(base, u),
    jsEval: (code, bindings) => jsEvalImpl(code, bindings),
    jsEvalSync: (code, bindings) => jsEvalImpl(code, bindings),
  };
  jsEvalImpl = createHybridJsEvaluator({
    variables,
    javaExtra,
    ...(req.lib ? { lib: req.lib } : {}),
    ...(req.pool ? { pool: req.pool } : {}),
    /**
     * `#559` **`java.getString(rule)`（不传第二参）必须能求值**。
     *
     * 用户实测七猫官方源：`kind` 规则是
     * `@js:["$.score",…].map(function(k){return java.getString(k)})…` ——
     * 以前探针这里**没接 `evalRule`**，于是 `java.getString(...)` 恒走
     * `hooks.evalRule ? … : ''` 的 else 分支 ⇒ **每一项都返回空串**，而同一个 `$.score`
     * 直接当规则写却能解出 `8.4`。这不是源的问题，是「探针少了引擎有的一半接线」。
     *
     * 语义对齐引擎 `evalRuleFull`（`engine.ts`）：对**当前上下文值**（`bindings.$`，
     * 由 `makeJavaStub` 的 `contextValue` 从 `$` 取）建一个临时 `AnalyzeRule` 再求值。
     * 复用同一个 `env` ⇒ 脚本里继续写 `java.*` 也不会断桥。
     */
    evalRule: (rule: string, value: unknown): string => {
      const r = String(rule ?? '').trim();
      if (!r || value == null || value === '') return '';
      try {
        return new AnalyzeRule(env).setContent(value, base).syncGetString(r);
      } catch {
        return '';
      }
    },
    // 规则桥：worker 里 java.getElements/getStringList/setContent 经 RPC 回到这里
    // —— 与引擎同一份实现（`#313`），避免「探针与真跑两套口径」
    ruleBridge: makeRuleBridge({ env: () => env, baseUrl: base ?? '', warn: () => {} }),
  });
  return { env, javaExtra };
}

/** 元素 → 样本文本（HTML 元素取 outerHTML；JSON 值取 JSON 串），超长截断 */
function sampleOf(el: unknown, max: number = SAMPLE_MAX): string {
  if (el == null) return '';
  const o = el as { outerHTML?: unknown; outerHtml?: unknown };
  if (typeof o.outerHTML === 'string') return truncate(o.outerHTML, max).text;
  if (typeof o.outerHtml === 'string') return truncate(o.outerHtml, max).text;
  try {
    return truncate(JSON.stringify(el) ?? '', max).text;
  } catch {
    return truncate(String(el), max).text;
  }
}

function samplesOf(els: unknown[], n: number = SAMPLE_N, max: number = SAMPLE_MAX): string[] {
  return els.slice(0, n).map((el) => sampleOf(el, max));
}

/** 编辑距离（只用于「键名拼错了吗」的近似建议，上限截断，不追求性能） */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/**
 * `#558` **0 命中时往下钻一层：到底是「选择器没选中元素」还是「选中了但取不到文本」**。
 *
 * 用户实测三例（速读谷自制源）都被旧提示挡在门外 —— 旧提示只有一句
 * 「作用域 10 项，每项都解出空串（规则跑通但取不到文本）」，同一句话对应三种完全不同的改法：
 *
 * | 用户写的 | 真因 | 正确写法 |
 * |---|---|---|
 * | `@css:.item a img@src` | 行内规则**自带列表容器选择器** —— 行内字段在**项内**求值，项里没有嵌套的 `.item` | `a img@src` |
 * | `@css:.itemtxt p:eq(1) a@text` | jsoup `:eq(n)` 是**父元素下的元素兄弟序号**（0 基），不是「第 n 个同名标签」；此页 `h3` 占 0、三个 `p` 占 1/2/3，`p:eq(1)` 是第一个 p（无 `<a>`） | `p:eq(2) a@text` 或 `p@a@text` |
 * | `p.1 a@text` | `.N` 段末索引：`.N` 只在**该段末尾**生效（`p.1`=第 2 个 p）；后面还有选择器时被当类名 | `p.1@a@text` |
 *
 * 三条都不是引擎 bug（与 Legado 上游同口径：`AnalyzeByJSoup.getElementsSingle` 只对整段做
 * `findIndexSet`，`.N` 不在末尾就落到 `temp.select(beforeRule)`）—— 所以这里**只解释、不改规则**。
 */
export function explainItemRule(opts: {
  rule: string;
  scopeRule: string;
  /** 选择器部分在「第一项」内命中的元素数（-1 = 没测出来） */
  elCount: number;
  /** 取的是哪个指令（text / href / src …），写进提示里 */
  prop: string;
  /**
   * `#559` 第一项是 **JSON 对象**时给它的键名清单。
   *
   * 为什么必须传：七猫官方源的 `lastChapter = 'original_alias_title'`，而这个键根本不存在
   * （真实键是 `original_title`）。老提示说「选择器在项内 0 命中（`original_alias_title`）…
   * 标签名/类名差一个字符」，对 JSON 项是**完全的误导** —— 用户会去找 CSS 标签。
   */
  jsonKeys?: string[];
}): { code: string; error: string; hints: string[] } | null {
  const raw = opts.rule.trim();
  const isCss = /^@css:/i.test(raw);
  const body = isCss ? raw.slice(5).trim() : raw;
  const at = body.lastIndexOf('@');
  const sel = (at === -1 ? body : body.slice(0, at)).trim();
  const prop = at === -1 ? 'text' : body.slice(at + 1).trim();
  if (!sel) return null;

  const hints: string[] = [];
  let code = 'EMPTY_CONTENT';
  let reason = '';

  /* ---------- ⓿ JSON 项：说的是「键」，不是「选择器」 ---------- */
  if (opts.jsonKeys?.length) {
    const keys = opts.jsonKeys;
    /**
     * 取规则里的「叶子键」：`original_alias_title` / `$.original_alias_title` /
     * `$.data.title` 都归到最后一个标识符。含 `[` `(` `@` 的（JSONPath 过滤、函数、JS）不猜。
     */
    const leaf = (sel.match(/[A-Za-z_$][\w$]*\s*$/) ?? [])[0];
    const isPathy = /[$[\](){}]/.test(sel.replace(/^\$\./, '').replace(/^[A-Za-z_$][\w$]*$/, ''));
    const hit = leaf ? keys.find((k) => k === leaf) : undefined;
    if (leaf && !isPathy && !hit) {
      const near = keys
        .map((k) => ({ k, d: editDistance(k.toLowerCase(), leaf.toLowerCase()) }))
        .filter((x) => x.d <= Math.max(2, Math.floor(leaf.length / 3)))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((x) => x.k);
      code = 'JSON_KEY_MISS';
      reason = `JSON 项里没有键 \`${leaf}\``;
      hints.push(
        `这一项是 **JSON 对象**，规则取的是**键名**（不是 CSS 选择器、不是标签名）。` +
          `项里没有 \`${leaf}\` 这个键。` +
          (near.length
            ? `最接近的是 ${near.map((k) => `\`${k}\``).join(' / ')} —— 是不是拼错了？`
            : `已有的键：${keys.slice(0, 12).map((k) => `\`${k}\``).join('、')}${keys.length > 12 ? ` …共 ${keys.length} 个` : ''}。`),
      );
      return { code, error: `每项都解出空：${reason}（不是「规则语法错」，是「取不到」）`, hints };
    }
  }

  // ① 行内规则自带列表容器选择器（最常见的「看着对、永远空」）
  const scope = opts.scopeRule.replace(/^@css:/i, '').trim();
  const head = sel.split(/[\s>+~]+/)[0] ?? '';
  if (scope && head && (head === scope || scope.endsWith(head) || head.endsWith(scope))) {
    const rest = sel.slice(sel.indexOf(head) + head.length).trim().replace(/^[>+~]\s*/, '');
    const fix = rest ? `${rest}@${prop}` : `a img@${prop}`;
    code = 'CONTAINER_IN_RULE';
    reason = `规则里带了列表容器选择器「${head}」`;
    hints.push(
      `规则里带了**列表容器选择器**「${head}」。行内字段是在**列表项内部**求值的 ——` +
        `容器通常是项的**祖先**，` +
        // `#703` 起祖先链按 `jsoup` 语义整棵文档参与匹配（见 `selector/jsoup-select.ts`），
        // 所以「带容器前缀」本身不再必然 0 命中；这里只在**确实 0 命中**时给建议，
        // 措辞不能再断言「项里没有嵌套的 X」（那是修复前的老结论，会误导）。
        `写全路径能解析就说明它命中了祖先；一旦解不出值，最稳的写法仍是**去掉前缀**：改成 \`${fix}\`。`,
    );
  }

  // ② :eq/:gt/:lt —— jsoup 语义是「父元素下的元素兄弟序号」，不是「第几个同类标签」
  const eq = sel.match(/:(?:eq|gt|lt)\(\s*(-?\d+)\s*\)/i);
  if (eq) {
    /**
     * ⚠️ 这里**不要**按 `head` 拼一个「去掉伪类」的写法当建议：`p:eq(1) a` 去掉 `:eq` 变成
     * `p a`，取到的是**第一个 p 里的 a**（往往是书名链接），看着能跑、值却是错的 ——
     * 比 0 命中更坏。只给两条不会取错值的改法：按序号数对，或换成语义锚定。
     */
    hints.push(
      `\`:eq(${eq[1]})\` 的判据是**父元素下的元素兄弟序号**（0 基，中间夹着别的标签也算一位），` +
        `不是「第 ${Number(eq[1]) + 1} 个同名标签」。两种改法：① 照兄弟顺序数对，把序号改成真正的位数；` +
        `② 换成不依赖序号的写法 —— \`p:has(a)@text\`（要「含链接的那个 p」时最稳）或 \`p.1@a@text\`（\`.1\` = 匹配集里第 2 个）。`,
    );
    if (!reason) reason = `:eq(${eq[1]}) 的序号对不上`;
  }

  // ③ `.N` 索引只在段末生效（`p.1 a` 里的 `.1` 会被当类名）
  if (!isCss) {
    const mid = sel.match(/([A-Za-z][\w-]*)\.(\d+)(?=[\s>+~])/);
    if (mid) {
      hints.push(
        `\`.N\` 段末索引只在**该段末尾**生效（\`${mid[1]}.${mid[2]}\` = 第 ${Number(mid[2]) + 1} 个 ${mid[1]}）；` +
          `\`${sel}\` 里的 \`.${mid[2]}\` 后面还有选择器，会被当成 class ⇒ 0 命中。` +
          `按序号取再往下走要**分段**：\`${mid[1]}.${mid[2]}@a@${prop}\`。`,
      );
      if (!reason) reason = `\`.${mid[2]}\` 不在段末，被当成类名`;
    }
  }

  // ④ 元素命中了但取不到值（选择器没错，是指令选错了）
  if (opts.elCount > 0) {
    hints.push(
      `选择器在项内命中 ${opts.elCount} 个元素，但取 \`@${prop}\` 得到空：` +
        `这些元素没有该属性（例如对 \`div\` 取 \`@src\`），或文本在子节点里（\`@text\` 是包含子孙的文本，` +
        `只想要本节点文字用 \`@ownText\`）。`,
    );
    if (!reason) reason = `元素命中 ${opts.elCount} 个，但 \`@${prop}\` 取不到值`;
    code = 'PROP_EMPTY';
  } else if (opts.elCount === 0 && !reason) {
    // JSON 项的措辞要跟 CSS 项分开：说「选择器/节点」会让用户去翻标签
    if (opts.jsonKeys?.length) {
      reason = `JSON 路径 \`${sel}\` 在项里取不到值`;
      hints.push(
        `这一项是 **JSON 对象**，\`${sel}\` 这条路径没命中。键名大小写敏感，` +
          `数组要写 \`[*]\`（如 \`$.list[*].name\`）。`,
      );
    } else {
      reason = `选择器在项内 0 命中（\`${sel}\`）`;
      hints.push(
        `\`${sel}\` 在这个项里找不到任何节点。对照左边界面的「书籍列表」样本看项内真实结构 —— ` +
          '标签名/类名差一个字符就是 0 命中，而 0 命中不会报错。',
      );
    }
  }

  if (!reason) return null;
  return {
    code,
    error: `每项都解出空：${reason}（不是「规则语法错」，是「取不到」）`,
    hints,
  };
}

/**
 * **B. 单字段试跑**：一条字段规则 + 一份内容 → 解出的值 / 命中数 / 耗时。
 *
 * 语义与引擎完全一致：`mode='string'` 就是 `getString`（URL 字段传 `isUrl: true`），
 * `list` 是 `getStringList`，`elements` 是 `getElements`。
 */
export async function probeField(req: ProbeRequest): Promise<ProbeResult> {
  const t0 = nowMs();
  const mode: ProbeMode = req.mode ?? 'string';
  const field = req.field;
  const base = {
    ok: false,
    mode,
    value: '',
    values: [] as string[],
    hitCount: null as number | null,
    samples: [] as string[],
    length: 0,
    ms: 0,
    ...(field ? { field } : {}),
  };

  const rule = typeof req.rule === 'string' ? req.rule : '';
  if (!rule.trim()) {
    return { ...base, ms: nowMs() - t0, code: PROBE_CODES.NO_RULE, error: '规则为空（先填规则再试跑）' };
  }
  if (isBlankContent(req.content)) {
    return { ...base, ms: nowMs() - t0, code: PROBE_CODES.NO_CONTENT, error: '试跑内容为空（粘贴 HTML/JSON，或先取一次页面）' };
  }

  const { env } = makeProbeEnv(req);
  /** `#562` 物料本身是挑战/校验页吗？—— 0 命中的报错必须按这个说事，否则用户会去改本没错的规则 */
  const chal = isChallengePage(typeof req.content === 'string' ? req.content : '');
  try {
    const ar = new AnalyzeRule(env).setContent(req.content, req.baseUrl);
    /**
     * `#565` **预处理（init）链**：`ruleBookInfo.init` 先跑，其结果**替换**后续字段的求值内容
     * （引擎 `BookInfo.kt:58`：`setContent(analyzeRule.getElement(it))`）。
     *
     * 黄金屋实测：`init` 从详情页 og:meta 挖出书名/作者/简介并 stringify 成 JSON 返回，
     * 而 name/author/intro/lastChapter/coverUrl 全是 `@js:JSON.parse(result).x` ——
     * 不先跑 init，这些字段试跑就是对整页 HTML 做 JSON.parse ⇒ 抛错 ⇒ 「规则错」假象。
     *
     * 口径与引擎逐条对齐（见 engine.ts 详情段）：
     *  · 走 **`getElement`**（不是 `getElements()[0]`）—— 对象/标量都能命中；
     *  · **String/String 包装**才取字符串内容；**真正的对象**（JS 规则返回的）原样保留；
     *  · init 抛错 ⇒ **沿用原内容**（引擎同口径：`(抛错，沿用原内容)`）。
     */
    let arUse = ar;
    const initRule = typeof req.initRule === 'string' ? req.initRule.trim() : '';
    if (initRule) {
      try {
        const initRaw = await ar.getElement(initRule);
        const initVal: unknown =
          initRaw == null
            ? ''
            : typeof initRaw === 'string' || initRaw instanceof String
              ? String(initRaw)
              : initRaw;
        const initEmpty = typeof initVal === 'string' && initVal.trim() === '';
        if (!initEmpty) {
          arUse = new AnalyzeRule(env).setContent(initVal, req.baseUrl);
        }
      } catch {
        /* init 抛错 ⇒ 沿用原内容（与引擎同口径，不报错） */
      }
    }
    const initApplied = !!initRule && arUse !== ar;
    /** 回显 init 链（前端据此标注「字段实际在 init 的结果上求值」） */
    const initEcho = initApplied
      ? { initApplied: true as const, initRule: truncate(initRule, 120).text }
      : {};
    /**
     * ---- 作用域模式（`#555`）----
     * 先把列表项取出来，再**逐项**求值 —— 这才是 `ruleSearch.name` / `ruleToc.chapterName`
     * 这类「行内字段」的真实语义（对着整页求值必然把页面上所有同类节点拼成一坨）。
     * ⚠️ 逐项求值用的是**同一份 Element**（零解析），不是把单项 HTML 重新 parse 一遍。
     */
    if (req.scopeRule && req.scopeRule.trim()) {
      const scopeRule = req.scopeRule.trim();
      const got = (await arUse.getElements(scopeRule)) as unknown;
      const items = (Array.isArray(got) ? got : [got]).filter((x) => x != null);
      if (!items.length) {
        return {
          ...base,
          ok: false,
          hitCount: 0,
          itemCount: 0,
          scopeRule,
          code: 'SELECTOR_MISS',
          error: chal.challenge
            ? `作用域规则 0 命中 —— 试跑物料是**挑战/校验页**（${chal.via}），不是正文：先过盾再取页（动态取页/登录窗口），规则多半没错`
            : `作用域规则 0 命中（${scopeRule}）—— 先修列表规则，行内字段才有意义`,
          ms: nowMs() - t0,
        };
      }
      const limit = Math.min(Math.max(Math.trunc(req.scopeLimit ?? 3), 1), 10);
      const per: string[] = [];
      for (const item of items.slice(0, limit)) {
        // 每项一个实例：内容不同，`domCache` 单槽会互相挤掉，但元素入参本就零解析
        const sub = new AnalyzeRule(env).setContent(item);
        const v = await sub.getString(rule, req.isUrl === true);
        const s = typeof v === 'string' ? v : v == null ? '' : String(v);
        per.push(truncate(s, VALUE_MAX).text);
      }
      const nonEmpty = per.filter((s) => s.trim() !== '').length;
      const joined = per.join('\n');
      const hints: string[] = [];
      if (nonEmpty < per.length) {
        hints.push(`${per.length} 项里有 ${per.length - nonEmpty} 项解出空 —— 列表项若本身正常，多半是该规则只对部分结构生效`);
      }
      if (items.length === 1) {
        hints.push('作用域只命中 1 个列表项：搜索/发现页通常应命中多条，列表规则可能写窄了');
      }
      /**
       * `#558` 全空时**往下钻一层**：先在「第一项」内单独求一次选择器，看是 0 元素还是
       * 「元素有了但取不到值」—— 这两种情况的改法完全不同，旧提示把它们混成一句。
       */
      let diag: { code: string; error: string; hints: string[] } | null = null;
      if (nonEmpty === 0) {
        let elCount = -1;
        let jsonKeys: string[] | undefined;
        try {
          const firstItem = items[0];
          /**
           * `#559` 第一项是 **JSON 对象**吗？是就把键名带上 —— 提示要说「键」而不是「选择器」。
           * 判据：普通对象且没有 DOM 特征（`nodeType`/`outerHTML`）。
           */
          if (
            firstItem &&
            typeof firstItem === 'object' &&
            !Array.isArray(firstItem) &&
            typeof (firstItem as { nodeType?: unknown }).nodeType !== 'number' &&
            typeof (firstItem as { outerHTML?: unknown }).outerHTML !== 'string'
          ) {
            jsonKeys = Object.keys(firstItem as Record<string, unknown>);
          }
          const subEls = new AnalyzeRule(env).setContent(firstItem);
          const body = /^@css:/i.test(rule) ? rule.slice(5).trim() : rule.trim();
          const at = body.lastIndexOf('@');
          const selOnly = at === -1 ? body : body.slice(0, at).trim();
          if (selOnly) {
            const hit = (await subEls.getElements(selOnly)) as unknown;
            elCount = (Array.isArray(hit) ? hit : hit == null ? [] : [hit]).length;
          }
        } catch {
          elCount = -1; // 量不出来就不说数量，别编
        }
        const body = /^@css:/i.test(rule) ? rule.slice(5).trim() : rule.trim();
        const at = body.lastIndexOf('@');
        diag = explainItemRule({
          rule,
          scopeRule,
          elCount,
          prop: at === -1 ? 'text' : body.slice(at + 1).trim(),
          ...(jsonKeys ? { jsonKeys } : {}),
        });
      }
      return {
        ...base,
        ok: nonEmpty > 0,
        hitCount: items.length,
        itemCount: items.length,
        scopeRule,
        values: per,
        value: truncate(joined, VALUE_MAX).text,
        length: joined.length,
        ...(nonEmpty
          ? {}
          : {
              code: diag?.code ?? 'EMPTY_CONTENT',
              error: diag?.error ?? `作用域 ${items.length} 项，每项都解出空串（规则跑通但取不到文本）`,
            }),
        ...(diag?.hints.length || hints.length ? { hints: [...(diag?.hints ?? []), ...hints] } : {}),
        ...initEcho,
        ms: nowMs() - t0,
      };
    }
    if (mode === 'elements') {
      const els = (await arUse.getElements(rule)) as unknown[];
      const arr = Array.isArray(els) ? els : [els];
      const items = arr.filter((x) => x != null);
      /**
       * `#556` 列表容器的样本**放大**（4000 字 / 8 条，可用 `sampleLimit`/`sampleMax` 覆盖）：
       * 用户要的是「命中元素逐行列出**元素本身**」，而不是把整页文本拼成一串。
       * ⚠️ 这里**只给元素，不给元素的文本**：文本是行内字段（name/author…）的活，
       * 在容器上给文本，恰好就会得到用户报的那一大坨「书名已完结仙侠作者：…」。
       */
      const lim = Math.min(Math.max(Math.trunc(req.sampleLimit ?? ELEMENT_SAMPLE_N), 1), 30);
      const maxChars = Math.min(Math.max(Math.trunc(req.sampleMax ?? ELEMENT_SAMPLE_MAX), 200), 20_000);
      return {
        ...base,
        ok: items.length > 0,
        hitCount: items.length,
        samples: samplesOf(items, lim, maxChars),
        value: items.length ? sampleOf(items[0], maxChars) : '',
        length: items.length,
        ...(items.length > lim
          ? { hints: [`命中 ${items.length} 项，只回了前 ${lim} 个元素（逐条核对时够用；要更多请缩小列表规则）`] }
          : {}),
        ...(items.length ? {} : {
          code: 'SELECTOR_MISS',
          error: chal.challenge
            ? `0 命中：试跑物料是**挑战/校验页**（${chal.via}），不是正文 —— 先过盾再取页（动态取页/登录窗口），规则多半没错`
            : '0 命中：该选择器在给定内容里没有匹配到元素',
        }),
        ...initEcho,
        ms: nowMs() - t0,
      };
    }
    if (mode === 'list') {
      const list = await arUse.getStringList(rule);
      const arr = Array.isArray(list) ? list : [];
      const joined = arr.join('\n');
      const { text, truncated } = truncate(joined, VALUE_MAX);
      return {
        ...base,
        ok: true,
        hitCount: arr.length,
        values: arr.map((s) => truncate(String(s ?? ''), VALUE_MAX).text),
        value: text,
        length: joined.length,
        ...(truncated ? { truncated } : {}),
        ...(arr.length ? {} : { code: 'SELECTOR_MISS', error: '0 命中：列表规则没有取到任何字符串' }),
        ...initEcho,
        ms: nowMs() - t0,
      };
    }
    // ---- mode = 'string'（默认） ----
    // 命中数**另跑一次 getElements**：同一实例 ⇒ 复用同一份 DOM 解析（零额外 parse）。
    // 纯 JS 规则不给命中数（它本来就没有「选中了几个元素」这回事，给 0 会误导）。
    let hitCount: number | null = null;
    if (!JS_ONLY_RE.test(rule.trim())) {
      try {
        const els = (await arUse.getElements(rule)) as unknown[];
        hitCount = (Array.isArray(els) ? els : [els]).filter((x) => x != null).length;
      } catch {
        hitCount = null; // 求值失败由下面的 getString 统一报，命中数留空即可
      }
    }
    const raw = await arUse.getString(rule, req.isUrl === true);
    const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
    const { text, truncated } = truncate(s, VALUE_MAX);
    const empty = s.trim() === '';
    /**
     * **单值取值命中多个元素** —— 这是写规则时最常栽的形状：
     * Legado `getString` = `getStringList().join("\n")`（实测：`.name` 在含 2 个 .name 的页上
     * 解出 `雪中悍刀行\n雪中悍刀行2`），于是「选择器写宽了」不会报错，而是**静默给出拼接串**
     * ⇒ 详情页书名变成一大坨。这里把它显式说出来（`#551` 的判据，不是猜测）。
     *
     * ⚠️ `#556` 措辞要点明「**单值取值**」：列表容器（`bookList`/`chapterList`）命中多个才是对的，
     * 用 `mode='elements'` 跑。同一句话在容器上出现，只会让人以为「列表写宽了」。
     */
    const hints: string[] = [];
    if (!empty && mode === 'string' && (hitCount ?? 0) > 1 && s.includes('\n')) {
      hints.push(
        `按单值取（getString）命中了 ${hitCount} 个元素：Legado 会用 \\n 把它们拼成一串 —— ` +
          `若这是单值字段（书名/作者…）说明选择器写宽了；若这是列表容器（bookList/chapterList），改用「▶ 匹配」看元素本身`,
      );
    }
    return {
      ...base,
      ok: !empty,
      hitCount,
      value: text,
      length: s.length,
      ...(truncated ? { truncated } : {}),
      ...(hints.length ? { hints } : {}),
      ...(empty
        ? {
            code: hitCount === 0 ? 'SELECTOR_MISS' : 'EMPTY_CONTENT',
            error:
              hitCount === 0
                ? chal.challenge
                  ? `0 命中：试跑物料是**挑战/校验页**（${chal.via}），不是正文 —— 先过盾再取页，规则多半没错`
                  : '0 命中：选择器没匹配到元素，解出空串'
                : '解出空串（规则跑通了，但没取到文本）',
          }
        : {}),
      ...initEcho,
      ms: nowMs() - t0,
    };
  } catch (e) {
    // 复用 `#550` 的归因表：探针不自己编一套「这可能是什么原因」。
    // ⚠️ `diagnoseFailure` 只吃**字符串**（非字符串一律当空 ⇒ 返回 null）——这里必须自己转成消息串。
    const d = diagnoseFailure({ error: e instanceof Error ? e.message : String(e) });
    return {
      ...base,
      ms: nowMs() - t0,
      code: d?.code ?? 'UNKNOWN',
      error: `${d?.title ?? '试跑失败'}：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* C. 选择器探针                                                        */
/* ------------------------------------------------------------------ */

/**
 * **0 命中的变体候选**（纯规则，无 LLM）。
 *
 * 每条都写清「为什么想到它」——用户看到的不是「AI 猜的」，而是可复核的启发式。
 * ⚠️ 只做**语法变体**（同一语义、不同写法），不做语义重写（那属于 `#543` 的人审补丁）。
 */
function variantsOf(sel: string): { selector: string; why: string }[] {
  const s = sel.trim();
  const out: { selector: string; why: string }[] = [];
  const push = (selector: string, why: string) => {
    const t = selector.trim();
    if (t && t !== s && !out.some((x) => x.selector === t)) out.push({ selector: t, why });
  };

  // ① 去掉末尾的 `@attr`（`.a@href` ⇒ `.a`）：Legado 里 @attr 只是「取属性」，
  //    选择器本身写错时，剥掉它才能看清「到底选中了没」。
  if (!s.startsWith('@@')) {
    const m = /@([\w:.-]+)$/.exec(s);
    if (m) push(s.slice(0, m.index), `去掉末尾的 @${m[1]}（先看选择器本身命不命中）`);
    // ② 换属性：@text ↔ @ownText ↔ @html（站点把文本塞进子节点时 @text 会取到拼接值）
    if (/@text$/.test(s)) push(s.replace(/@text$/, '@ownText'), '换 @ownText（只取本节点直接文本，不含子节点）');
    if (/@text$/.test(s)) push(s.replace(/@text$/, '@html'), '换 @html（看该节点的原始 HTML）');
  }
  // ③ 去掉 `##正则` 段（正则写错是 0 命中的常见原因，且它会掩盖选择器是否命中）
  const hash = s.indexOf('##');
  if (hash > 0) push(s.slice(0, hash), '去掉 ## 之后的正则段（先看选择器本身命不命中）');
  // ④ `class.x` ⇄ `.x`（Legado 两种写法等价，手写时常混）
  const cm = /^class\.([\w-]+)$/.exec(s);
  if (cm) push(`.${cm[1]}`, '等价写法：class.x ⇒ .x');
  else if (/^\.[\w-]+$/.test(s)) push(`class.${s.slice(1)}`, '等价写法：.x ⇒ class.x');
  // ⑤ `#id` ⇄ `id.x`
  const im = /^id\.([\w-]+)$/.exec(s);
  if (im) push(`#${im[1]}`, '等价写法：id.x ⇒ #x');
  else if (/^#[\w-]+$/.test(s)) push(`id.${s.slice(1)}`, '等价写法：#x ⇒ id.x');
  // ⑥ 去掉末尾索引（`.0` / `!0`）：索引越界会让「能命中」变成「0 命中」
  if (/\.\d+$/.test(s)) push(s.replace(/\.\d+$/, ''), '去掉末尾的位置索引（先看有没有命中）');
  if (/![-\d!]+$/.test(s)) push(s.replace(/![-\d!]+$/, ''), '去掉末尾的排除/索引段');
  return out;
}

/** 页面里出现频次最高的 class（正则扫描，不额外 parse —— 大页面 parse 一次常驻 530MB） */
function topClasses(html: string, n: number): string[] {
  const freq = new Map<string, number>();
  // 只看前 512KB：候选是启发式，尾部内容对「哪个 class 常见」影响极小，
  // 但能省掉对 6MB 页做整串正则（实测单次 ~30ms，试跑是交互路径，不能卡）。
  const src = html.slice(0, 524_288);
  const re = /class\s*=\s*["']([^"']{1,80})["']/gi;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(src)) !== null && guard++ < 20_000) {
    for (const c of m[1]!.split(/\s+/)) {
      const k = c.trim();
      // 跳过明显是模板/哈希噪声的名（对选书源字段没有意义）
      if (!k || k.length > 40 || /^\d|^_$/.test(k)) continue;
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k]) => k);
}

/**
 * JSON 页 ⇒ 键路径候选（`$.k` / `$.k[*]` / `$.k.child`）。
 *
 * 为什么必须专门做一条：JSON 内容上 CSS 选择器**必然** 0 命中，此时给用户列「页面里的 class 名」
 * 是纯粹的噪音；而 JSON 的键名是**页面上真实存在的**，列出来就是可直接抄的答案。
 * 下钻规则只走两层（`$.k` → 数组加 `[*]` → 对象加子键）——再深就是替用户写规则了（那是 `#543` 的人审范围）。
 */
function jsonKeysOf(text: string, n: number): string[] {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return [];
  let o: unknown;
  try {
    o = JSON.parse(t) as unknown;
  } catch {
    return []; // 不是合法 JSON ⇒ 不给候选（不猜）
  }
  const out: string[] = [];
  if (Array.isArray(o)) return o.length ? ['$[*]', '$[0]'] : [];
  if (!o || typeof o !== 'object') return [];
  const obj = o as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    out.push(`$.${k}`);
    const v = obj[k];
    if (Array.isArray(v)) {
      if (v.length) out.push(`$.${k}[*]`);
    } else if (v && typeof v === 'object') {
      const sub = v as Record<string, unknown>;
      for (const c of Object.keys(sub).slice(0, 3)) {
        out.push(`$.${k}.${c}`);
        // 子键是数组 ⇒ 顺带给 `[*]`（列表字段的惯用写法，用户抄了就能用）
        if (Array.isArray(sub[c]) && (sub[c] as unknown[]).length) out.push(`$.${k}.${c}[*]`);
      }
    }
    if (out.length >= n * 3) break;
  }
  return out.slice(0, n * 3);
}

/**
 * `#679` 顶层组合符：`&&`（顺序拼接）/ `||`（第一个非空）/ `%%`（交错）。
 * 出现在规则里就说明这是**复合规则**，值必须整体交给 `getStringList`，不能自己按 `@` 切。
 */
const COMPOSITE_RE = /&&|\|\||%%/;

/**
 * `#685` 规则里是否含 **JS 段**（`<js>…</js>` 或 `@js:`），**任意位置都算**。
 *
 * 对齐上游 `AnalyzeRule.splitSourceRule`（`:593-636`）：它用 `JS_PATTERN` 在整串里扫，
 * 扫到前后的文本各自成段 ⇒ `选择器 + 换行 + <js>` 是合法写法（`result` = 前一段输出）。
 * 探针若把含 JS 段的整串当选择器，必然 0 命中。
 */
const HAS_JS_SEGMENT_RE = /<js>[\s\S]*?<\/js>|@js:/i;

/**
 * `#685` **单 token 规则**（`a` / `title` / `href`）—— 没有 `@`、没有任何选择器符号。
 *
 * 它在两处含义不同：**取值位置**当属性名/关键字（`attr("href")`），**列表位置**当元素选择器。
 * 查看器无从判断用户填在哪儿，只能把两种口径都说明白。
 */
const SINGLE_TOKEN_RULE_RE = /^[A-Za-z_][\w-]*$/;



/**
 * `#684` 从右往左找**括号外**的最后一个 `@`（`[` `]` `(` `)` 内的不算）。
 *
 * 为什么需要：XPath 的 `[@attr="v"]`、CSS 的 `[href="v"]` 都含 `@`，而 `@` 同时也是
 * 「末段取值」的分隔符。用 `lastIndexOf` 会切进谓词里，把一条合法规则切成两条非法规则。
 */
function lastTopLevelAt(rule: string): number {
  let depth = 0;
  for (let i = rule.length - 1; i >= 0; i--) {
    const c = rule[i];
    if (c === ']' || c === ')') depth++;
    else if (c === '[' || c === '(') depth = Math.max(0, depth - 1);
    else if (c === '@' && depth === 0) return i;
  }
  return -1;
}

/** `#678` 末段「取值关键字」集合（与 `selector/css.ts` 的 `GET_RESULT_KEYWORD_RE` 一致） */
const RESULT_KEYWORD_RE = /^(text|textNodes|ownText|html|all)$/;

/** JSON 规则（`$.…` / `$[…]` / `@json:`）——命中数口径与 CSS 不同，见 `hitOf` 注释 */
const JSON_RULE_RE = /^(?:\$|@json:)/i;

/**
 * `#677` 把「取值规则」切成 `head@tail`（`img@src` → `img` + `src`）。
 *
 * 只按**最后一个** `@` 切：`class.item@tag.a@href` 的 head 必须是 `class.item@tag.a`
 * （那是元素定位），tail 才是 `href`（那是取值）。切不出来就返 null，交给调用方走默认路径。
 *
 * 不切的情形：
 *  · 纯脚本（`@js:` / `<js>`）—— `@` 在代码里到处都是，切了就是乱来解释；
 *  · `@` 后面紧跟 `css/json/xpath/js:`（那是模式前缀，不是属性名）；
 *  · `@` 在最前面或最后面（`@css:div` / `div@`），没有 head 或没有 tail。
 */
function splitValueTail(rule: string): { head: string; tail: string } | null {
  const t = rule.trim();
  if (!t) return null;
  if (/^(?:<js>|@js:)/i.test(t)) return null;
  /**
   * ★ `#684` **只在「括号外」的 `@` 上切**。
   *
   * 用户实测：`//div[@data-xpch="card-list"]//article` 在查看器里「匹配失败」。
   * 真因不在 XPath（引擎直跑能出 2 条），而是这里 `lastIndexOf('@')` 切进了谓词里：
   *   head = `//div[`   tail = `data-xpch="card-list"]//article`
   * 随后 `getElements('//div[')` 抛「XPath 语法错」→ 整条探针报「探针失败：」（消息为空）。
   *
   * XPath 谓词 `[@attr=…]`、CSS 属性选择器 `[href="…"]`、`(…)` 里的 `@` 都不是「取值段的分隔符」。
   */
  /**
   * `#684` XPath 的两种「取值尾段」，与 `@` 写法等价但要单独认：
   *   · `…/article/@data-xpch` —— `@` 前面是 `/`（属性轴），head 要把这个 `/` 去掉；
   *   · `…/h3/text()`        —— 没有 `@`，但末尾就是取值（文本节点）。
   * 不认这两种，前者会被切成 head=`…/article/`（末尾多一个 `/` ⇒ XPath 语法错），
   * 后者根本切不出来（落到取元素路径 ⇒ `text()` 不是元素 ⇒ 0 命中）。
   */
  const xpAttr = /^(.*?)\/@([\w:.-]+)$/.exec(t);
  if (xpAttr && (xpAttr[1] ?? '').trim()) return { head: (xpAttr[1] ?? '').trim(), tail: (xpAttr[2] ?? '').trim() };
  const xpText = /^(.*?)\/text\(\)$/.exec(t);
  if (xpText && (xpText[1] ?? '').trim()) return { head: (xpText[1] ?? '').trim(), tail: 'text' };

  const i = lastTopLevelAt(t);
  if (i <= 0 || i === t.length - 1) return null;
  let head = t.slice(0, i).trim();
  const tail = t.slice(i + 1).trim();
  // `…/article@href` 这种（XPath 属性写法漏了 `/`）也要能吃：head 末尾的 `/` 一律去掉
  head = head.replace(/\/$/, '').trim();
  if (!head || !tail) return null;
  if (/^(?:css|json|xpath|js):/i.test(tail)) return null;
  /**
   * ★ `#685` **末段是「选择器简写」时不是取值段**（`tag.a` / `class.x` / `id.y` / `children` / `text.前缀`）。
   *
   * 用户最常见的**列表规则**就长这样：`class.chapter@tag.li`。它作为取值规则会变成
   * `attr("tag.li")` ⇒ 空（上游确实如此），但没人会这么写取值；
   * 查看器若按取值走，就会对一条完全正常的列表规则显示「命中 N 项（空值）」—— 误导。
   * 上游 `ElementsSingle.getElementsSingle` 里这五个前缀本来就是**选择简写**（`AnalyzeByJSoup.kt:305-316`），
   * 所以这里把它们留给元素路径。
   */
  if (/^(?:tag|class|id|children|text)\./i.test(tail) || tail === 'children') return null;
  return { head, tail };
}

/**
 * **C. 选择器探针**：命中数 + 样本 + 0 命中的启发式候选。
 *
 * 顺序：① 原选择器 → ② 语法变体（每个都报真实命中数）→ ③ 仍 0 ⇒ 页面统计候选
 * （HTML 给 class 频次 top N；JSON 给顶层键 `$.key`）。
 */
export async function probeSelector(req: SelectorProbeRequest): Promise<SelectorProbeResult> {
  const t0 = nowMs();
  const sel = typeof req.selector === 'string' ? req.selector : '';
  if (!sel.trim()) return { ok: false, hitCount: 0, samples: [], candidates: [], ms: nowMs() - t0, code: PROBE_CODES.NO_RULE, error: '选择器为空' };
  if (isBlankContent(req.content)) {
    return { ok: false, hitCount: 0, samples: [], candidates: [], ms: nowMs() - t0, code: PROBE_CODES.NO_CONTENT, error: '内容为空（粘贴 HTML/JSON，或先取一次页面）' };
  }

  const { env } = makeProbeEnv({ ...req, vars: {} });
  // ★ 一个实例跑到底：候选用同一个 AnalyzeRule ⇒ 整轮只 parse 一次 DOM
  const ar = new AnalyzeRule(env).setContent(req.content, req.baseUrl);
  /**
   * 命中数。
   *
   * **CSS/XPath**：选中几个元素就是几（与引擎 `getElements` 完全同口径）。
   * **JSON**：`getElements` 只在值**是数组**时给个数（`$.data` 是个对象 ⇒ 回 `[]`），
   * 于是「键存在」会被误报成 0 命中 —— 实测 `{"data":{…}}` 上 `$.data` 的
   * `getElements` = `[]` 但 `getElement` = 该对象。故 JSON 规则先数元素、
   * 元素数为 0 时再退到 `getElement` 的**存在性**（非 null ⇒ 1）。
   * 这不是两套判据，是「JSON 没有元素概念」这件事本身要求的口径。
   */
  const hitOf = async (rule: string): Promise<number> => {
    try {
      const els = (await ar.getElements(rule)) as unknown[];
      const n = (Array.isArray(els) ? els : [els]).filter((x) => x != null).length;
      if (n > 0) return n;
      if (JSON_RULE_RE.test(rule.trim())) {
        const v = await ar.getElement(rule);
        return v === undefined || v === null ? 0 : 1;
      }
      return 0;
    } catch {
      return 0;
    }
  };

  try {
    const limit = Math.max(1, Math.min(2000, Math.trunc(req.sampleLimit ?? SAMPLE_N)));
    const maxChars = Math.max(40, Math.min(20_000, Math.trunc(req.sampleMax ?? SAMPLE_MAX)));
    const htmlOf = (list: unknown[]): string[] =>
      list.slice(0, limit).map((el) => sampleOf(el, maxChars));

    /**
     * `#677` **值模式**：末段是 `@属性/@text` 的规则按「取值」走，与引擎 `getStringList` 同口径。
     *
     * 判据只看「最后一个 `@` 后面是不是一段『取值/选择续段』」——`@css:`/`@json:`/`@xpath:`
     * 这类**前缀**不是末段（`@css:a@href` 要切成 head=`@css:a`、tail=`href`）。
     * `@js:` 整段是脚本：既不能当选择器、也不能当属性名 ⇒ 交给 `getStringList` 兜底。
     */
    if (req.valueMode) {
      /**
       * `#685` **单 token 且是取值关键字**（`text` / `html` / `all` / `ownText` / `textNodes`）⇒ 取值。
       *
       * 旧实现把它丢进元素路径：`getElements("text")` 在本仓会命中「含自有文本的元素」（一串元素），
       * 而引擎里 `text` 是关键字 ⇒ 当前元素的全部文本。用户看着「`text` 怎么回了一堆 HTML」就是这里。
       */
      if (SINGLE_TOKEN_RULE_RE.test(sel) && RESULT_KEYWORD_RE.test(sel)) {
        const vals = await ar.getStringList(sel);
        if (vals.length) {
          return {
            ok: true,
            hitCount: vals.length,
            samples: vals.slice(0, limit).map((s) => truncate(s.replace(/\s+/g, ' ').trim(), VALUE_MAX).text),
            htmlSamples: [],
            candidates: [],
            ms: nowMs() - t0,
            note: `\`${sel}\` 是**取值关键字**（不是标签名）：取值位置得到当前内容里的${sel === 'text' ? '全部文本' : sel}。`,
          };
        }
      }

      /**
       * ★ `#685` **规则里任何位置出现 JS 段（`<js>…</js>` / `@js:`）⇒ 整条交 `getStringList`**。
       *
       * 用户实测：`script[id="__NUXT_DATA__"]` + 换行 + `<js>…</js>` 在查看器里
       * 「0 命中 · 选择器没匹配到元素」，而同一条规则喂给引擎 `getString` 能正常解出 m3u8 地址
       * ⇒ **查看器没按段求值**：它把整串（含 `<js>` 块）当一条 CSS 选择器丢给 `getElements`，必然 0。
       *
       * 上游 `AnalyzeRule.splitSourceRule`（`:593-636`）是用 `JS_PATTERN` **在整串里扫** `<js>`/`@js:`，
       * 前面的文本成为 Default 段、后面成为 Js 段 —— 也就是说「选择器 + 换行 + `<js>`」是合法写法，
       * 且 `result` 传的就是前一段的输出。查看器必须沿用同一套切分。
       */
      if (HAS_JS_SEGMENT_RE.test(sel)) {
        const vals = await ar.getStringList(sel);
        if (vals.length) {
          return {
            ok: true,
            hitCount: vals.length,
            samples: vals.slice(0, limit).map((s) => truncate(s.replace(/\s+/g, ' ').trim(), VALUE_MAX).text),
            // JS 段可能把元素集合当 `result`，但输出的已经是值 ⇒ 二次匹配没有可用物料
            htmlSamples: [],
            candidates: [],
            ms: nowMs() - t0,
            note:
              '这条规则含 JS 段（`<js>…</js>` 或 `@js:`）：按上游口径切成「前面的选择器段 + JS 段」依次求值，'
              + '`result` 是前一段的输出（选择器段无 `@text` 时给的是文本）。'
              + '因为结果是脚本算出来的，**不能再拿它做二次匹配的物料**。',
          };
        }
      }

      /**
       * ★ `#679` **复合规则（`&&` / `||` / `%%`）不能按最后一个 `@` 切**。
       *
       * 用户实测：`li>a@text&&li>a@href` 在查看器里回了 **16 条全是 href**，`||` 回 8 条 href。
       * 真因不是引擎（引擎口径是对的：`&&` = 各段顺序拼接、`||` = 第一个非空、`%%` = 交错），
       * 而是这里把整条复合规则 `lastIndexOf('@')` 切成 `head='li>a@text&&li>a'` + `tail='href'`，
       * 再把 `href` 套到 head 选出的每个元素上 ⇒ 全是 href、条数还翻倍。
       *
       * 复合规则的「值」只能整体交给 `getStringList`（引擎同一份实现，含三个组合符的合并语义）。
       * 元素 HTML 与取值的对应关系在组合后本就不唯一（`&&` 是 3+3 条），故 `htmlSamples` 给空。
       */
      if (COMPOSITE_RE.test(sel)) {
        const vals = await ar.getStringList(sel);
        if (vals.length) {
          return {
            ok: true,
            hitCount: vals.length,
            samples: vals.slice(0, limit).map((s) => truncate(s.replace(/\s+/g, ' ').trim(), VALUE_MAX).text),
            htmlSamples: [],
            candidates: [],
            ms: nowMs() - t0,
            note:
              '组合符口径（上游 `AnalyzeByJSoup.getStringList`）：`&&` = 各段结果**顺序拼接**'
              + '（`@text` 8 条 + `@href` 8 条 = 16 条，不是去重）；`||` = 取**第一个非空**段；'
              + '`%%` = 各段**交错**合并。想要「文字+链接」成对，用 `%%`。',
          };
        }
      }
      const pair = splitValueTail(sel);
      if (pair) {
        /**
         * `#684` **切分产物求值失败时不许把整次探针打成「探针失败」**。
         *
         * 切分是按文本做的（括号感知也只是启发式），规则里若有点我们没覆盖的语法
         * （XPath 函数、CSS `:has()` 里的怪写法…），`head` 可能就是非法表达式。
         * 旧实现在这里抛异常 ⇒ 外层 catch 把整条探针判死，用户看到「探针失败：」
         * 却拿不到「整条规则其实能跑」这个信息。
         * 现在：head 抛错就退回引擎的整条取值路径（`getStringList`）—— 那才是规则的真实语义。
         */
        let headEls: unknown = null;
        try {
          headEls = await ar.getElements(pair.head);
        } catch {
          const vals = await ar.getStringList(sel).catch(() => [] as string[]);
          if (vals.length) {
            return {
              ok: true,
              hitCount: vals.length,
              samples: vals.slice(0, limit).map((s) => truncate(s.replace(/\s+/g, ' ').trim(), VALUE_MAX).text),
              htmlSamples: [],
              candidates: [],
              ms: nowMs() - t0,
              note: `值模式按 \`@\` 切成 head=\`${pair.head}\` / tail=\`${pair.tail}\` 后，head 求值失败（语法不接受）⇒ 已改由引擎整条求值。若结果不对，多为规则本身的语法问题。`,
            };
          }
        }
        const headArr = (Array.isArray(headEls) ? headEls : [headEls]).filter((x) => x != null);
        if (headArr.length) {
          const values: string[] = [];
          for (const item of headArr.slice(0, limit)) {
            /**
             * ★ `#678` **末段一律按 `getResultLast` 取值**，不要拿它当选择器再选一次。
             *
             * 用户实测反例：`h3@a` 在查看器里显示了「神秘复苏」（文字），而引擎里
             * `h3@a` = `attr("a")` ⇒ **空**（要看文字得写 `h3@a@text`）。
             * 根因是值模式里用了 `getString(tail)`：`getString('a')` 是「选 a 再取文本」，
             * 与「`@` 末段当属性名」完全是两回事。这里改用与引擎同一份 `getResultLast`。
             */
            const dom = item as { querySelectorAll?: unknown };
            let v = '';
            if (typeof dom?.querySelectorAll === 'function') {
              v = getResultLast([item as Element], pair.tail)[0] ?? '';
            } else {
              // 非 DOM（worker 回来的 jsoup 桥 / 纯文本节点）⇒ 退回同一个 AnalyzeRule 的取值路径
              const sub = new AnalyzeRule(env).setContent(item, req.baseUrl);
              const r2 = await sub.getString(pair.tail);
              v = typeof r2 === 'string' ? r2 : r2 == null ? '' : String(r2);
            }
            values.push(truncate(v.replace(/\s+/g, ' ').trim(), VALUE_MAX).text);
          }
          const allEmpty = values.every((s) => s === '');
          /**
           * 全空时给一句话：用户写 `h3@a` 的本意是「h3 里的 a」，但 **`@` 的最后一段是属性名**，
           * 所以引擎取到的是空。不说清的话，这里只会显示一片「（空值）」，看不出该改成 `@text`。
           */
          const note =
            allEmpty && !RESULT_KEYWORD_RE.test(pair.tail)
              ? `末段「${pair.tail}」按**属性名**取值，结果全为空：引擎里 \`@\` 的最后一段一律当属性名（不是选择器）`
                + ` ⇒ 「${sel}」取到的就是空。要文字写 \`@text\`，要链接/属性写 \`@href\` / \`@src\` …`
              : undefined;
          return {
            ok: true,
            hitCount: headArr.length,
            samples: values,
            htmlSamples: htmlOf(headArr),
            candidates: [],
            ms: nowMs() - t0,
            ...(note ? { note } : {}),
          };
        }
      }
      /**
       * 兜底**只给「整条就是取值规则」的形态**（脚本 / JSONPath）：
       * 纯选择器（`.item`、`div.item`）必须落回元素路径 —— 那是**列表规则**，
       * 用户要的是卡片 HTML（二次匹配的物料），不是把整张卡片的文字挤成一行。
       */
      const isScript = /^(?:<js>|@js:)/i.test(sel.trim());
      if (isScript || JSON_RULE_RE.test(sel.trim())) {
        const vals = await ar.getStringList(sel);
        if (vals.length) {
          return {
            ok: true,
            hitCount: vals.length,
            samples: vals.slice(0, limit).map((s) => truncate(s.replace(/\s+/g, ' ').trim(), VALUE_MAX).text),
            htmlSamples: [],
            candidates: [],
            ms: nowMs() - t0,
          };
        }
      }
    }

    const els = (await ar.getElements(sel)) as unknown[];
    const arr = (Array.isArray(els) ? els : [els]).filter((x) => x != null);
    const main = arr.length > 0 ? arr.length : JSON_RULE_RE.test(sel.trim()) ? await hitOf(sel) : 0;
    if (main > 0) {
      // JSON 命中「一个值」时 arr 可能是空的（对象/标量不是元素）⇒ 样本从 getElement 取，别给空样本
      const samples = arr.length ? htmlOf(arr) : [sampleOf(await ar.getElement(sel), maxChars)];
      /**
       * `#685` **单 token（`a` / `title` / `href`）是双义的**，必须点明，否则用户会以为
       * 「`a` 和 `a@text` 结果一样」，或以为「`href` 取不到值」：
       *
       * | 用在 | 引擎口径（上游 `AnalyzeByJSoup`） |
       * |-|-|
       * | **取值位置**（chapterName / chapterUrl…） | 末段（无 `@` 则整条）是**属性名/关键字**：`attr("a")` ⇒ 空；取不到属性时本仓会回落成「当选择器取文本」 |
       * | **列表位置**（bookList / chapterList） | 走 `getElements` ⇒ 元素集合（本查看器上面列的就是这个） |
       *
       * 所以这里额外把「按取值口径会得到什么」写进 note —— 一条规则到底是元素还是值，
       * 取决于它被填在哪个字段，查看器无从判断，只能两种都告诉用户。
       */
      let note: string | undefined;
      if (req.valueMode && SINGLE_TOKEN_RULE_RE.test(sel)) {
        const asValue = (await ar.getString(sel).catch(() => '')) || '';
        const shown = asValue.trim() === '' ? '（空）' : `「${truncate(asValue.replace(/\s+/g, ' ').trim(), 60).text}」`;
        note = RESULT_KEYWORD_RE.test(sel)
          ? `\`${sel}\` 是取值关键字 ⇒ 取值位置得到 ${shown}；列表位置按元素返回（见上）。`
          : `\`${sel}\` 没有 \`@\` 取值段：**取值位置**（chapterName / chapterUrl 等）会先按**属性名**取 \`attr("${sel}")\`，`
            + `取不到属性时本仓回落成「当选择器取文本」⇒ 本物料上得到 ${shown}；`
            + `**列表位置**（bookList / chapterList）按元素返回（就是上面这些）。`
            + ` 要明确取文本写 \`${sel}@text\`，要元素就别加 \`@\`。`;
      }
      return {
        ok: true,
        hitCount: main,
        samples,
        htmlSamples: samples,
        candidates: [],
        ms: nowMs() - t0,
        ...(note ? { note } : {}),
      };
    }
    /**
     * `#685` **单 token 作为「属性规则」时元素路径会 0 命中**，但它在取值位置完全合法。
     *
     * 语料实测：`chapterUrl: "href"`（241 处）、`chapterName: "title"`（69 处）这类写法很多，
     * 引擎走 `attr("href")` 能出值 —— 查看器用元素路径找 `<href>` 标签必然 0，
     * 于是显示「0 命中 · 选择器没匹配到元素」，看着像规则坏了。
     */
    if (req.valueMode && SINGLE_TOKEN_RULE_RE.test(sel)) {
      const asValue = (await ar.getString(sel).catch(() => '')) || '';
      if (asValue.trim() !== '') {
        return {
          ok: true,
          hitCount: 1,
          samples: [truncate(asValue.replace(/\s+/g, ' ').trim(), VALUE_MAX).text],
          htmlSamples: [],
          candidates: [],
          ms: nowMs() - t0,
          note:
            `\`${sel}\` 不是元素名，而是**属性名 / 取值关键字**：取值位置（chapterUrl / chapterName …）按 `
            + `\`attr("${sel}")\` 取到了值（见上）。它当列表规则用才是 0 命中（页面里没有 \`<${sel}>\` 元素）。`,
        };
      }
    }
    // ---- 0 命中：给候选 ----
    const max = Math.max(1, Math.min(20, req.maxCandidates ?? 8));
    const cands: SelectorCandidate[] = [];
    for (const v of variantsOf(sel)) {
      const n = await hitOf(v.selector);
      if (n > 0) cands.push({ selector: v.selector, hitCount: n, why: v.why });
    }
    if (!cands.length) {
      const text = typeof req.content === 'string' ? req.content : '';
      const keys = text ? jsonKeysOf(text, max) : [];
      if (keys.length) {
        for (const k of keys) {
          const n = await hitOf(k);
          if (n > 0) cands.push({ selector: k, hitCount: n, why: '内容是 JSON：这是页面上真实存在的键路径' });
        }
      } else if (text) {
        for (const c of topClasses(text, max)) {
          const r = `.${c}`;
          cands.push({ selector: r, hitCount: await hitOf(r), why: '页面里出现频次最高的 class（按文档出现次数排序）' });
        }
      }
    }
    cands.sort((a, b) => b.hitCount - a.hitCount);
    return {
      ok: false,
      hitCount: 0,
      samples: [],
      candidates: cands.slice(0, max),
      ms: nowMs() - t0,
      code: 'SELECTOR_MISS',
      error: '0 命中（下面是能命中的候选）',
    };
  } catch (e) {
    const d = diagnoseFailure({ error: e instanceof Error ? e.message : String(e) });
    return {
      ok: false,
      hitCount: 0,
      samples: [],
      candidates: [],
      ms: nowMs() - t0,
      code: d?.code ?? 'UNKNOWN',
      error: `${d?.title ?? '探针失败'}：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
