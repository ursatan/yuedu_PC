/**
 * 媒体直链提取与 `UnifiedContent['media']` 组装 —— **唯一实现**（`#346`）。
 *
 * ## 为什么下沉到 core
 * 这段逻辑此前**只**存在于 `engine-legado/src/engine.ts`
 * （`MEDIA_EXT_RE` / `inferPlayFormat` / `collectMediaCandidates` / `toMedia` / `parseMediaCandidate`）。
 * 而订阅源同样有视频/音频形态（`type === 2`，如「麻豆传媒」`ruleContent` 产出
 * `<video src="…index.m3u8">`）—— RSS 引擎此前**完全没有**媒体通路 ⇒ 正文 HTML 塞进
 * 沙箱 iframe 里，Chromium 无原生 HLS ⇒ 用户看到**黑屏播放器 0:00**（2026-10-08 实测）。
 *
 * 按铁律「同一判据写两处必然漂移」，这里抽成 core 的唯一实现，两个引擎共用。
 *
 * ## 与上游的对应
 * 上游 Legado 靠 `BookType`（0 文本 / 1 图片 / 2 视频 / 3 音频）分派阅读器，
 * 播放地址由 `ruleContent` 解析后交给 `VideoPlayer`/`AudioPlayer`。
 * 本仓按**内容形态**兜底（候选收集是启发式的），把候选交给前端播放器——
 * 「哪条真能放」只有前端（媒体元素的 `error` 事件）知道，服务端不替它挑。
 */

import type { UnifiedContent, UnifiedPlay } from '../contract/types';
// `#374`：从零依赖叶子 import（不能走 `../net` —— 那会拉进 render 等 node-only 模块，
// 前端要按窄子路径 `@yuedu/core/media-extract` 复用这份判据）
import { resolveUrl } from '../net/url-resolve';
// `#376`：MEDIA_EXT_RE / likeMediaUrl 下沉到零依赖叶子 `media-shape`（LIVE 桥要用
// `fn.toString()` 注入 iframe 内脚本，判据必须唯一；底部 re-export 保持导入面）
import { likeMediaUrl, MEDIA_EXT_RE } from './media-shape';

/** 播放格式推断（交给播放器选择内核） */
export function inferPlayFormat(url: string): UnifiedPlay['format'] {
  const u = url.split('?')[0]?.toLowerCase() ?? '';
  if (u.endsWith('.m3u8')) return 'm3u8';
  if (u.endsWith('.mp4')) return 'mp4';
  if (u.endsWith('.mpd')) return 'mp4';
  if (/\.(mp3|m4a|aac|flac|wav)$/.test(u)) return 'audio';
  /**
   * 路径里没有扩展名时，再看**整串**（含 query）。
   *
   * 为什么必须补：🎬🔞麻豆传媒AI 的直链形如
   * `https://mdcmai4.xyz/api/v1/m3u8/proxy?path=…/xxx.m3u8` —— pathname 是 `/api/v1/m3u8/proxy`，
   * 按 pathname 判会得到 `unknown`，播放器选不出内核。
   */
  const full = url.toLowerCase();
  if (full.includes('.m3u8')) return 'm3u8';
  if (full.includes('.mpd')) return 'mp4';
  if (full.includes('.mp4')) return 'mp4';
  if (/\.(mp3|m4a|aac|flac|wav)\b/.test(full)) return 'audio';
  return 'unknown';
}

/**
 * 拆一个媒体候选串 → `{ url, headers }`。
 *
 * 形态来自 Legado：`url` 或 `url,{"headers":{…}}`（`,{` 之后是 JSON 选项）。
 * 抽成函数是为了**主候选与备选走同一套解析** —— 备选同样可能带 `,{…}` 选项，
 * 只给主候选解析会得到一个「看起来能播、实际缺防盗链头」的地址。
 */
