/**
 * `#335` **「极简浏览器」取页**：把一个 http(s) 地址取成**可直接塞进 iframe 的文档**。
 *
 * ## 为什么需要它（缺陷类别）
 * 两类场景都会撞到同一个洞 —— **阅读页没有「打开一个 URL」这条通路**：
 *  · **网页型订阅源**（`singleUrl === true`，如 全版本汇总 / 源仓库 / XH发布页）：
 *    上游是 WebView `loadUrl` 直接渲染该页；本仓走「分类 → 卡片 → 详情 → 正文」，
 *    正文处因「无内嵌正文且 `ruleContent` 空」抛 `UNSUPPORTED` ⇒ 用户看到报错页。
 *  · **正文里的页内跳转**（`#336`）：点到链接要么跳系统浏览器新标签、要么没有返回的路。
 *
 * 两者都只要一件事：**取回 HTML → 补壳 → 交给 `<iframe srcdoc>`**。
 *
 * ## 为什么不走引擎的 `content`
 * 那会把 `ruleContent`/净化按「正文」语义处理（抓下来的是**整张网页**，不是一篇文章），
 * 且网页型源压根没有正文规则。**取页就是取页**，不该套正文语义。
 *
 * ## 为什么走 `/api/proxy`
 * 目标站是任意外域：浏览器直连会撞 CORS（且带不上源的 Referer/UA）。`/api/proxy` 是
 * 本仓既有的**无凭据只读资源转发**（`#326`），对 `Origin: null` 回 ACAO ⇒ 服务端取即可。
 */
import { buildHtmlDoc, serverOriginOf } from './html-shell';
import hlsAssetUrl from 'hls.js/dist/hls.min.js?url';

/**
 * `#453`（D13 = A+B）该源**有常驻浏览器会话**时，优先用真浏览器把这一页取回来。
 *
 * 为什么放在「取页」这一层，而不是把整个网页塞进一块 `WebContentsView`：
 *  · 取页的下游是 `buildHtmlDoc` 的壳（资源桥 / 懒加载修正 / 正文工具 / 导航桥）——
 *    **源规则的排版与阅读器工具栏都建立在这层壳上**，把整页塞进真 view 会把它们全部丢掉；
 *  · 而本条要的只是「**用真浏览器取页**」：登录态、cookie、TLS 指纹都在那只浏览器里 ——
 *    正是 `#428`（证书/白名单）、`#431`（SNI 白名单）那类站点过不去的原因。
 * 没有会话（没登录过 / web 端 / 老桌面端）⇒ 回落既有 `/api/proxy`，行为与 `#453` 之前一致。
 */
/**
 * 取页结果：`raw` = 站点原始 HTML（站点定制弹窗的「HTML 源码」栏要看这个），
 * `doc` = 补好壳的文档（喂给 `<iframe srcdoc>`）。
 *
 * 为什么不分开取两次：两条路都可能是「真浏览器会话」或 `/api/proxy`，
 * 分开写会**取两遍**（慢且容易取到不同版本）。一次取、两个出口。
 */
export interface WebPage {
  raw: string;
  doc: string;
}

async function fetchViaSession(url: string, sid: string, origin: string): Promise<WebPage | null> {
  try {
    const r = await fetch(`${origin}/api/sessions/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: sid, url }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { ok?: boolean; html?: string };
    if (!j?.ok || !j.html) return null;
    return { raw: j.html, doc: buildHtmlDoc(j.html, { base: url, sid, origin, hlsAssetUrl }) };
  } catch {
    return null; // 服务端没这个口 / 网络异常 ⇒ 回落
  }
}

/**
 * 取一个地址（原始 HTML + 补壳文档）。
 * @throws 取页失败 / 二进制资源 / 空页时抛 Error（调用方负责提示）
 */
export async function fetchWebPage(url: string, sid = ''): Promise<WebPage> {
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http(s) 地址');
  const origin = serverOriginOf();
  // `#453`：有该源的浏览器会话就先试真浏览器（失败/没有 ⇒ 落到既有的 /api/proxy）
  if (sid && origin) {
    const viaSession = await fetchViaSession(url, sid, origin);
    if (viaSession != null) return viaSession;
  }
  const q = `/api/proxy?u=${encodeURIComponent(url)}${sid ? `&sid=${encodeURIComponent(sid)}` : ''}`;
  const res = await fetch(q, { headers: { accept: 'text/html,application/xhtml+xml,*/*' } });
  if (!res.ok) throw new Error(`取页失败 HTTP ${res.status}（${url}）`);
  const type = String(res.headers.get('content-type') ?? '');
  // 二进制（图片/音视频/下载包）不能塞进 srcdoc ⇒ 明确报错，别让用户看到一片乱码
  if (type && !/text|html|xml|json/i.test(type)) throw new Error(`该地址是二进制资源（${type}），无法在阅读页渲染`);
  const text = await res.text();
  if (!text.trim()) throw new Error(`取页为空（${url}）`);
  // ⚠️ `#349`（2026-10-08）**撤销 `#345` 在这里的 `decorateRssHtml`**：
  // 真浏览器 A/B 实测（`24ao.cc` 文章页，13 张图）——「带 decorate」**0/13** 加载成功，
  // 「不带」**9/13**。原因是 24 系列的图走**站点自己的 `jquery.lazyload`**：
  // 占位 `src="/grey.gif"` + 真地址在 `data-original`；装饰期把 `src` 改成 `/api/proxy?u=…grey.gif`
  // 会让 lazyload **认不出占位符**（它按 `src` 判「是否已加载」）⇒ 真图永不换上 ⇒ 整页图全破。
  // 正确的改写位置是**壳里的 `buildResourceBridge`**（内容侧、运行时、能同时看 `src`/`data-original`），
  // 见 `html-shell.ts` 注释。取页就是取页，不再做装饰期猜测。
  return { raw: text, doc: buildHtmlDoc(text, { base: url, sid, origin, hlsAssetUrl }) };
}

/**
 * 取一个地址并补壳。
 * @returns 补好壳的 HTML 文档；失败抛 Error（调用方负责提示）
 */
export async function fetchWebDoc(url: string, sid = ''): Promise<string> {
  return (await fetchWebPage(url, sid)).doc;
}

/**
 * 取一个地址的**原始 HTML**（不补壳）。
 *
 * `#574` 站点定制弹窗的「HTML 源码」栏用它：用户要按真实 DOM 写 CSS 选择器，
 * 看到壳层注入的脚本/样式只会干扰判断。
 */
export async function fetchWebSource(url: string, sid = ''): Promise<string> {
  return (await fetchWebPage(url, sid)).raw;
}
