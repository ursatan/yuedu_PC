/**
 * 规则解析引擎 —— 类型层
 *
 * 复刻 Legado `AnalyzeRule` / `SourceRule` 的运行时数据模型。
 * 全部对照 /f/legado/.../analyzeRule/ 源码，不靠猜测。
 */

import type { VariableStore } from '../contract/engine';

/** 选择器模式（对齐 Legado `AnalyzeRule.Mode`；'Get' 对齐其 getRuleType 段） */
export type RuleMode = 'XPath' | 'Json' | 'Default' | 'Js' | 'Regex' | 'WebJs' | 'Get';

/**
 * 一次解析的运行态值。
 * Legado 里 running result 可能是 Node / Element / JSON 对象 / 字符串 / 列表，
 * 这里用联合类型显式表达，避免 any 满天飞。
 */
export type RuleValue =
  | { type: 'nodes'; nodes: Node[] }
  | { type: 'json'; value: unknown }
  | { type: 'string'; value: string }
  | { type: 'null' };

/** JS 表达式求值器：可同步（L1 进程内）或异步（L4 worker 池）——调用方一律 await */
export interface JsEvaluator {
  (
    code: string,
    bindings: Record<string, unknown>,
  ): unknown | Promise<unknown>;
}

/** 解析环境：每次请求注入一次 */
/**
 * 宿主 → worker 的**描述符键**（worker 侧 `__yueduPrepareBindings` 消费）。
 *
 * 背景：worker 的 bindings 必须可结构化克隆，而 `source`（Proxy + 方法）与 `infoMap`
 * （Proxy over Map）都不可克隆 → 过去含 `java.ajax` 的脚本只能留在 L1，而 L1 的
 * `execFileSync` 会**同步阻塞事件循环**（实测并发 2→10 时正文通过率 27%→4%）。
 * 改为传纯快照，worker 内重建成 RPC 活对象，脚本的同步语义不变而主线程解放。
 */
export const SOURCE_FIELDS_KEY = '__yueduSourceFields';
/** book / chapter / rssArticle 实体字段快照（同 source：`entityStub` 是函数型 Proxy，不可克隆） */
export const BOOK_FIELDS_KEY = '__yueduBookFields';
export const CHAPTER_FIELDS_KEY = '__yueduChapterFields';
export const RSS_FIELDS_KEY = '__yueduRssFields';
export const INFOMAP_ENTRIES_KEY = '__yueduInfoMapEntries';
/**
 * worker 规则桥的**预置内容**（`AnalyzeRule.bindings()` → worker `ruleState.content`）。
 *
 * 上游语义：`bindings["java"] = this`（AnalyzeRule.kt:895）⇒ 脚本里
 * `java.getElements(rule)`（不带 mContent）读的是**实例当前 content**
 * （引擎跑 `@js:` 正文/目录规则前已 `setContent` 章节页）。
 * worker 侧 `ruleState.content` 只有脚本显式 `java.setContent` 才有值——
 * 不预置的话，不调 setContent 的脚本（实测包子漫画系 `@js:` 正文：
 * `java.getElements('class.comic-contain@amp-img')`）在**空内容**上求值 ⇒ 恒空 ⇒ 正文 0 段。
 */
export const RULE_CONTENT_KEY = '__yueduRuleContent';
/**
 * **JSON 上下文标记**（`#628`，宿主侧路由用，worker 侧不消费）。
 *
 * 为什么需要：`documentNeedsL1` 里有一句 `if (!hasContentString) return true` ——
 * 内容是「非字符串」时无条件留 L1，理由是「HTML 内容可能要靠 `document` 解析」。
 * 但 **JSON 上下文**（`AnalyzeRule.isJson`，内容已解析成对象）里 `document` 指向的是
 * 渲染页 DOM，与内容无关，`document` 出现与否都不构成「必须 L1」的理由。
 *
 * 实测代价（七猫 3.9.61，1627 章目录）：jsLib 56KB 里 36 处 `document` 全在**段评 UI 的
 * HTML 载荷字符串**里（`script='<script>…'`，这边永不执行），而 `#536b` 的可达性分析
 * 本来已能判定「不可达 ⇒ 可进 worker」—— 却被上面那句短路绕过（目录求值的 content 是
 * JSON 元素）⇒ 1612 章逐章回 L1 ⇒ `l1-eval` 1617 次 / 4.8s，目录 12s。
 * 带上本标记后，JSON 上下文不再被该短路拦截，改由可达性分析决定。
 */
export const JSON_CTX_KEY = '__yueduJsonCtx';
/** 只给宿主用的原始 infoMap（Map 实例不可克隆，不进 worker，只用来服务 worker 的写入 RPC） */
export const INFOMAP_RAW_KEY = '__yueduInfoMapRaw';