export function parseMediaCandidate(u0: string): { url: string; headers?: Record<string, string> } {
  const comma = u0.indexOf(',{');
  const url = comma >= 0 ? u0.slice(0, comma) : u0;
  let headers: Record<string, string> | undefined;
  if (comma >= 0) {
    try {
      const opts = JSON.parse(u0.slice(comma + 1)) as Record<string, unknown>;
      const h = (opts['headers'] ?? opts) as Record<string, unknown>;
      headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)]));
    } catch {
      /* 选项解析失败忽略 */
    }
  }
  return { url: url.trim(), headers };
}

/** 候选串 → 绝对地址（相对路径按 base 解析；空串返回空） */
export function absMediaUrl(u: string, base: string): string {
  const s = u.trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : resolveUrl(base, s) ?? s;
}

/**
 * 组装 `media`（主候选 + **全部备选**）。
 *
 * ⚠️ **备选必须下发**（2026-09-25 用户报「音乐播放失败 / no supported source」时补）：
 * 此前只发 `cands[0]`。而候选排序是**启发式**（标签 → 播放器变量 → 规则字面量 →
 * 裸扩展名 URL → 任意绝对 URL），真实播放页上常常同时有广告位/预告/多清晰度线路，
 * 排序**必然有取错的时候**。判定「真的放不出来」只有前端能做（媒体元素的 error 事件），
 * 所以服务端该做的是**把候选交出去**，而不是替前端挑一个。
 */
export function toMedia(u0: string, base: string, alts: readonly string[] = []): UnifiedContent['media'] {
  const first = parseMediaCandidate(u0);
  const abs = absMediaUrl(first.url, base);
  if (!abs) return undefined;
  const extra: string[] = [];
  for (const a of alts) {
    const cand = absMediaUrl(parseMediaCandidate(a).url, base);
    // 去重（含与主候选相同的情况）：重复候选只会让前端白试一次
    if (cand && cand !== abs && !extra.includes(cand)) extra.push(cand);
  }
  return {
    url: abs,
    headers: first.headers,
    format: inferPlayFormat(abs),
    ...(extra.length ? { alternatives: extra } : {}),
  };
}

/**
 * 播放器常见变量/JSON 键（值里必须像个媒体地址，避免把 `src: "a.js"` 之类当播放地址）
 */
