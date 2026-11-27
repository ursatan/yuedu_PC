/**
 * `#558` **试跑物料的「取页链」**：详情 ← 发现 / 搜索，目录 ← 详情，正文 ← 目录。
 *
 * 用户 2026-10-21 的口径（逐条照抄，别自己发明顺序）：
 *
 * ```
 * 详情：用户给地址 ⇒ 取；不给 ⇒ 从「发现」拿（首个**有地址**的分类的首地址，地址要按 `{{page}}`
 *       表达式算过）⇒ 没有发现规则 ⇒ 从「搜索」拿（自动按默认 key 搜一次，取第 1 页）
 *       ⇒ 取到页后拿**首个**「书籍地址 bookUrl」，相对地址自动补全
 * 目录：用户给地址 ⇒ 取；不给 ⇒ 从「详情」拿「目录地址 tocUrl」，tocUrl 为空则**共用详情页地址**
 * 正文：用户给地址 ⇒ 取；不给 ⇒ 从「目录」拿首章地址取页
 * ```
 *
 * ★ 为什么放在 core 而不是服务端：判据（用哪条规则、什么时候回落、相对地址怎么补）
 * 必须与引擎/探针同一份。服务端只做 IO（`fetch` 由调用方注入），于是这段可以在单测里
 * 用假网页跑完，不起服务、不联网。
 *
 * ★ 诚实边界：这条链**只取「第一本书 / 第一章」**。取到的是「能跑通的样本」，
 * 不代表第 2 本也行（排序、置顶、广告项都会让首项不是典型项）。
 */

import { AnalyzeRule } from '../selector/analyze';
import { resolveUrl } from '../net/url-resolve';
import { makeProbeEnv } from './probe';
import { evalUrlTemplate } from './url-probe';
import { probeExplore } from './explore-probe';
import { detectMaterialKind } from './material-format';
import type { MaterialKind } from './material-format';
// `#561`/`#562` 自取数占位与挑战页判定（与字段试跑/发现试跑同一份判据）
import { isSelfFetchingRule, isChallengePage, SELF_FETCH_PLACEHOLDER } from './self-fetch';

export type MaterialTarget = 'detail' | 'toc' | 'content';

export interface MaterialStep {
  /** 这一步在干什么（`explore` / `search` / `detail` / `toc` / `content` / `bookUrl` …） */
  step: string;
  /** 人话说明：从哪来、用了哪条规则 */
  detail: string;
  url?: string;
  rule?: string;
  /** 取到的状态码（取页失败时没有） */
  status?: number;
  /** 这一步的结论值（例如 bookUrl / tocUrl / chapterUrl） */
  value?: string;
}

export interface MaterialPage {
  content?: string;
  status?: number;
  error?: string;
  /** 取页后的最终地址（跟随跳转后） */
  baseUrl?: string;
}

export interface MaterialRequest {
  target: MaterialTarget;
  /** 用户提供的地址（给了就用它，不走链） */
  url?: string;
  /** 搜索用的关键字（默认 `DEFAULT_MATERIAL_KEYWORD`） */
  keyword?: string;
  /** 源原始 JSON（规则来源） */
  source?: Record<string, unknown>;
  /** 源地址（相对地址按它补全） */
  baseUrl?: string;
  /** jsLib（规则里可能用到） */
  lib?: string;
  /** 取页（调用方注入：服务端带源 cookie，测试给假页面） */
  fetch: (url: string) => Promise<MaterialPage>;
}

export interface MaterialResult {
  ok: boolean;
  target: MaterialTarget;
  url: string;
  content: string;
  status?: number;
  /**
   * 内容形态（前端据此决定格式化方式）。
   *
   * `#681` 起加宽到 `MaterialKind`（多了 `css` / `js`）：判定函数 `detectMaterialKind` 仍只回
   * html/json/text（见其注释：CSS/JS **不自动判定**），但类型与格式化入口保持同一套取值。
   */
  kind: MaterialKind;
  chain: MaterialStep[];
  errors: string[];
  keyword?: string;
  ms: number;
}

/**
 * 自动搜索用的默认关键字。
 *
 * 为什么不是一个具体书名：试跑只需要「能返回结果的任何一次搜索」，`的` 在中文书名里几乎必然命中，
 * 且不含空格/标点（直接拼进 URL 或 body 都安全）。
 */
