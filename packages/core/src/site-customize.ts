/**
 * `#567` **P3 站点定制层 —— 配置模型与匹配（唯一实现）**。
 *
 * ## 为什么放在 core 且是**纯函数**
 * 三个消费方都要用同一套判据：① Web 阅读器（`buildHtmlDoc` 注入）；② 桌面 `WebContentsView`
 * （`insertCSS` / `executeJavaScript`）；③ 服务端渲染器（`webView` / `java.webView` 返回值补壳）。
 * 判据写三处必然漂移（本仓屡次踩过）⇒ 这里只留**一份**：
 *   · `normalizeSiteHost` / `hostOfUrl` —— 「一条地址属于哪个站点」
 *   · `matchSiteCustomize` —— 「哪个定制规则命中它」（**最具体者胜**）
 *   · `injectSiteCustomize` —— 「把 CSS/JS 塞进 HTML」（字符串级，无 DOM 依赖，浏览器/Node 同用）
 *
 * ## 配置存哪（用户 2026-10-22 拍板）
 * **本地独立配置**（`data/site-customize.json`，按域名存），**不进书源定义**：
 * 源要能干净地导入导出，定制不能随源更新丢失；也符合「发布包不含任何源」的定位。
 *
 * ## 安全边界（本地软件，仍要有底线）
 * JS 是**用户自己写的**，执行环境是阅读壳的沙箱 iframe（`allow-scripts`，不透明 origin）或
 * 桌面 WebContentsView（`contextIsolation: true` / `nodeIntegration: false`）—— 拿不到 Node，
 * 也拿不到宿主页面。仍然做两件防护：**长度上限** + **闭合标签转义**（否则一段 `</script>`
 * 能把后面的壳层脚本结构打断）。
 */

/** 一条站点定制（按域名）。`undefined`/空串 = 该项不启用。 */
export interface SiteCustomize {
  /**
   * 域名匹配模式（小写、无协议无路径）：
   *  · `example.com` —— 命中自身**及其子域**（`www.example.com` 也命中）
   *  · `*.example.com` —— 只命中子域（不含 `example.com` 本身）
   */
  host: string;
  /** 注入的 CSS（原样塞进壳层 `<style>`） */
  css?: string;
  /** 注入的 JS（原样塞进壳层 `<script>`，在壳层脚本之后执行） */
  js?: string;
  /**
   * 阅读模式：抓正文、去掉导航/侧栏/广告后重排。
   * ⚠️ 只对「网页即正文」生效（`openWeb` / RSS 单页源）；书籍正文**暂不启用** —— 见
   * {@link readerModeAppliesTo} 与 `backlog.md` 的挂账号。
   */
  readerMode?: boolean;
  /** 最近更新时间（epoch ms，仅用于列表排序/提示） */
  updatedAt?: number;
}

/** 长度上限：本地配置也不能无限大（误粘整站 CSS 会把 iframe 撑爆）。 */
export const SITE_CUSTOMIZE_LIMITS = {
  host: 253,
  css: 64 * 1024,
  js: 64 * 1024,
} as const;

/** 一条配置的「内容是否为空」（空配置等价于删除）。 */
export function isSiteCustomizeEmpty(v: SiteCustomize): boolean {
  return !String(v.css ?? '').trim() && !String(v.js ?? '').trim() && v.readerMode !== true;
}

/**
 * 把用户输入（可能是整条 URL、`www.x.com/path`、`*.x.com`）归一成**域名模式**。
 * 返回 `''` = 认不出（调用方应拒绝保存）。
 */
export function normalizeSiteHost(input: unknown): string {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return '';
  // 去掉协议与路径/查询/端口
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^\/\//, '');
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.split('@').pop() ?? s;
  // 端口（IPv6 字面量不在支持范围内，直接按「含 : 即非法」处理）
  s = s.replace(/:\d+$/, '');
  const wildcard = s.startsWith('*.');
  if (wildcard) s = s.slice(2);
  s = s.replace(/\.$/, '');
  if (!s || s.length > SITE_CUSTOMIZE_LIMITS.host) return '';
  // 只允许字母数字/连字符/点（IDN 已被浏览器转成 punycode；中文域名请用户先转）
  if (!/^[a-z0-9.-]+$/.test(s)) return '';
  if (s.startsWith('.') || s.includes('..')) return '';
  return wildcard ? `*.${s}` : s;
}