export interface AnalyzeEnv {
  baseUrl?: string;
  /** @put / @get / {{}} 的变量作用域（简化版单一作用域） */
  variables: VariableStore;
  /** <js> / {{}} 求值器 */
  jsEval: JsEvaluator;
  /** URL 绝对化（href/src 用），不传则原样返回 */
  toAbsolute?: (url: string) => string;
  /**
   * java 桥扩展点（AnalyzeRule 实例注入 ruleApi：getElements/getStringList/setContent…）。
   * java Proxy 的 fallback 在查完自身桩后查这里——Legado `bindings["java"] = this` 的等价实现。
   */
  javaExtra?: Record<string, unknown>;
  /** 同步 JS 求值器（java.getElements 等同步规则桥专用：L1 进程内，无 worker） */
  jsEvalSync?: JsEvaluator;
  /** 实体数据：book/chapter 桩的真实字段（bookUrl/name/author 等，引擎在 detail/toc/content 阶段注入） */
  bookData?: Record<string, unknown>;
  chapterData?: Record<string, unknown>;
  /**
   * RSS 文章实体字段（`RssArticle`——origin/sort/title/link/pubDate/description/image/type）。
   *
   * 上游 `Rss.analyzeContentPage` 用 `AnalyzeRule(rssArticle, rssSource)` —— **ruleData 就是 rssArticle**，
   * 所以 ruleContent / nextContentUrl 规则里能读文章字段（本仓 bindings 的 `rssArticle.*`、worker 的
   * `__yueduRssFields`）。不注入 ⇒ RSS 正文规则里的 `rssArticle.link` 恒为空串（静默失败形态）。
   */
  rssData?: Record<string, unknown>;
  /**
   * 源实体（Legado `bindings["source"] = source`，AnalyzeRule.kt:898）——
   * 源脚本常写 source.bookSourceUrl / source.loginUrl / source.getKey()。
   */
  sourceData?: Record<string, unknown>;
  /**
   * `sourceData` 的**可结构化克隆字段快照**（只含原始值，丢掉方法）。
   *
   * 用途：worker 池执行脚本时，`sourceData` 是 Proxy/含方法 → 不可跨 postMessage。
   * 引擎把它压成纯字段快照，worker 侧据 `__yueduSourceFields` 重建出「方法齐全、
   * 读写经 RPC 回流宿主」的等价 source（见 `sandbox/worker-pool.ts` 的 __yueduPrepareBindings）。
   * 这样「会发同步 HTTP 的脚本」才能离开 L1（L1 的 execFileSync 会阻塞事件循环）。
   */
  sourceFields?: Record<string, unknown>;
  /**
   * 目录是否来自详情页（Legado `bindings["fromBookInfo"]`，AnalyzeRule.kt:907）。
   * 影响 preUpdateJs 里的 refreshTocUrl（同页已加载 → 跳过重复加载）。
   */
  fromBookInfo?: boolean;
  /**
   * `@put:{k:v}` 的落点钩子（Legado `AnalyzeRule.putRule` → `put()`）。
   *
   * 不提供时退化为「只写 `variables`」= 仅本次请求可见。引擎会注入一个**持久**落点
   * （同时并入源变量 JSON），因为 Legado 里 `@put` 写的是随 Book 存活的内存变量，
   * 会跨阶段/跨请求被 `@get:{k}` 读到（语料里 4 个源正是这种跨请求用法）。
   */
  putVariable?: (key: string, value: string) => void;
  /**
   * `@webjs:` 规则模式的渲染通道（对齐 Legado `AnalyzeRule.getWebJsResult`，:180-199）：
   * 把 `html` 当文档、以 `baseUrl` 为 origin、执行 `js`，返回**脚本返回值**。
   * 宿主注入时通常复用 `EngineContext.renderHtmlScript`（CDP）。
   *
   * 不注入或抛错 ⇒ 该段**降级为空串**并留痕（`@webjs degraded`），不再让整个字段求值炸掉
   * —— `@webjs:` 需要真浏览器（非 L1 能力范围），但「一处不支持」不该毁掉整条规则。
   */
  webJsRender?: (html: string, baseUrl: string, js: string) => Promise<string>;
}

/** 单条 SourceRule（对齐 Legado 内部类 SourceRule 的关键字段） */
export interface CompiledRule {
  mode: RuleMode;
  /** 去掉 @put / 解析 {{}} 之前的原始 rule 文本 */
  rawRule: string;
  /** @put:{...} 收集到的变量（key → 待求值的规则串） */
  putMap: Record<string, string>;
  /** ## 三段清洗：replaceRegex */
  replaceRegex: string;
  /** ## 三段清洗：replacement */
  replacement: string;
  /** ## 四段：仅替换首个匹配 */
  replaceFirst: boolean;
}

/**
 * 绑定槽：**`document` 的惰性工厂**（挂账 `#92`，2026-09-24）。
 *
 * 为什么用「符号 + 工厂」而不是直接把 `document` 放进 bindings：
 * 求值器是用 `{...thisScope, ...bindings}`（对象展开）把绑定摊进 `full` 再 `Object.assign`
 * 到 `globalThis` 的 —— 展开会**立刻执行 getter**，于是「只在脚本真读到 document 时才解析」
 * 这个前提就破了（会退化成「每段 JS 都先解析一遍内容」，正是缺陷类 R 的老毛病）。
 * 所以这里传一个**工厂函数**，由求值器在 globalThis 上用 `Object.defineProperty` 定义成
 * **惰性 getter**（见 `js.ts` 的 l1Eval）：解析只发生在脚本真的读 `document` 那一刻。
 */
export const DOCUMENT_THUNK = Symbol('yuedu.documentThunk');