export const DEFAULT_MATERIAL_KEYWORD = '的';

const ruleOf = (src: Record<string, unknown> | undefined, path: string): string => {
  if (!src) return '';
  let cur: unknown = src;
  for (const k of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === 'string' ? cur.trim() : '';
};

/** 内容形态判定（判据在 `material-format.ts`，格式化与这里共用一份） */
export { detectMaterialKind } from './material-format';

export async function resolveMaterial(req: MaterialRequest): Promise<MaterialResult> {
  const t0 = Date.now();
  const src = req.source ?? {};
  const baseUrl = String(req.baseUrl ?? src['bookSourceUrl'] ?? '').trim();
  const chain: MaterialStep[] = [];
  const errors: string[] = [];
  const keyword = (req.keyword ?? DEFAULT_MATERIAL_KEYWORD).trim() || DEFAULT_MATERIAL_KEYWORD;

  const { env } = makeProbeEnv({
    ...(baseUrl ? { baseUrl } : {}),
    ...(req.lib ? { lib: req.lib } : {}),
    ...(req.source ? { source: req.source } : {}),
    vars: {},
  });

  const bind = (page: number, extra: Record<string, unknown> = {}) => ({
    $: '', result: '', key: keyword, page, baseUrl, ...(req.source ? { source: req.source } : {}), ...extra,
  });
  const evalCtx = {
    evalExpr: async (expr: string, b: { page: number }) => env.jsEval(expr, bind(b.page)),
    evalJsSegment: async (code: string, current: string) => {
      const v = await env.jsEval(code, { ...bind(1), result: current });
      return v == null ? null : String(v);
    },
  };

  const done = (url: string, content: string, status?: number): MaterialResult => ({
    ok: !!content,
    target: req.target,
    url,
    content,
    ...(status != null ? { status } : {}),
    kind: detectMaterialKind(content),
    chain,
    errors,
    ...(req.target === 'detail' || req.target === 'toc' || req.target === 'content' ? { keyword } : {}),
    ms: Date.now() - t0,
  });

  /** 在一份页面上按规则取第一个非空值（`isUrl` 决定要不要补全相对地址） */
  const firstValue = async (content: string, pageUrl: string, rule: string, isUrl = false): Promise<string> => {
    if (!rule.trim()) return '';
    const ar = new AnalyzeRule(env).setContent(content, pageUrl);
    const v = await ar.getString(rule, isUrl);
    return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  };

  const fetchPage = async (url: string, why: string): Promise<{ url: string; content: string } | null> => {
    const got = await req.fetch(url);
    if (got.error || !got.content) {
      errors.push(`${why}取页失败：${got.error ?? '空响应'}（${url}）`);
      chain.push({ step: 'fetch', detail: `${why}取页失败`, url, ...(got.error ? { value: got.error } : {}) });
      return null;
    }
    /**
     * `#559` **4xx/5xx 的响应体不能当物料**（错误页冒充页面 = 最坏的静默）。
     * 七猫那种接口站，路由不对时正文就是 `404 page not found`，拿它当详情页会让后面全空。
     */
    if ((got.status ?? 0) >= 400) {
      // `#561` 不同状态码的**含义不同**，别一律说成「地址不对」（401/403 是鉴权，404 才是路由）
      const st = got.status ?? 0;
      /**
       * `#565` **403 的响应体是挑战页时，先说盾**（138阅读网实测：冷路径回 403「正在检查
       * 您的浏览器」，旧文案说成「站点要鉴权/签名」——把用户引去找令牌，而真因是没过 CF）。
       * 判据与发现试跑同一份（`isChallengePage`，只看内容特征）。
       */
      const chal = isChallengePage(got.content ?? '');
      const why2 = chal.challenge
        ? `拿到的是**挑战/校验页**（${chal.via ?? '站点安全校验'}）—— 站点要过盾，不是地址写错、也不是缺令牌（服务端会自动拉浏览器重试）`
        : st === 401 || st === 403
          ? '站点要鉴权/签名（试跑用的是本机直连，没有 app 的会话令牌），不是地址写错'
          : st >= 500
            ? '站点侧错误（5xx），不是地址写错'
            : '地址/路由不对';
      errors.push(`${why}取页 HTTP ${st}（${url}）：${why2}，错误页不能当物料`);
      chain.push({ step: 'fetch', detail: `${why} HTTP ${st}（${why2}）`, url, status: st });
      return null;
    }
    const finalUrl = got.baseUrl ?? url;
    chain.push({ step: 'fetch', detail: why, url: finalUrl, ...(got.status != null ? { status: got.status } : {}) });
    return { url: finalUrl, content: got.content };
  };

  /* ---------------- ① 入口地址：用户给的 / 发现 / 搜索 ---------------- */
  let entryUrl = String(req.url ?? '').trim();
  if (entryUrl) {
    chain.push({ step: 'entry', detail: '用户提供的物料地址', url: entryUrl });
  }

  /**
   * 详情链的入口：先「发现」，没有发现规则再「搜索」。
   * ⚠️ 顺序来自用户口径，不能颠倒：发现页的分类列表比搜索结果更接近「我要的那个列表」。
   */
  const entryFromExploreOrSearch = async (): Promise<string> => {
    const exploreRaw = String(src['exploreUrl'] ?? '').trim();
    if (exploreRaw) {
      const pr = await probeExplore({
        raw: exploreRaw,
        ...(req.source ? { source: req.source } : {}),
        ...(req.lib ? { lib: req.lib } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      });
      const kinds = pr.kinds.filter((k) => k.url);
      if (kinds.length) {
        // 「首个**有地址**的分类」——空 url 的分类是分组标题，跳过
        const k = kinds[0]!;
        const ev = await evalUrlTemplate(String(k.url), { keyword, page: 1, baseUrl, ...evalCtx });
        chain.push({
          step: 'explore',
          detail: `发现页首个分类「${k.title}」的首页地址${ev.errors.length ? `（有未求值项：${ev.errors.join('；')}）` : ''}`,
          url: ev.url,
          rule: String(k.url),
        });
        if (ev.url) return ev.url;
        errors.push(`发现分类「${k.title}」的地址算不出来`);
      } else {
        chain.push({ step: 'explore', detail: `发现规则解析出 ${pr.kinds.length} 个分类，但**没有一个带地址**（都是分组标题？）` });
        errors.push('发现页没有可点分类');
      }
    }

    const searchRaw = String(src['searchUrl'] ?? '').trim();
    if (!searchRaw) {
      errors.push('源里既没有发现规则、也没有搜索规则：给不出详情入口地址');
      return '';
    }
    const ev = await evalUrlTemplate(searchRaw, { keyword, page: 1, baseUrl, ...evalCtx });
    chain.push({ step: 'search', detail: `自动搜索（key=${keyword}）第 1 页地址`, url: ev.url, rule: searchRaw });
    if (!ev.url) {
      errors.push('搜索地址算不出来');
      return '';
    }
    return ev.url;
  };

  /**
   * 在「列表页」上取首个书籍地址（发现侧与搜索侧的列表规则不同口径，见下）。
   *
   * `#561` `page.content` 允许是**自取数占位**（页面 4xx / 网络错拿不到正文时）：
   * 自取数 JS 不读页面内容（自己发请求），`baseUrl` 仍要给真 —— 七猫的 JS 从
   * `baseUrl` 里解析 `gender=` / `hall-of-fame` 等路由参数。
   * `#562` 页面内容是**挑战页**时规则照跑（规则里自带过盾逻辑的源，如黄金屋种
   * `__sc_clearance` 后重抓，能自愈）；0 命中的报错文案按「挑战页」说事，不再误导成规则错。
   */
  const firstBookUrl = async (page: { url: string; content: string }, from: 'explore' | 'search'): Promise<string> => {
    const exploreList = ruleOf(src, 'ruleExplore.bookList');
    const searchList = ruleOf(src, 'ruleSearch.bookList');
    /**
     * 引擎口径（`#556` 已锁）：`ruleExplore.bookList` 为空 ⇒ **整个 `ruleExplore` 被 `ruleSearch` 取代**；
     * 非空则只用 `ruleExplore`（留空字段不会回落到搜索）。这里照同一口径选规则，否则试跑与真跑分叉。
     */
    const useExplore = from === 'explore' && !!exploreList;
    const listRule = useExplore ? exploreList : searchList;
    const bookUrlRule = useExplore ? ruleOf(src, 'ruleExplore.bookUrl') : ruleOf(src, 'ruleSearch.bookUrl');
    if (!listRule) {
      errors.push(`${from === 'explore' ? '发现' : '搜索'}侧没有列表规则（bookList），取不到书籍地址`);
      return '';
    }
    // `#561` 页面没拿到正文（4xx/网络错）但列表规则自己会发请求 ⇒ 占位继续跑；否则就别白跑
    const selfFetch = !page.content && isSelfFetchingRule(listRule);
    if (!page.content && !selfFetch) {
      errors.push(`${from === 'explore' ? '发现' : '搜索'}页没有正文，且列表规则不是自取数 JS —— 取不到书籍地址`);
      return '';
    }
    const ar = new AnalyzeRule(env).setContent(selfFetch ? SELF_FETCH_PLACEHOLDER : page.content, page.url);
    const got = (await ar.getElements(listRule)) as unknown;
    const items = (Array.isArray(got) ? got : got == null ? [] : [got]) as unknown[];
    if (!items.length) {
      const chal = isChallengePage(page.content);
      errors.push(
        chal.challenge
          ? `列表规则 ${listRule} 在页面上 0 命中 —— 拿到的是**挑战/校验页**（${chal.via}），不是正文。` +
            `可勾选「动态取页」让浏览器过盾后重取，或用「登录」窗口过一次盾再试。`
          : `列表规则 ${listRule} 在${from === 'explore' ? '发现' : '搜索'}页 0 命中`,
      );
      return '';
    }
    if (!bookUrlRule) {
      errors.push(`${from === 'explore' ? '发现' : '搜索'}侧没有「书籍地址」规则（bookUrl）`);
      return '';
    }
    const sub = new AnalyzeRule(env).setContent(items[0]);
    const raw = await sub.getString(bookUrlRule, true);
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) {
      errors.push(`第 1 项按 ${bookUrlRule} 取不到书籍地址（列表命中 ${items.length} 项）`);
      return '';
    }
    // `getString(rule, true)` 已按 baseUrl 补全，这里再兜一次（规则可能是纯 JS 拼串）
    const abs = /^https?:\/\//i.test(v) ? v : resolveUrl(baseUrl, v);
    chain.push({
      step: 'bookUrl',
      detail: selfFetch
        ? `页面没拿到正文，列表规则为**自取数 JS** 已直接执行 —— 第 1 项（共 ${items.length} 项）的书籍地址`
        : `第 1 项（共 ${items.length} 项）的书籍地址`,
      rule: bookUrlRule,
      value: abs,
      url: abs,
    });
    return abs;
  };

  /* ---------------- ② 目标 = 详情 ---------------- */
  if (req.target === 'detail') {
    if (!entryUrl) entryUrl = await entryFromExploreOrSearch();
    if (!entryUrl) return done('', '');
    const entry = await fetchPage(entryUrl, '详情页');
    if (!entry) {
      /**
       * `#561` **页面拿不到 ≠ 链就断了**：列表规则是自取数 JS 时（七猫这类 API 源，
       * 分类页 404 是正常形态），直接执行列表规则拿第 1 项的书籍地址，照样能取到详情物料 ——
       * 否则详情/目录/正文三个 tab 全部连锁拿不到物料。
       */
      if (!req.url) {
        const bu = await firstBookUrl({ url: entryUrl, content: '' }, String(src['exploreUrl'] ?? '').trim() ? 'explore' : 'search');
        if (bu) {
          const dp = await fetchPage(bu, '详情页（自取数列表第 1 项）');
          if (dp) return done(dp.url, dp.content, 200);
        }
      }
      return done('', '');
    }
    const isListPage = !req.url; // 只有「从列表页自动取」时才需要在页面上再抽 bookUrl
    if (isListPage) {
      const bu = await firstBookUrl(entry, String(src['exploreUrl'] ?? '').trim() ? 'explore' : 'search');
      /**
       * 发现页取到的 bookUrl 就是详情地址；若入口本来就是**搜索页**，同样如此。
       * 取不到就**退回列表页**（至少让人能看到页面、自己点进一本）——
       * 但要在 errors 里说清，不能让「列表页」冒充「详情页」。
       */
      if (bu && bu !== entryUrl) {
        const dp = await fetchPage(bu, '详情页（来自列表第 1 项）');
        if (dp) return done(dp.url, dp.content, 200);
        errors.push('列表第 1 项的书籍地址取页失败，已退回列表页作为物料');
      }
    }
    return done(entry.url, entry.content, 200);
  }

  /* ---------------- ③ 目标 = 目录 ---------------- */
  if (req.target === 'toc') {
    let detailUrl = String(req.url ?? '').trim();
    let detailContent = '';
    if (!detailUrl) {
      const d = await resolveMaterial({ ...req, target: 'detail', url: undefined });
      detailUrl = d.url;
      detailContent = d.content;
      chain.push(...d.chain.map((s) => ({ ...s, step: `detail:${s.step}` })));
      errors.push(...d.errors);
      if (!detailUrl) return done('', '');
    }
    let tocUrl = '';
    if (detailContent) {
      const rule = ruleOf(src, 'ruleBookInfo.tocUrl');
      if (rule) {
        const v = await firstValue(detailContent, detailUrl, rule, true);
        if (v) {
          tocUrl = /^https?:\/\//i.test(v) ? v : resolveUrl(baseUrl, v);
          chain.push({ step: 'tocUrl', detail: '详情页的「目录地址」', rule, value: tocUrl });
        } else {
          errors.push(`「目录地址」规则 ${rule} 在详情页取不到值`);
        }
      } else {
        chain.push({ step: 'tocUrl', detail: '源没有写「目录地址」(tocUrl) ⇒ 与详情页共用同一地址' });
      }
    }
    const target = tocUrl || detailUrl;
    if (!target) return done('', '');
    if (tocUrl && tocUrl !== detailUrl && detailContent) {
      const tp = await fetchPage(target, '目录页');
      if (tp) return done(tp.url, tp.content, 200);
      errors.push('目录地址取页失败，已退回详情页作为物料');
    } else if (detailContent) {
      // 共用详情页地址：内容已经取到了，不必再取一次
      return done(detailUrl, detailContent, 200);
    }
    const tp = await fetchPage(target, '目录页');
    return tp ? done(tp.url, tp.content, 200) : done('', '');
  }

  /* ---------------- ④ 目标 = 正文 ---------------- */
  let tocUrl = String(req.url ?? '').trim();
  let tocContent = '';
  if (!tocUrl) {
    const t = await resolveMaterial({ ...req, target: 'toc', url: undefined });
    tocUrl = t.url;
    tocContent = t.content;
    chain.push(...t.chain.map((s) => ({ ...s, step: `toc:${s.step}` })));
    errors.push(...t.errors);
    if (!tocUrl) return done('', '');
  }
  let chapterUrl = '';
  if (tocContent) {
    const listRule = ruleOf(src, 'ruleToc.chapterList');
    const chUrlRule = ruleOf(src, 'ruleToc.chapterUrl');
    if (!listRule) {
      errors.push('目录侧没有章节列表规则（chapterList）');
    } else if (!chUrlRule) {
      errors.push('目录侧没有章节地址规则（chapterUrl）');
    } else {
      const ar = new AnalyzeRule(env).setContent(tocContent, tocUrl);
      const got = (await ar.getElements(listRule)) as unknown;
      const items = (Array.isArray(got) ? got : got == null ? [] : [got]) as unknown[];
      if (!items.length) {
        errors.push(`章节列表 ${listRule} 0 命中（目录页可能不是目录页）`);
      } else {
        const sub = new AnalyzeRule(env).setContent(items[0]);
        const raw = await sub.getString(chUrlRule, true);
        const v = typeof raw === 'string' ? raw.trim() : '';
        if (v) {
          chapterUrl = /^https?:\/\//i.test(v) ? v : resolveUrl(baseUrl, v);
          chain.push({ step: 'chapterUrl', detail: `首章的章节地址（列表命中 ${items.length} 章）`, rule: chUrlRule, value: chapterUrl });
        } else {
          errors.push(`第 1 章按 ${chUrlRule} 取不到地址`);
        }
      }
    }
  }
  const target = chapterUrl || tocUrl;
  if (!target) return done('', '');
  const cp = await fetchPage(
    target,
    chapterUrl ? '正文页（首章）' : req.url ? '正文页' : '正文页（退回目录页：取不到首章地址）',
  );
  return cp ? done(cp.url, cp.content, 200) : done('', '');
}