const MEDIA_KEY_RE =
  /["']?(url_next|videoUrl|playUrl|play_url|video_url|m3u8url|m3u8|hls|file|source|src|url)["']?\s*[:=]\s*["']([^"'\s]{6,})["']/gi;

/** JSON/JS 串里的 URL 反向转义（`https:\/\/` → `https://`） */
export function unescapeJsUrl(s: string): string {
  return s
    .replace(/\\\//g, '/')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u0026/gi, '&');
}

/**
 * `#432` **「播放器页包裹直链」的解包**（`…/t2player.html?url=https://…/x.m3u8`）。
 *
 * ## 缺陷（91视频实测，2026-10-13）
 * 页面脚本写的是**播放器页**的地址，真 m3u8 在 `?url=` 参数里：
 * ```js
 * ifa.src = "https://ha2.dd.frcfwb.cn/t2player.html?url=https://ehapp2.dd.frcfwb.cn/cshort/xxx.m3u8"
 * ```
 * 旧实现只按「值里含 `.m3u8`」过审 ⇒ 候选[0] = **那个 HTML 播放器页**
 * ⇒ ① 喂给 hls.js 必然 `manifestParsingError`；② 经 `/api/proxy` 还会因 URL 含
 * `.m3u8` 被当播放列表逐行改写（连 HTML 一起改坏）。
 *
 * ## 判据
 * **入口必须自身是「网页」**：路径（去掉 query/hash 后）以 `.html/.htm/.php/.asp/.aspx/.jsp/.shtml`
 * 结尾 —— 一个 `.html` 地址**不可能是**媒体流/清单，它只可能是播放器页。
 * 再看值里带**直链参数**（`url`/`src`/`u`/`video`/`m3u8`/`path`/`play`/`playurl`/`file`）
 * 且参数内解出来**确实像媒体**（`MEDIA_EXT_RE` 或 `/m3u8|hls|.mp4|/video/`）⇒ 返回内层地址。
 * 否则返回 `null`（调用方保留原值，行为同前）。
 *
 * ⚠️ **为什么必须限制「入口是网页」**：AGE 动漫的解析页形如
 * `https://jx.xxx:8443/m3u8/?url=https://s.x.com/a/index.m3u8` —— 它**故意**要作为嗅探候选下发
 * （前端经 `#394` `/api/media-resolve` 做二级解析，那里可能还要补 Referer/签名），
 * 路径不是网页扩展名 ⇒ 本函数**不碰它**（`#430` 的产品口径保持不动）。
 *
 * ⚠️ 只看**第一个**命中的直链参数（多参数时应是最外层那个）。
 */
const WEB_PAGE_EXT_RE = /\.(?:html?|php|asp|aspx|jsp|shtml)$/i;
const EMBED_PARAM_RE = /[?&](?:url|src|u|video|m3u8|path|play|playurl|file)=([^&\s"'<>\\]+)/i;
export function unwrapPlayerUrl(u0: string): string | null {
  const u = unescapeJsUrl(u0);
  const path = u.split(/[?#]/)[0] ?? '';
  if (!WEB_PAGE_EXT_RE.test(path)) return null;
  const m = EMBED_PARAM_RE.exec(u);
  if (!m) return null;
  let inner = m[1] ?? '';
  try {
    inner = decodeURIComponent(inner);
  } catch {
    /* 百分号序列不合法：保持原样 */
  }
  inner = inner.trim();
  if (!/^https?:\/\//i.test(inner)) return null;
  if (!MEDIA_EXT_RE.test(inner) && !/\/m3u8|hls|\.mp4|\/video\//i.test(inner)) return null;
  return inner;
}

/**
 * 媒体直链候选收集（**按可信度排序**）—— 「直链兜底提取」的核心。
 *
 * ## 为什么需要它
 * 很多视频/音频源把播放地址放在**页面里的 JS 变量或 JSON** 中（播放器配置 `player_aaaa`、
 * `url_next`、`"file":"…"` 等），`ruleContent.content` 往往只能取到整段 HTML
 * （或压根没有可用规则）。原来 `extractFromRaw` 的兜底是「**第一个绝对 URL**」——
 * 那通常是 `css`/`js`/图片 CDN 地址，**必然取错**，用户看到的就是「未取到媒体地址」。
 *
 * ## 排序（先后即优先）
 * ① `<video|audio|source>` 的 `src` / `data-src` / `data-url`（懒加载播放器常用 data-*）
 * ② 播放器常见变量/JSON 键：`url_next` `videoUrl` `playUrl` `m3u8` `hls` `file` `source` `url` …
 * ③ 规则字面量（源规则本身就是个 URL 时由调用方传入）
 * ④ 裸的**媒体扩展名** URL（含 query 里的 `.m3u8` —— 麻豆那种 `/api/v1/m3u8/proxy?path=x.m3u8`）
 * ⑤ 最后兜底：任意绝对 URL（保持历史行为，但降到最低优先级）
 *
 * ⚠️ **反向转义**：JSON 里嵌的 URL 常写作 `https:\/\/x.com\/a.m3u8`，必须先还原
 * （`\/`→`/`、`\u0026`→`&`），否则拿到的字符串带反斜杠，播放器直接加载失败。
 */
export function collectMediaCandidates(raw: string, literal?: string): string[] {
  const out: string[] = [];
  /**
   * `#445` **扫描副本的实体归一**（只影响本函数，不改下游 HTML）。
   *
   * 引擎把属性内引号**正确保留成实体**之后（`#445`），JSON 形态的属性值长这样：
   * `data-config="…&quot;url&quot;:&quot;https:\/\/…m3u8&quot;…"`。而②号判据 `MEDIA_KEY_RE`
   * **要求引号作定界符** ⇒ 不归一就**一条候选都提不到**（真机实测 91 吃瓜：`media` 从有变无）。
   * 这里把 `&quot;`/`&#39;` 还原成引号再扫 —— 下游拿到的仍是「保持实体」的标记（那才是对的）。
   */
  raw = raw
    .replace(/&amp;/gi, '&') // 先解一层（`&amp;quot;` 才能继续被下一行解成引号）
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
  const push = (u: unknown): void => {
    const v = unescapeJsUrl(String(u ?? '').trim()).replace(/[",;]+$/, '');
    if (v && !out.includes(v)) out.push(v);
  };

  // ① 媒体标签（src 优先，其次懒加载用的 data-*）
  for (const m of raw.matchAll(/<(?:video|audio|source)\b[^>]*>/gi)) {
    const tag = m[0];
    const attr =
      /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ??
      /\bdata-(?:src|url|original)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (attr) push(attr);
  }

  // ② 播放器变量 / JSON 键（值里必须像个媒体地址，避免把 `src: "a.js"` 之类当播放地址）
  //  `#394` 补刀：`src="…/hls.min.js"` 这类**脚本资源**会被 `hls` 提示词误伤
  //  （AGE jx 页实测：hls.min.js 的 <script> 排在 var Vurl 之前 ⇒ 候选[0] 是脚本地址）。
  //  脚本/样式 URL 永远不是媒体流 ⇒ 值以 .js/.css 结尾的直接跳过。
  for (const m of raw.matchAll(MEDIA_KEY_RE)) {
    const v = m[2] ?? '';
    if (/\.(m?js|css)([?#]|$)/i.test(v.replace(/\\/g, ''))) continue;
    if (MEDIA_EXT_RE.test(v.replace(/\\/g, '')) || /\/m3u8|hls|\.mp4|\/video\//i.test(v)) {
      // `#432`：值是「播放器页 URL 包着真直链」时，取**内层直链**（否则拿到的是 HTML 页）
      push(unwrapPlayerUrl(v) ?? v);
    }
  }

  // ③ 规则字面量（调用方明确告知「规则本身就是 URL」）
  if (literal) push(literal);

  // ④ 裸的媒体扩展名 URL —— 含 query 里的 `.m3u8`（麻豆 `/api/v1/m3u8/proxy?path=x.m3u8`）
  //
  // `#438` **必须止步于 `#` 与反引号**（此前只排除空白/引号/尖括号/反斜杠）：
  // MacCMS/Legado 的 `vod_play_url` 是「集名$直链#集名$直链#…」一整条**列表串**，
  // 被源规则原样填进正文 `<script>`（`tplPlayUrl.innerHTML = `集名$url#…``）。旧字符类
  // 会把整串当一个 URL 抓走 ⇒ 候选 = `https://…/a.m3u8#第02集$https://…/b.m3u8#…``
  // （**尾巴还带着反引号**）⇒ ① 喂给 hls.js 必然 `networkError/manifestParsingError`；
  // ② 整张选集列表塌成 1 条（用户实测「影视聚合：播放失败 + 选集只嗅探到 1 集」）。
  // 止步于 `#` 后：每条 `https://` 各自成一条候选（集名 `第0N集$` 被正则自然跳过 ——
  // 匹配只从 `https://` 起），反引号排除是为了让末条地址命中 `MEDIA_EXT_RE` 的 `$` 锚。
  //
  // `#440` **还必须止步于 `$`**（真机实测 4 家 MacCMS 源 + 用户报「第 1 集 HTTP 404」）：
  // 多线路源的 `vod_play_url` 形如 `线路1集列表$$$线路2集列表`，`$$$` 是**线路分隔符**且
  // **与 `#` 无关** ⇒ 只排除 `#` 时，第一个 `https://`（第 1 集）会一路吃到 `$$$第1集$`
  // 再吞进下一条线路的 `https://…/index.m3u8` ⇒ 候选[0] 是坏地址（且经代理必然 **404**）；
  // 第 2 集起在第一个 `#` 之后 ⇒ 地址干净 ⇒ 能播（**用户症状原样复现**）。
  for (const m of raw.matchAll(/https?:\/\/[^\s"'<>\\#`$]+/gi)) {
    const u = unescapeJsUrl(m[0]);
    // `#432`：同 ② —— 裸扫到的也常是「播放器页包直链」，解出内层（无内层则原样）
    if (MEDIA_EXT_RE.test(u)) push(unwrapPlayerUrl(u) ?? u);
  }

  // ⑤ 最后兜底：任意绝对 URL（保持历史行为；只在上面都没命中时才轮到它）
  if (!out.length) {
    for (const line of raw.split(/[\s"'<>;]+/)) {
      if (/^https?:\/\/\S+$/.test(line)) push(line);
    }
  }
  return out;
}

/**
 * 从「已解析出的正文」按媒体形态提取 `media`（供 RSS / 其它引擎复用）。
 * 返回 `undefined` 表示没有可用媒体候选（调用方据此保持原有 HTML 通路）。
 *
 * @param raw    `ruleContent` 求值结果（可能整段 HTML / 含 `<video>` / 裸直链）
 * @param base   相对地址基准（= 正文页绝对地址）
 * @param literal 规则字面量（当规则本身就是 URL 时传入，优先级高于裸 URL 扫描）
 */
export function mediaFromRaw(
  raw: string,
  base: string,
  literal?: string,
): UnifiedContent['media'] {
  const cands = collectMediaCandidates(raw, literal);
  if (!cands.length) return undefined;
  /**
   * 主候选必须先**看起来像媒体**才认——否则会在纯文本正文上把正文里的普通链接当播放地址。
   * `#376`：门槛谓词下沉为 `media-shape.likeMediaUrl`（判据逐字未动，LIVE 桥共用同一份）。
   * `#394` 补刀：⑤ 号兜底（任意绝对 URL）放进来的 `.js/.css` 脚本资源（如页面里唯一的
   *  `<script src="…/hls.js">`）同样能骗过 `hls` 提示词 ⇒ 门槛这里再拦一道。
   *
   * `#445`（真机实测 91 吃瓜）：源在正文**前面**补了 `<script src="…/hls.min.js">` 之后，
   * **首个候选就成了 `.js`** —— 旧写法「主候选不合规 ⇒ **整条提取放弃**」直接把本来就在
   * `data-config` 里的 m3u8 一起丢掉了（`media` 从有变无 ⇒ 嗅探少一条章级直链）。
   * 判据逐字未动，只把「整体放弃」改成「**把坏候选剔掉再看**」：正常源（主候选本就是媒体）
   * 行为完全不变，而「脚本混在正文前面」的源能正确落到真正的媒体上。
   */
  const good = cands.filter((c) => {
    const u = parseMediaCandidate(c).url;
    return !!u && likeMediaUrl(u) && !/\.(m?js|css)([?#]|$)/i.test(u);
  });
  if (!good.length) return undefined;
  return toMedia(good[0]!, base, good.slice(1));
}

// 「页面自带播放通路」判据（bodyUsesHls / bodyHasHlsLib）定义在
// `./media-shape`（零依赖叶子模块 —— 前端要按窄子路径 `@yuedu/core/media-shape`
// 导入，不能经 index 把 node 模块拉进浏览器 bundle）。这里转发保持既有导入面。
// `#376`：MEDIA_EXT_RE / likeMediaUrl 同住 media-shape（见顶部 import 注释）。
// ⚠️ `#430`：`bodySelfPlaying` **已删除** —— 它曾把「有 `<iframe`/调 Hls API」的页面挡在嗅探之外，
// 用户拍板「嗅探与源规则展示**并行**」后不再需要该门控（见 engine-rss `content` 的注释）。
export { bodyUsesHls, bodyHasHlsLib, likeMediaUrl, MEDIA_EXT_RE } from './media-shape';