/** 从一条 http(s) URL 取主机名（小写）。非 http(s) 或解析失败 ⇒ `''`。 */
export function hostOfUrl(url: unknown): string {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    return new URL(s).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 域名模式是否命中主机名（调用方应先各自 normalize）。 */
export function siteHostMatches(pattern: string, host: string): boolean {
  const p = String(pattern ?? '').trim().toLowerCase();
  const h = String(host ?? '').trim().toLowerCase();
  if (!p || !h) return false;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h.length > base.length && h.endsWith(`.${base}`);
  }
  // 裸域名：命中自身**及子域**（用户写 `example.com` 时显然也想管 `www.example.com`）
  return h === p || h.endsWith(`.${p}`);
}

/**
 * 在配置表里挑出命中该 URL 的**最具体**一条。
 *
 * 为什么「最具体者胜」：用户可能同时写 `example.com`（全局暗色）与 `news.example.com`
 * （该栏目去广告）。后者更长 ⇒ 优先级更高；`*.` 前缀不参与长度比较（只是语义标记）。
 */
export function matchSiteCustomize(list: readonly SiteCustomize[], url: unknown): SiteCustomize | null {
  const host = hostOfUrl(url);
  if (!host) return null;
  let best: SiteCustomize | null = null;
  let bestLen = -1;
  for (const item of list) {
    const p = normalizeSiteHost(item?.host);
    if (!p || !siteHostMatches(p, host)) continue;
    const len = p.replace(/^\*\./, '').length;
    if (len > bestLen) {
      best = item;
      bestLen = len;
    }
  }
  return best;
}

/**
 * `#569` 阅读模式的**作用范围闸门**。
 *
 * `#712` 起书籍正文也放行，但**落地形态不同**（由调用方实现，本闸门只管「能不能用」）：
 *  · `web`（`openWeb` 网页即正文）→ 抽正文后仍走 `iframe`（源脚本/播放器要执行）；
 *  · `book`（RSS 文章 / 组装型 / 本地 epub 含图章）→ 抽正文后**降级为 `paragraphs`**，
 *    交给阅读样式体系接管（评估结论：不新增书籍 iframe 分支，见
 *    `docs/rounds/2026-11-02-06-book-content-reading-mode-eval.md`）。
 *
 * ⚠️ 两者都必须由用户对该站点**显式开启** `readerMode` 才生效 —— 抽正文会丢掉
 * 章内播放器 / 漫画图组 / 源自绘 UI，默认不能替用户做这个决定。
 */
export function readerModeAppliesTo(kind: 'web' | 'book'): boolean {
  return kind === 'web' || kind === 'book';
}

/** HTML 字面量转义：防止用户 CSS/JS 里的闭合标签提前结束我们的注入块。 */
function escapeForEmbed(text: string, closeTag: 'style' | 'script'): string {
  // `</style` / `</script` 在 HTML 解析器里会结束块；`<\/style` 在 CSS/JS 里语义等价。
  return text.replace(new RegExp(`</${closeTag}`, 'gi'), `<\\/${closeTag}`);
}

/**
 * 定制注入件本体（`<style>` + `<script>`，已转义）。
 * 两个入口共用：{@link injectSiteCustomize}（拼进 HTML）与阅读壳 `extraHead`
 * （`buildHtmlDoc` 已有注入槽，不能把整页再包一层）。
 */
export function siteCustomizeHeadHtml(cfg: SiteCustomize | null | undefined): string {
  if (!cfg) return '';
  const css = String(cfg.css ?? '');
  const js = String(cfg.js ?? '');
  const style = css.trim() ? `<style>${escapeForEmbed(css, 'style')}</style>` : '';
  const script = js.trim() ? `<script>${escapeForEmbed(js, 'script')}</script>` : '';
  return style + script;
}

/**
 * 把定制注入 HTML。
 *
 * 位置：`<head>` 开标签后（没有 head 就补一个；没有 html 就当片段处理，前置注入）。
 * 顺序：**先 CSS 后 JS** —— 用户 JS 常要读注入后的样式（如按配色改元素）。
 *
 * 返回 `''`（输入为空）时原样返回空串；无定制内容时**逐字返回原 HTML**（零改动）。
 */
export function injectSiteCustomize(html: string, cfg: SiteCustomize | null | undefined): string {
  const raw = String(html ?? '');
  if (!raw || !cfg) return raw;
  const inject = siteCustomizeHeadHtml(cfg);
  if (!inject) return raw;
  if (/<head[^>]*>/i.test(raw)) return raw.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  if (/<html[^>]*>/i.test(raw)) return raw.replace(/<html([^>]*)>/i, `<html$1><head>${inject}</head>`);
  return inject + raw;
}

/** 只取注入件本身（桌面 `insertCSS` / `executeJavaScript` 用；与 {@link injectSiteCustomize} 同一判据）。 */
export function siteCustomizePayload(cfg: SiteCustomize | null | undefined): { css: string; js: string } {
  return { css: String(cfg?.css ?? ''), js: String(cfg?.js ?? '') };
}
