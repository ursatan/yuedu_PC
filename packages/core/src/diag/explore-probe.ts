/**
 * `#556` **发现规则探针：`exploreUrl` 到底产出了什么**（无 LLM）。
 *
 * 背景（用户 2026-10-21 的评审）：`exploreUrl` 不是一个「选择器」，它是
 * **会产出一张分类表的东西** —— 可以是 `@js:`/`<js>` 脚本、JSON/JS 对象字面量数组、
 * 或「名称::URL」按 `&&`/换行切分的文本（三种形态见引擎 `parseExploreKinds`）。
 * 于是「试跑它」不能用字段试跑那一套（拿规则去匹配页面），必须：
 *  ① 先判**形态**（js / json / text）；
 *  ② 真跑一次（js 走与引擎同一个求值器），把**产出**摊开给用户看：几个分类、每个的 title/url；
 *  ③ 产出不是「分类表」时，说清**哪里不对**，并给**可点的纠正**（字节级补丁，不重排格式）。
 *
 * 纪律：
 *  · 求值**只走** `makeProbeEnv`（`diag/probe.ts`）—— 与字段试跑同一个源桩、同一套 `java.*` 桩，
 *    否则「发现试跑」与「字段试跑」会给出两套口径（`#158`/`#313` 的老教训）。
 *  · **不猜 URL**：静态构造不出的插值（`{{$.id}}`）由服务端如实报「需真跑」，这里只回原文。
 *  · 自动纠正**只修明确的语法错**（全角标点、`::` 误用、缺逗号、尾逗号、括号未闭合），
 *    不做「语义重写」（把 `name::url` 文本改写成 JSON 数组那种属于替用户写规则）。
 */

import { makeProbeEnv } from './probe';
import type { JsSandboxPool } from '../contract/engine';
// `#561` 判据外移到叶子模块（Web 前端也要用同一份；此处 re-export 保持既有导入面）
import { isSelfFetchingRule as _isSelfFetchingRule } from './self-fetch';
export { isSelfFetchingRule } from './self-fetch';
void _isSelfFetchingRule;

/** `exploreUrl` 的三种形态 + 空 */
export type ExploreRuleKind =
  /** `@js:` / `<js>…</js>` 全包：要真跑 */
  | 'js'
  /** 以 `[` / `{` 开头：JSON 或 JS 对象字面量数组 */
  | 'json'
  /** 其余：`名称::URL` 按 `&&`/换行切分 */
  | 'text'
  | 'empty';

/** 形态判据（只这一处；引擎 `parseExploreKinds` 的顺序与它一致） */
export function classifyExploreRule(raw: unknown): ExploreRuleKind {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 'empty';
  if (/^@js:/i.test(s) || /^<js>/i.test(s)) return 'js';
  if (s.startsWith('[') || s.startsWith('{')) return 'json';
  return 'text';
}

/** 一条分类（对齐 Legado ExploreKind 的可显示子集） */
export interface ExploreKindOut {
  title: string;
  url?: string;
  /** `url`（默认）/ `text` / `button` / `toggle` / `select` */
  type?: string;
  /** 不可点（分组标题：`type=text` 或 url 为空） */
  header?: boolean;
  chars?: string[];
  /** 人话备注（分组标题 / 缺 title / 相对 URL…） */
  note?: string;
}

/** 一条问题（`fixable` 的才给「自动纠正」按钮） */
export interface ExploreProblem {
  code: string;
  message: string;
  /** 这一条是不是「语法错」（能机械修复）；语义问题（缺 title、url 为空）一律 false */
  fixable: boolean;
}

/** 一处纠正（给用户看「改了什么」，不是黑箱） */
export interface ExploreFix {
  code: string;
  detail: string;
  count: number;
}

