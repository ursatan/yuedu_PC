/**
 * `#394` **解析云二级解析**：「解析页 URL → 可播直链」的唯一实现。
 *
 * ## 缺陷类别（用户 2026-10-11 实测 AGE动漫）
 * AGE `ruleContent` 的 `@js:` 合成页里，选集 href 全是
 * `https://jx.ejtsyc.com:8443/m3u8/?url=<epCode>` —— 这是**解析云（jx）的播放器页面**，
 * 不是 m3u8 直链：路径里带 `/m3u8/` 骗过了「像媒体」判据（`MEDIA_HINT_RE`），
 * LIVE 嗅探桥把它当媒体收进选集，播放器 `hls.loadSource` 一个 HTML 页 ⇒
 * `manifestParsingError`（60 集全军覆没的根因）。
 *
 * ## 为什么能解（实测 2026-10-11）
 * jx 页是**服务端渲染**的：真实直链就写在页面源码里
 * （`var Vurl = 'https://vip.ffzy-plays.com/…/index.m3u8';`），抓一遍页面跑
 * core `mediaFromRaw`（唯一实现，`#346`）就能提出来 —— 不需要浏览器渲染。
 *
 * ## 契约（对齐 `resolveLocalBookFile` 纪律）
 * **任何输入都不抛**：失败一律 `ok:false` + 人读原因。端点层（index.ts）只做薄包装。
 * fetch 以参数注入（单测可换假实现，不必真联网）。
 *
 * ## 判定顺序
 *  ① 地址带媒体直链扩展名（`MEDIA_EXT_RE`，判据唯一源 `@yuedu/core/media-shape`）
 *     ⇒ 本来就是直链，原样返回（`kind:'direct'`，零网络）；
 *  ② 抓页面（桌面 UA —— 解析云对 UA 不敏感，但桌面 UA 语义最接近「打开这个页面的人」）；
 *  ③ 响应本身是媒体类型（video/* · audio/* · mpegurl）⇒ 最终 URL 就是直链；
 *  ④ HTML ⇒ `mediaFromRaw(text, 最终URL)` 提直链（`.m3u8` 在源码里属于
 *     collectMediaCandidates ④「裸媒体扩展名 URL」，判据不用新写）；
 *  ⑤ 都不中 ⇒ `ok:false`。
 *
 * 运行：`pnpm --filter @yuedu/server test`
 */
import { MEDIA_EXT_RE } from '@yuedu/core/media-shape';
import { mediaFromRaw } from '@yuedu/core';

/** 注入的抓取函数形态（对齐 core `HttpClient.request` 的文本响应子集） */
export type MediaPageFetch = (
  url: string,
  opts: { headers?: Record<string, string>; timeout?: number },
) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: unknown;
  url?: string;
}>;

export interface MediaResolveResult {
  ok: boolean;
  /** ok=true ⇒ 可播直链（可能就是原地址）；ok=false 恒空串 */
  url: string;
  /** 媒体格式（m3u8/mp4/...，由 core `inferPlayFormat` 口径给出；可能缺省） */
  format?: string;
  /** 直链的备选（页面里提多个候选时） */
  alternatives?: string[];
  /** 直链需要的头（如 Referer；页面里带出来什么给什么） */
  headers?: Record<string, string>;
  /** `direct`=本来就是直链 · `page`=从解析页提出 · `none`=失败 */
  kind: 'direct' | 'page' | 'none';
  /** ok=false 时的人读原因（前端直接展示） */
  reason?: string;
}

/** ③ 里「响应本身就是媒体」的 Content-Type 前缀判据 */
const MEDIA_CT_RE = /^(?:video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))/i;

export interface MediaResolveInput {
  url: string;
  /** 附加请求头（调用方已合并源 header / Referer / UA） */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * 主入口。**绝不抛** —— 所有失败路径都返回 `ok:false`。
 */
export async function resolveMediaPage(
  input: MediaResolveInput,
  fetchFn: MediaPageFetch,
): Promise<MediaResolveResult> {
  const raw = String(input?.url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    return { ok: false, url: '', kind: 'none', reason: 'BAD_URL' };
  }
  // ① 直链扩展名 ⇒ 零网络直接返回（调用方通常已预判过，这里兜底保证幂等）
  if (MEDIA_EXT_RE.test(raw)) {
    return { ok: true, url: raw, kind: 'direct' };
  }
  // ② 抓解析页（网络层异常也归入 ok:false —— 二级解析失败不该变成 500）
  let status = 0;
  let headers: Record<string, string> = {};
  let finalUrl = raw;
  let text = '';
  try {
    const res = await fetchFn(raw, {
      headers: input.headers,
      ...(input.timeoutMs ? { timeout: input.timeoutMs } : {}),
    });
    status = res.status;
    headers = res.headers ?? {};
    finalUrl = res.url || raw;
    text = typeof res.body === 'string' ? res.body : '';
  } catch (e) {
    return { ok: false, url: '', kind: 'none', reason: `NETWORK:${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }
  if (status >= 400) {
    return { ok: false, url: '', kind: 'none', reason: `UPSTREAM_${status}` };
  }
  // ③ 响应就是媒体字节（最终 URL 即直链）
  const ct = headers['content-type'] ?? '';
  if (MEDIA_CT_RE.test(ct) || (ct === 'application/octet-stream' && MEDIA_EXT_RE.test(finalUrl))) {
    return { ok: true, url: finalUrl, kind: 'direct' };
  }
  // ④ HTML（或任意文本）⇒ core 唯一实现提直链
  if (!text) {
    return { ok: false, url: '', kind: 'none', reason: 'EMPTY_BODY' };
  }
  const m = mediaFromRaw(text, finalUrl);
  if (!m?.url) {
    return { ok: false, url: '', kind: 'none', reason: 'NO_MEDIA_IN_PAGE' };
  }
  return {
    ok: true,
    url: m.url,
    kind: 'page',
    ...(m.format ? { format: m.format } : {}),
    ...(m.alternatives?.length ? { alternatives: m.alternatives } : {}),
    ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
  };
}
