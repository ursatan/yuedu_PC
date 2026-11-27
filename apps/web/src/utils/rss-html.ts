/**
 * `#345` RSS 正文 HTML 的渲染前资源改写。
 *
 * ## ⚠️ `#349`（2026-10-08）起：**本模块无生产引用，不再是「唯一实现」**
 * 这里的 `decorateRssHtml` 曾在 `web-doc.ts` / `ReaderOverlay.vue` 两条渲染通路调用；
 * `#349` 已把两处调用**全部撤除**，资源改写统一交给壳里的 `buildResourceBridge`
 * （`html-shell.ts`，运行时、能同时看 `src`/`data-original`/相对地址）。
 *
 * ### 为什么撤（三条，缺一即错）
 * 1. **它会把懒加载占位也改写**：对**每个** `img[src]` 无差别改写 ⇒ 站点用
 *    `src="/grey.gif"` + `data-original` 的 `jquery.lazyload` 认不出占位 ⇒ 真图永不换上。
 * 2. **与桥职责重复**：同一判据写两处必然漂移（`#247`/`#312` 铁律）⇒ 撤销后职责唯一归桥。
 * 3. **装饰期做的是猜测**：DOMParser 静态解析看不到运行后才插入的节点（如 24 系列的
 *    `#imgData` → `atob` → `<img src="…">`），而那才是 24 系列正文图的**唯一**来源。
 *
 * ### 现状
 * 生产构建里已被 tree-shaking 剔除（`grep -c decorateRssHtml dist/assets/index-*.js` = 0）。
 * 文件**保留**（`#350` 归因记录 + `apps/web/tests/rss-html.test.ts` 仍在跑），
 * 但**不要再往渲染通路接回来**。
 *
 * ## 历史缺陷类别（当时的归因，仍有效）
 * 24 系列源的 `ruleContent` 是一段**源作者写的脚本**：
 * ```
 * data="{{@@#imgData@value}}";
 * imgs = data.split("|");
 * for (...) html += '<img src="'+atob(imgs[i])+'" />';
 * ```
 * `atob` 解出来的是**相对路径**（`/LoadImage.ashx/….jpg`），且该端点是**盗链防护**的
 * （实测：裸取 / 带错 Referer → **403**；经 `/api/proxy`（带源头 Referer/UA/Cookie）→ **200 image/jpeg**）。
 *
 * ⇒ 与字典 HTML（`dict-html.ts`）同一类问题、同一处方：把资源地址补全为绝对并改写成
 * `/api/proxy?u=…&sid=…`。**处方本身仍对，只是执行位置应当是壳里的运行时桥。**
 *
 * ## 不做的事（保持最小改动）
 *  · 不 sanitize（正文 HTML 本就来自源，且 iframe 已 sandbox 隔离）；
 *  · 不改 `<script>`（源脚本原样保留，跨域通路由壳层的 NET 桥负责）；
 *  · `data:`/`blob:`/`javascript:` 一律不动。
 */
import { imgSrc } from './img';

/** 以 `base` 为基准补全为绝对 URL；不可用/危险协议返回空串 */
function absUrl(u: string, base: string): string {
  const s = String(u ?? '').trim();
  if (!s || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(s)) return '';
  try {
    return new URL(s, base || undefined).href;
  } catch {
    return '';
  }
}

/**
 * 把 RSS 正文里的 `<img src>` 改写成「绝对地址 → `/api/proxy`」。
 *
 * @param raw  正文 HTML（引擎下发的 `html`，含源脚本）
 * @param opts.base  相对地址补全基准（= 引擎的 `htmlBaseUrl`，文章绝对地址）
 * @param opts.sid   源 id（代理取源头 Referer/UA/Cookie 用）
 * @returns 改写后的 HTML（无 `base` 或无 DOM 环境时**原样返回**，退化为旧行为）
 */
export function decorateRssHtml(raw: unknown, opts: { base?: string; sid?: string } = {}): string {
  const html = String(raw ?? '');
  const base = String(opts.base ?? '').trim();
  if (!html || !base || typeof DOMParser === 'undefined') return html;

  let doc: Document;
  try {
    // ⚠️ 用 `<template>`：`<img>` 允许出现在 body 上下文，但源 HTML 可能含 `<td>/<tr>` 等
    //    仅表格上下文合法的片段 —— DOMParser 会按 text/html 容错处理；这里仍用 body 包裹以
    //    尽量贴近浏览器实际解析（与 iframe 内一致）。
    doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  } catch {
    return html;
  }
  const body = doc.body;
  if (!body) return html;

  // 图片：补全相对地址 → 走 /api/proxy（带源 Referer/UA/Cookie 绕防盗链）
  for (const el of Array.from(body.querySelectorAll('img[src]'))) {
    const a = absUrl(el.getAttribute('src') ?? '', base);
    if (!a) continue; // 危险协议/空 ⇒ 保持原样（源脚本可能还会自己设 src）
    el.setAttribute('src', imgSrc(a, { sourceId: opts.sid }));
    el.setAttribute('loading', 'lazy');
    // srcset 里的相对地址未处理 ⇒ 宁可不留（避免浏览器优先用它取到坏图）
    el.removeAttribute('srcset');
  }

  // `<source>`（`<picture>` / `<video>`）：同样补全 + 代理
  for (const el of Array.from(body.querySelectorAll('source[src]'))) {
    const a = absUrl(el.getAttribute('src') ?? '', base);
    if (a) el.setAttribute('src', imgSrc(a, { sourceId: opts.sid }));
  }

  // `<video poster>`：补全 + 代理
  for (const el of Array.from(body.querySelectorAll('video[poster]'))) {
    const a = absUrl(el.getAttribute('poster') ?? '', base);
    if (a) el.setAttribute('poster', imgSrc(a, { sourceId: opts.sid }));
  }

  return body.innerHTML;
}