export interface ExploreProbeResult {
  ok: boolean;
  kind: ExploreRuleKind;
  /** 求值/解析后的原始产出（截断，人眼复核用） */
  raw: string;
  kinds: ExploreKindOut[];
  problems: ExploreProblem[];
  /** 自动纠正后的全文（没有可修项时缺省） */
  fixed?: string;
  fixes?: ExploreFix[];
  /** 失败/无法判定的人话原因 */
  error?: string;
  ms: number;
  /** 可点分类数（引擎拿第一个可点分类的 url 去取页） */
  clickable: number;
  /**
   * `#559` **列表规则是不是「自取数」**（`<js>`/`@js:` 里自己 `java.ajax` 请求接口）。
   *
   * 七猫官方这类 API 源：分类 url（`/hall-of-fame?gender=1&page=1`）只是个**路由提示**，
   * 页面本身 404 是正常的 —— 数据由 `bookList` 里的 JS 拼真实接口
   * （`/api/v1/h5/hall-of-fame/list?gender=1`）再 `java.ajax` 取。
   * 所以「页面打不开」不能当成源坏了（那是 `#559` 之前的误判）。
   */
  selfFetching?: boolean;
  /** 自取数列表**实跑结果**（页面拿不到时也能看到列表项） */
  selfFetch?: { rule: string; ok: boolean; count: number; samples: string[]; error?: string };
  /** 页面这一层的说明（404 但自取数 / 动态渲染成功等），与 problems 分开 */
  pageNote?: string;
}

/**
 * `#559` 判定「自取数列表规则」的实现**已外移**到 `diag/self-fetch.ts`（叶子模块，
 * Web 前端共用同一份判据 —— `#561`）；上面 re-export 保持既有导入面。
 */

/* ------------------------------------------------------------------ */
/* 语法扫描与自动纠正                                                   */
/* ------------------------------------------------------------------ */

/**
 * 括号平衡扫描（**跳过字符串内部**）。
 *
 * 为什么不能直接数 `[` `]` 的个数：URL / 正则 / 文本里常有这些字符，
 * `'https://x.com/[id]'` 会凭空多出两个括号，于是「未闭合」误报、自动补括号反而弄坏原文。
 */
function bracketBalance(s: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[') open++;
    else if (c === '}' || c === ']') close++;
  }
  return { open, close };
}

/**
 * **自动纠正**（字节级补丁，只修语法错）。
 *
 * `mode` 决定「哪些算错」——两种形态的语法**不一样**，混着修会把对的改坏：
 *  · `json`（对象数组）：全角标点、`::` 误用、尾逗号、漏逗号、括号未闭合；
 *  · `text`（`名称::URL`）：`::` 是**正确分隔符**，绝不能当错；这里只修 `：：`/`：` 这类
 *    全角冒号误写（`完结：：/wanjie/`）。逗号在标题里很常见，同样不动。
 *
 * 顺序有意义：先全角标点 → 再 `::` → 再尾逗号 → 再漏逗号 → 最后补括号。
 * 反过来的话「全角逗号」会被当成普通字符，`}{` 之间仍缺逗号。
 */
