/**
 * `#625` **URL → 书源识别**（粘贴一只书籍链接 ⇒ 自动选出该用哪个源）
 *
 * 逐条对齐上游 `F:\legado\app\src\main\java\io\legado\app\ui\main\bookshelf\BookshelfViewModel.kt:49-110`
 * （`addBookByUrl`）与它用到的两个 DAO 查询 / 工具函数：
 *
 * ```
 * ① ,{options} 尾巴里显式指定了 origin ⇒ 取那只源（并要求 bookUrlPattern 也命中）
 * ② 否则按域名（getBaseUrl）找书源 —— bookSourceUrl == baseUrl
 * ③ 还没有 ⇒ 遍历「所有启用且配了 bookUrlPattern」的源，整串匹配，第一个命中即用
 * ```
 *
 * ## 为什么这条链才是 bookUrlPattern 的主战场
 * `#617` 已经把「搜索响应 URL 命中 pattern ⇒ 当详情页直出」移植了，但真源对照实测
 * **106 个带 pattern 的源命中 0**（关键词搜索的响应 URL 从不等于详情页 URL）⇒ 那条分支
 * 只是安全网。pattern 真正被上游依赖的地方就是这里：**用户手里只有一个详情页 URL 时，
 * 反查该用哪个源**。所以 `#625` 不是「再加个功能」，是让 106 个 pattern 第一次真正生效。
 *
 * ## 三个易错的语义点（都按上游，勿「优化」）
 * 1. **`getBaseUrl` 不是「域名」而是 `scheme://authority`**（`NetworkUtils.kt:192-204`）：
 *    保留端口，去掉路径/查询/fragment。且上游会先切掉 `@js:` 之后的尾巴（源把 data URL
 *    包成 `https://host@js:'data:...'` 时也要能解析出真实传输 host）。
 * 2. **`String.matches` 是整串匹配**（Kotlin）⇒ JS 必须 `^(?:p)$`。用 `.test()` 会把
 *    `…/book/\d+` 判成命中 `…/book/123/extra`，上游不会。
 * 3. **① 步的 pattern 校验是硬条件**：上游写的是 `bs.bookUrlPattern!!`（非空断言）——
 *    源没配 pattern ⇒ NPE 被 catch ⇒ source 保持 null ⇒ **继续走 ②③**。这里等价实现为
 *    「没 pattern ⇒ ①步不算命中」。
 *
 * ⚠️ 本文件**零 import**（根层纯函数，先例 `source-share-passphrase.ts` / `json-loose.ts`）
 * —— 服务端 / 前端 / 引擎三处共用同一份判定，避免两处漂移出「同 URL 不同源」。
 */

/** 参与识别的源（服务端由 `hub.listSources()` 的 raw 投影出来，只保留判定需要的字段） */
export interface UrlSourceCandidate {
  id: string;
  /** `bookSourceUrl` / `sourceUrl` —— 上游 `getBookSourceAddBook` 就是拿它和 baseUrl 等值比较 */
  url: string;
  name?: string;
  /** 详情页 URL 正则（上游 `BookSource.bookUrlPattern`） */
  bookUrlPattern?: string;
  /** `customOrder` —— ③ 步遍历顺序（上游 `order by b.customOrder`） */
  order?: number;
  /** 是否启用；undefined 视作启用（调用方通常已经过滤过，这里再兜一层） */
  enabled?: boolean;
}

/** 命中方式（排障 / UI 文案用，判定本身与它无关） */
export type UrlSourceMatchBy = 'url-option-origin' | 'base-url' | 'bookUrlPattern';

export interface UrlSourceMatchStep {
  step: 'url-option-origin' | 'base-url' | 'bookUrlPattern';
  /** 这一步考察了多少个候选 */
  tested: number;
  /** 这一步的具体结果（命中源 id / 为什么跳过） */
  note: string;
}

export interface UrlSourceMatch {
  source: UrlSourceCandidate;
  by: UrlSourceMatchBy;
  /** 归一化后的 bookUrl：**trim 后原样保留 `,{...}` 尾巴**（上游 Book.bookUrl 也带着尾巴） */
  bookUrl: string;
  /** 三级链的逐步留痕（「为什么选中这个源」必须可解释 —— 用户实测类问题的关键） */
  steps: UrlSourceMatchStep[];
}

/** 上游 `AnalyzeUrl.paramPattern`：第一个「逗号（可带空白）后紧跟 `{`」处 */
const URL_OPTION_SPLIT = /\s*,\s*(?=\{)/;

/**
 * URL 尾部的 `,{...}` 选项串（上游 `AnalyzeUrl.paramPattern.matcher(bookUrl).find()`）。
 * 返回选项 JSON 文本；没有尾巴 ⇒ undefined。
 */
export function urlOptionText(url: string): string | undefined {
  if (!url) return undefined;
  // 尾巴可能被百分号编码（规则求值链路会编码 `{ " 空格`）——与 `url-prep` 同口径先粗还原，
  // 否则切不出尾巴，或 `origin` 键变成 `%22origin%22` 而静默失效。
  let probe = url;
  if (/%7B/i.test(probe)) {
    probe = probe
      .replace(/%7B/gi, '{')
      .replace(/%7D/gi, '}')
      .replace(/%22/g, '"')
      .replace(/%20/g, ' ');
  }
  const m = URL_OPTION_SPLIT.exec(probe);
  if (!m) return undefined;
  let text = probe.slice(m.index + m[0].length);
  if (/%[0-9A-Fa-f]{2}/.test(text)) {
    try {
      text = decodeURIComponent(text);
    } catch {
      /* 非法转义保持原样 */
    }
  }
  return text;
}

/**
 * 尾巴里显式指定的源地址（上游 `UrlOption.origin`）。
 *
 * 容错用「宽松 JSON」的最小实现：**不引入 `json-loose`**（它是 DOM 求值链路的模块，
 * 会拖进解析器依赖），这里只需要取一个顶层字符串值 ⇒ 先严格 JSON，再正则兜底
 * （单引号 / 无引号键是源作者常见写法，上游 GSON 也吃）。
 */
export function urlOptionOrigin(url: string): string | undefined {
  const text = urlOptionText(url);
  if (!text) return undefined;
  const pick = (o: unknown): string | undefined => {
    if (!o || typeof o !== 'object') return undefined;
    const v = (o as Record<string, unknown>)['origin'];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  try {
    const hit = pick(JSON.parse(text));
    if (hit) return hit;
  } catch {
    /* 宽松兜底 */
  }
  const m = /["']?\borigin\b["']?\s*:\s*["']([^"']+)["']/.exec(text);
  return m && m[1] ? m[1].trim() : undefined;
}

/**
 * 上游 `NetworkUtils.getBaseUrl:192-204` —— `scheme://authority`（带端口，去路径）。
 *
 * 非 http(s) ⇒ undefined（上游返回 null，调用方 `?: continue` 直接跳过这条 URL）。
 * 注意「authority」包含 userinfo 之外的 host:port：`URL("https://a.b:8080/x").authority`
 * = `a.b:8080`。JS 侧用 `host`（已含端口）等价。
 */
export function urlBaseOf(url: string): string | undefined {
  if (!url) return undefined;
  // 源可能把 data URL 包成 `https://host@js:'data:...'`：先截到 `@js:` 之前再解析
  // （与上游 :196-197 一字不差的动机：否则解析出的是 `data:` 这个假 host）。
  const jsIdx = url.toLowerCase().indexOf('@js:');
  const target = jsIdx >= 0 ? url.slice(0, jsIdx) : url;
  const m = /^(https?):\/\/([^/?#]*)/i.exec(target.trim());
  if (!m) return undefined;
  const scheme = m[1]!.toLowerCase();
  let authority = m[2] ?? '';
  // 去掉 userinfo（上游取 `parsed.authority`，Kotlin 的 URL.authority 也含 userinfo；
  // 但书源里从不用 userinfo，去掉可让 `https://u:p@host/x` 也能匹配 `https://host`）
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  if (!authority) return undefined;
  // host 按 DNS 语义大小写无关 ⇒ 统一小写（书源里几乎全是小写，用户粘的常带大写）
  return `${scheme}://${authority.toLowerCase()}`;
}

/** `bookUrlPattern` 判定结果（与 `#617` 同一个判据，导出给引擎复用，防两处漂移） */
export type BookUrlPatternState = 'hit' | 'miss' | 'invalid' | 'none';

/**
 * 剥掉 `,{...}` 尾巴后的「地址本体」。
 *
 * 为什么需要（**本仓对上游的一处显式偏离，理由在此**）：
 * 上游 `BookshelfViewModel.kt:75` 把**带尾巴的整只 `bookUrl`** 交给
 * `bookUrl.matches(bs.bookUrlPattern!!)` 校验 origin。但尾巴是 origin 的**载体**
 * （`origin` 就在 `{...}` 里），所以「① 走 origin 分支」时 URL 必然带尾巴 ⇒ 源里那些
 * 按地址本体写的 pattern（`https://host/book/\d+`）永远整串匹配不上 ⇒
 * **上游这条分支实际上是死代码**（永远退化到 ②③，甚至可能选出与用户指定不同的源）。
 *
 * 我们的处理：**先用本体匹配**（保住「校验这只源能处理这只 URL」的原意），
 * 本体不中再退回上游原样的整串匹配（严格超集，不改变任何上游会命中的结果）。
 * 引擎请求前本来也会用 `analyzeUrl` 把尾巴剥掉 ⇒ 用本体校验才是与真实请求一致的口径。
 */
export function urlBodyOf(url: string): string {
  if (!url) return '';
  const probe = /%7B/i.test(url)
    ? url.replace(/%7B/gi, '{').replace(/%7D/gi, '}').replace(/%22/g, '"').replace(/%20/g, ' ')
    : url;
  const m = URL_OPTION_SPLIT.exec(probe);
  const body = m ? probe.slice(0, m.index) : probe;
  return body.trim();
}

/**
 * 详情页 URL 正则判定（整串匹配）。`none` = 源没配 / 配成 `NONE`。
 *
 * 与工程师 `matchBookUrlPattern`（`#617`）**同一份实现**：那边改为从这里 import。
 * `invalid` 表示正则本身写坏 —— 上游会让 `PatternSyntaxException` 冒泡打挂调用方，
 * 我们两边都选择「退化 + 留痕」，故返回三态而不是抛。
 */
export function matchBookUrlPattern(pattern: unknown, url: string): BookUrlPatternState {
  if (typeof pattern !== 'string') return 'none';
  const p = pattern.trim();
  if (!p || p === 'NONE' || p === 'null') return 'none';
  if (!url) return 'miss';
  try {
    return new RegExp('^(?:' + p + ')$').test(url) ? 'hit' : 'miss';
  } catch {
    return 'invalid';
  }
}

/**
 * 核心：按上游三级链给一只 URL 找源。
 *
 * @param rawUrl 用户粘贴的原始文本（可带 `,{...}` 尾巴、前后空白、甚至换行）
 * @param candidates 候选源（**调用方负责按「启用」过滤**；这里只用 `enabled !== false` 再兜一次）
 * @returns 未命中 ⇒ undefined（上游是 `source ?: continue`，跳过这只 URL）
 */
export function resolveSourceByUrl(
  rawUrl: string,
  candidates: readonly UrlSourceCandidate[],
): UrlSourceMatch | undefined {
  const bookUrl = String(rawUrl ?? '').trim();
  if (!bookUrl) return undefined;
  const steps: UrlSourceMatchStep[] = [];
  const usable = candidates.filter((c) => c && typeof c.url === 'string' && c.enabled !== false);

  // ① 尾巴显式指定 origin：取那只源 + **要求 pattern 也命中**（上游 `bookUrlPattern!!`）
  const origin = urlOptionOrigin(bookUrl);
  if (origin) {
    const cand = usable.find((c) => c.url === origin);
    if (!cand) {
      steps.push({ step: 'url-option-origin', tested: 1, note: `origin=${origin} 不在候选集（可能已删除/禁用）` });
    } else {
      // 先按「地址本体」校验（见 `urlBodyOf` 头注：上游用带尾巴的整串匹配 ⇒ 这条分支是死代码）
      const body = urlBodyOf(bookUrl);
      const st = matchBookUrlPattern(cand.bookUrlPattern, body);
      const stRaw = st === 'hit' ? st : matchBookUrlPattern(cand.bookUrlPattern, bookUrl);
      if (st === 'hit' || stRaw === 'hit') {
        steps.push({
          step: 'url-option-origin',
          tested: 1,
          note: `origin=${origin} + pattern 命中${st === 'hit' ? '（按地址本体）' : '（按含尾巴的整串，上游原样）'}`,
        });
        return { source: cand, by: 'url-option-origin', bookUrl, steps };
      }
      // 没配 pattern（NONE/空）或 pattern 不命中 ⇒ 上游 NPE/不命中都退到 ②③
      steps.push({
        step: 'url-option-origin',
        tested: 1,
        note: st === 'none' ? `origin=${origin} 但该源未配 bookUrlPattern（上游 NPE ⇒ 退后续步骤）` : `origin=${origin} 但 pattern ${st}`,
      });
    }
  }

  // ② 域名：bookSourceUrl 与 baseUrl **等值**（上游 `getBookSourceAddBook`：等值不是前缀）
  //
  // ②a = 上游原样（字符串严格相等）；②b = **本仓显式超集**，理由见下。
  //   上游 `NetworkUtils.getBaseUrl` 产出 `scheme://authority`（无尾斜杠），而语料
  //   `data/sources/book-482` 里 **99/483 个源的 bookSourceUrl 带尾斜杠**（`https://host/`）、
  //   54 个带路径 ⇒ 上游这条 SQL 对它们**恒不命中**，只能靠 ③ 的 pattern 捞（没配 pattern
  //   的源等于永久无法用 URL 添加）。②b 用 `urlBaseOf` 归一后比较，把这 99 个捞回来。
  //   ⚠️ 风险面很小且已量化：全语料仅 **2 个 host 存在多源**
  //   （`cn.dzmanga.com` 包子漫画 ×2、`www.shudugu.org` 速读谷 ×2，都是同站双规则），
  //   命中哪个都指向同一站点；仍按 customOrder 升序取第一个，保证可复现。
  const base = urlBaseOf(bookUrl);
  if (base) {
    const exact = usable.find((c) => c.url === base);
    if (exact) {
      steps.push({ step: 'base-url', tested: usable.length, note: `base=${base} 严格等值 ⇒ ${exact.id}` });
      return { source: exact, by: 'base-url', bookUrl, steps };
    }
    const normalized = usable
      .filter((c) => urlBaseOf(c.url) === base)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
    if (normalized) {
      steps.push({
        step: 'base-url',
        tested: usable.length,
        note: `base=${base} 归一化命中（bookSourceUrl=${normalized.url}）⇒ ${normalized.id}`,
      });
      return { source: normalized, by: 'base-url', bookUrl, steps };
    }
    steps.push({ step: 'base-url', tested: usable.length, note: `base=${base} 无等值 bookSourceUrl` });
  } else {
    steps.push({ step: 'base-url', tested: usable.length, note: 'URL 非 http(s)（上游 getBaseUrl 返回 null）' });
  }

  // ③ 遍历启用且配了 pattern 的源，整串匹配；按 customOrder 升序（上游 `order by b.customOrder`）
  const withPattern = usable
    .filter((c) => {
      const p = typeof c.bookUrlPattern === 'string' ? c.bookUrlPattern.trim() : '';
      return p && p !== 'NONE' && p !== 'null';
    })
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const c of withPattern) {
    if (matchBookUrlPattern(c.bookUrlPattern, bookUrl) === 'hit') {
      steps.push({ step: 'bookUrlPattern', tested: withPattern.length, note: `pattern 命中 ⇒ ${c.id}` });
      return { source: c, by: 'bookUrlPattern', bookUrl, steps };
    }
  }
  steps.push({ step: 'bookUrlPattern', tested: withPattern.length, note: '全部未命中' });
  return undefined;
}

/**
 * 一次粘贴多行 / 多个链接（上游 `bookUrls.split("\n")`）。
 * 保留输入顺序；未命中的也返回一条 `match: undefined` 的记录，便于 UI 逐行报错。
 */
export function resolveSourceByUrls(
  rawUrls: string | readonly string[],
  candidates: readonly UrlSourceCandidate[],
): { url: string; match?: UrlSourceMatch }[] {
  const lines = Array.isArray(rawUrls) ? rawUrls : String(rawUrls ?? '').split('\n');
  const out: { url: string; match?: UrlSourceMatch }[] = [];
  for (const line of lines) {
    const url = String(line ?? '').trim();
    if (!url) continue;
    out.push({ url, match: resolveSourceByUrl(url, candidates) });
  }
  return out;
}