export function autoCorrectExploreRule(
  raw: string,
  mode: 'json' | 'text' = 'json',
): { text: string; fixes: ExploreFix[] } {
  let s = raw;
  const fixes: ExploreFix[] = [];
  const rep = (re: RegExp, to: string, code: string, detail: string) => {
    const before = s;
    s = s.replace(re, to);
    if (s !== before) {
      const n = (before.match(re) ?? []).length;
      fixes.push({ code, detail, count: n || 1 });
    }
  };

  if (mode === 'text') {
    // 文本形态只修「分隔符写成了全角」：`：：`（两个全角冒号）与 `::` 前的单个全角冒号
    rep(/：：/g, '::', 'wide-colon', '分类分隔符写成了全角「：：」→ 半角「::」');
    return { text: s, fixes };
  }

  // ① 全角标点（中文输入法最常见的坑；在 JSON 里全部非法）
  rep(/：/g, ':', 'wide-colon', '全角冒号「：」→ 半角「:」');
  rep(/，/g, ',', 'wide-comma', '全角逗号「，」→ 半角「,」');
  rep(/[“”]/g, '"', 'wide-quote', '中文双引号「“ ”」→ 半角「"」');
  rep(/[‘’]/g, "'", 'wide-single-quote', '中文单引号「‘ ’」→ 半角 "\'"');
  // ② 键名后误用 `::`（`title:: "完结小说"`）—— 分类列表是**对象数组**，不是 `名称::URL` 文本
  rep(/(["']?[\w$\u4e00-\u9fa5]+["']?)\s*::\s*/g, '$1: ', 'double-colon', '键名后的「::」→「:」（`::` 只用于「名称::URL」文本形态）');
  // ③ 尾逗号（`{a:1,}` / `[1,2,]`）
  rep(/,\s*([\]}])/g, '$1', 'trailing-comma', '去掉 `]` / `}` 前多余的逗号');
  // ④ 漏逗号：`}{` / `}{ "` / `}"`
  rep(/([}\]])\s*(\{)/g, '$1, $2', 'missing-comma', '相邻对象之间漏了「,」');
  rep(/(\})\s*(")/g, '$1, $2', 'missing-comma', '对象与下一个键之间漏了「,」');
  rep(/(["'\]\d])\s*(\{)/g, '$1, $2', 'missing-comma', '值后面紧跟 `{` 但漏了「,」');

  // ⑤ 括号未闭合 ⇒ 在末尾补齐（只补「开多于闭」，闭多于开不能靠补修）
  const bal = bracketBalance(s);
  if (bal.open > bal.close) {
    const need = bal.open - bal.close;
    // 顺序按「最后打开的先关」近似：统一补 `]`，因为 exploreUrl 的外层必然是数组
    const hasOuterArray = s.trim().startsWith('[');
    s = s.trimEnd() + (hasOuterArray ? ']'.repeat(need) : '}'.repeat(need));
    fixes.push({ code: 'unbalanced', detail: `括号未闭合：末尾补了 ${need} 个${hasOuterArray ? '「]」' : '「}」'}（请复核位置）`, count: need });
  }
  return { text: s, fixes };
}

/** 纠正没修掉的问题（给了 `fixed` 后仍存在的那些）——用来提示「还有语义问题要你自己定」 */
function residualProblems(kinds: ExploreKindOut[]): ExploreProblem[] {
  const out: ExploreProblem[] = [];
  const noTitle = kinds.filter((k) => !k.title.trim()).length;
  if (noTitle) out.push({ code: 'NO_TITLE', message: `${noTitle} 个分类没有 title（发现页会显示成空标签）`, fixable: false });
  const noUrl = kinds.filter((k) => !k.url && (!k.type || k.type === 'url')).length;
  if (noUrl) {
    out.push({
      code: 'NO_URL',
      message: `${noUrl} 个分类没有 url —— 引擎会把它当**分组标题**（不可点）。若本意是可点分类，补 url`,
      fixable: false,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 真跑：把 exploreUrl 求值成分类表                                     */
/* ------------------------------------------------------------------ */

/** 文本形态 `名称::URL` 按 `&&`/换行切分（与引擎 `parseExploreKinds` ③ 同口径） */
function splitTextKinds(s: string): ExploreKindOut[] {
  return s
    .split(/&&|\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('::');
      if (idx <= 0) return { title: line, header: true, note: '没有 `::`：引擎会当成不可点的分组标题' };
      const url = line.slice(idx + 2).trim();
      return { title: line.slice(0, idx).trim(), ...(url ? { url } : {}), ...(url ? {} : { header: true, note: '`::` 后面是空的' }) };
    });
}

/** 归一一条分类（对齐引擎 `normalizeKind`，只保留展示需要的字段） */
function normalizeKind(raw: unknown): ExploreKindOut | undefined {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return undefined;
    const idx = s.indexOf('::');
    return idx > 0 ? { title: s.slice(0, idx).trim(), url: s.slice(idx + 2).trim() || undefined } : { title: s, header: true };
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const title = o['title'] == null ? '' : String(o['title']);
  const urlRaw = o['url'];
  const url = urlRaw == null || urlRaw === '' ? undefined : String(urlRaw);
  const type = o['type'] == null ? undefined : String(o['type']);
  const chars = Array.isArray(o['chars']) ? (o['chars'] as unknown[]).filter((c) => c != null).map(String) : undefined;
  if (!title && !url) return undefined;
  return {
    title,
    ...(url ? { url } : {}),
    ...(type && type !== 'url' ? { type } : {}),
    ...(url || (type && type !== 'url') ? {} : { header: true }),
    ...(chars && chars.length ? { chars } : {}),
    ...(url ? {} : { note: type && type !== 'url' ? `交互控件（${type}）` : '不可点（无 url）' }),
  };
}

export interface ExploreProbeRequest {
  /** `exploreUrl` 原文 */
  raw: string;
  /** 源原始 JSON（桩由 `makeProbeEnv` 建，与字段试跑同一份） */
  source?: Record<string, unknown>;
  lib?: string;
  pool?: JsSandboxPool & { __yueduWorkerPool?: boolean };
  /** 源 URL（`url` 里写相对路径时，前端据此拼绝对地址；也作为 js 的 baseUrl） */
  baseUrl?: string;
  /** 交互输入态（`infoMap`，Legado 的分类筛选历史）。探针**不读盘**，缺省空 */
  infoMap?: Record<string, string>;
}

/**
 * **跑一次 `exploreUrl`**：形态判定 → 求值/解析 → 校验 → 给纠正建议。
 *
 * 与引擎的关系：`@js:` 走 `env.jsEval`（同一条 L1/worker 分流），JSON 走 `JSON.parse`
 * 再回落 `jsEval('(...)')`（JS 对象字面量），文本走 `名称::URL` 切分 —— 三步与
 * `parseExploreKinds` 一一对应，**顺序和回落都一样**（否则「试跑通过、真跑 0 分类」）。
 */
export async function probeExplore(req: ExploreProbeRequest): Promise<ExploreProbeResult> {
  const t0 = Number(process.hrtime.bigint() / 1_000_000n);
  const raw = typeof req.raw === 'string' ? req.raw : '';
  const kind = classifyExploreRule(raw);
  const base: ExploreProbeResult = { ok: false, kind, raw: '', kinds: [], problems: [], ms: 0, clickable: 0 };
  if (kind === 'empty') {
    return { ...base, error: '发现地址为空：这个源没有发现页（不是错误，只是没有）' };
  }

  /** 统一出口：从「已解析出的分类 + 备注」收口成结果 */
  const finish = (kinds: ExploreKindOut[], rawText: string, extra?: Partial<ExploreProbeResult>): ExploreProbeResult => {
    const clickable = kinds.filter((k) => k.url).length;
    const problems: ExploreProblem[] = [...(extra?.problems ?? []), ...residualProblems(kinds)];
    // 相对 URL：引擎按源 URL 绝对化，探针也如实说明（不在这里改写，改写是「替用户做决定」）
    const rel = kinds.filter((k) => k.url && !/^https?:\/\//i.test(k.url) && !/^\{\{/.test(k.url)).length;
    if (rel) {
      problems.push({
        code: 'RELATIVE_URL',
        message: `${rel} 个分类的 url 不是绝对地址（不以 http 开头）：引擎会按源 URL 绝对化，若站点结构不同就会 404`,
        fixable: false,
      });
    }
    if (!kinds.length) {
      problems.push({ code: 'NO_KIND', message: '没有解析出任何分类 —— 引擎会退化成「直接把 exploreUrl 当 URL 模板」', fixable: false });
    }
    return {
      ...base,
      ...extra,
      ok: clickable > 0,
      raw: rawText.length > 4000 ? `${rawText.slice(0, 4000)}…` : rawText,
      kinds,
      clickable,
      problems,
      ms: Number(process.hrtime.bigint() / 1_000_000n) - t0,
    };
  };

  // 语法预检：JSON 形态先扫一遍（**不看结果也能报**，且不受求值失败影响）。
  // ⚠️ 文本形态**不能走 JSON 那套**：`::` 是它的正确分隔符，全角逗号在标题里很常见
  // —— 混着修会把「本来对的」改坏（实测：`完结::url` 被改成 `完结: url`）。
  const syntax: ExploreProblem[] = [];
  if (kind === 'json' || kind === 'text') {
    const { fixes } = autoCorrectExploreRule(raw, kind === 'text' ? 'text' : 'json');
    for (const f of fixes) {
      syntax.push({ code: f.code, message: `${f.detail}（${f.count} 处）—— 可「自动纠正」`, fixable: true });
    }
  }

  try {
    if (kind === 'js') {
      const code = raw.replace(/^@js:/i, '').replace(/^<js>/i, '').replace(/<\/js>$/i, '');
      const { env } = makeProbeEnv({
        ...(req.baseUrl ? { baseUrl: req.baseUrl } : {}),
        ...(req.lib ? { lib: req.lib } : {}),
        ...(req.source ? { source: req.source } : {}),
        ...(req.pool ? { pool: req.pool } : {}),
        vars: {},
      });
      /**
       * bindings **与引擎 `parseExploreKinds` 同一组**：`$` / `infoMap` / `key` / `page` / `source` / `baseUrl`。
       * 特别注意**没有** `host`：语料里 `url: host + '/wanjie/'` 这种写法在真跑里同样是
       * `ReferenceError: host is not defined`（Legado 不注入 host）。探针照实报错，不替它补个 host
       * 让它「试跑通过、真跑失败」。
       * `#579`：`baseUrl` 是 Legado 必带项（`java.connect(baseUrl, header)` 的源都靠它）。
       */
      const infoMap = req.infoMap ?? {};
      const value = await env.jsEval(code, { $: '', infoMap, key: '', page: 1, baseUrl: req.baseUrl ?? '', ...(req.source ? { source: req.source } : {}) });
      return finishFromValue(value, syntax, finish);
    }
    if (kind === 'json') {
      let value: unknown;
      let parseErr: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch (e) {
        parseErr = e;
        // JS 对象字面量回落（与引擎同序）：单引号/无引号键/尾逗号都只有 eval 吃得下
        try {
          const { env } = makeProbeEnv({ vars: {}, ...(req.source ? { source: req.source } : {}) });
          value = await env.jsEval(`(${raw})`, { $: '', infoMap: {}, key: '', page: 1, baseUrl: req.baseUrl ?? '' });
        } catch (e2) {
          const m = e2 instanceof Error ? e2.message : String(e2);
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          //
          // 两种失败都要说清：JSON.parse 的错位更精确（哪一行哪个字符），
          // 而 eval 的错往往是「语法错之后的第一处」——优先报 JSON 的（用户写的多半是想当 JSON）。
          //
          return finish([], raw, {
            problems: [
              ...syntax,
              { code: 'PARSE_ERROR', message: `JSON 解析失败（${msg}）；按 JS 字面量也失败（${m}）`, fixable: syntax.length > 0 },
            ],
            error: '发现地址不是合法的「分类表」',
          });
        }
      }
      return finishFromValue(value, syntax, finish);
    }
    // text：`名称::URL`
    const kinds = splitTextKinds(raw);
    return finish(kinds, raw, { problems: syntax });
  } catch (e) {
    return finish([], raw, {
      problems: syntax,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 求值结果 → 分类表（数组 / JSON 串 / 文本三路），统一走 `finish` */
function finishFromValue(
  value: unknown,
  syntax: ExploreProblem[],
  finish: (k: ExploreKindOut[], t: string, extra?: Partial<ExploreProbeResult>) => ExploreProbeResult,
): ExploreProbeResult {
  if (Array.isArray(value)) {
    const kinds = value.map(normalizeKind).filter((k): k is ExploreKindOut => !!k);
    return finish(kinds, JSON.stringify(value, null, 0), { problems: syntax });
  }
  const text = value == null ? '' : String(value).trim();
  if (!text) {
    return finish([], '', { problems: [...syntax, { code: 'EMPTY_RESULT', message: '脚本执行成功但产出空字符串 —— 分类表为空', fixable: false }] });
  }
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        const kinds = parsed.map(normalizeKind).filter((k): k is ExploreKindOut => !!k);
        return finish(kinds, text, { problems: syntax });
      }
    } catch {
      /* 交给文本切分（脚本可能 return 的本来就是「名称::URL」文本） */
    }
  }
  // 文本形态：与引擎 ③ 同口径
  const kinds = splitTextKinds(text);
  return finish(kinds, text, { problems: syntax });
}
