/**
 * `#352` 正文媒体形态判据 —— **纯字符串谓词、零依赖**（不 import 任何 node / DOM 模块）。
 *
 * 为什么独立成叶子模块：两个调用方的运行环境天差地别 ——
 *  · 服务端引擎（engine-rss 的嗅探门控）从 `@yuedu/core` index 导入没问题；
 *  · **前端**（`apps/web` 的 `html-shell.ts`）如果也从 index 导入，vite 会把整个
 *    core（user-store 的 `node:fs`、net 的 undici…）拉进浏览器 bundle ⇒
 *    rollup `copyFileSync is not exported` 构建失败（2026-10-08 实测）。
 *    ⇒ 前端走**窄子路径** `@yuedu/core/media-shape`（core package.json exports）。
 * 铁律「同一判据写两处必然漂移」：两个环境共用这里这一份。
 */

/** 正文是否**自带 hls.js 播放器**（真的在调用 Hls API，而不是只提了个 m3u8 字样）。
 *
 *  · 引擎嗅探门控：`mediaFromRaw` 提到候选但正文自己就是一页 hls.js 播放器
 *    （如「影视聚合(资源站)」的 ruleDescription）⇒ 它自己能播，**不嗅探**；
 *  · 前端壳层（`html-shell.ts`）：正文调用 Hls API 但没自带库 ⇒ 注入 hls.js 资产。
 */
export function bodyUsesHls(raw: string): boolean {
  return /Hls\.isSupported|new Hls\(|hls\.loadSource/i.test(raw);
}

/** 正文有没有**自带 hls.js 库**（`<script src=…hls…>`；自带就用源的，不重复注入） */
export function bodyHasHlsLib(raw: string): boolean {
  return /<script[^>]*src=[^>]*hls/i.test(raw);
}

/**
 * `#376` **媒体直链后缀**判定（自 `media-extract.ts` 下沉）。
 *
 * 为什么搬：`#376` LIVE 观察桥（`apps/web/src/utils/html-shell.ts`）在**iframe 内**运行，
 * 无法 import 任何 TS 模块 —— 父页生成桥文本时用 `fn.toString()` 把这里的**同一份函数**
 * 注入桥脚本（自包含、无闭包引用 ⇒ 压缩后语义不变）。若把正则留在 media-extract，
 * 桥内联副本必然漂移（铁律：同一判据写两处必然漂移）。media-extract 从这里
 * re-export 保持既有导入面（`MEDIA_EXT_RE` 是公开导出，测试与引擎在用）。
 *
 * 用于「源把播放地址写在图片类规则里」的形态兜底；含 query 里的扩展名
 * （麻豆 `/api/v1/m3u8/proxy?path=x.m3u8`）。
 */
export const MEDIA_EXT_RE = /\.(m3u8|mp4|m4v|webm|flv|mkv|ts|mp3|m4a|aac|flac|wav|ogg)(\?|#|$)/i;

/**
 * `#376` 「URL 看起来像媒体直链」的**路径提示**正则 —— likeMediaUrl 的第二半。
 * 单独导出：LIVE 桥（iframe 内）无法 import TS，父页生成桥文本时按
 * `new RegExp(MEDIA_HINT_RE.source, 'i')` 重建同一判据（判据本体唯一源自本模块；
 * 桥内只有「A.test(u) || B.test(u)」三行胶水，必须与本函数保持一致）。
 */
export const MEDIA_HINT_RE = /\/m3u8|hls|\/video\//i;

/**
 * `#376` 「URL 看起来像媒体直链」谓词 —— **唯一判据**，两处消费：
 *  · `media-extract.ts` 的 `mediaFromRaw` 主候选门槛（原判据逐字搬入，零语义变化）；
 *  · `#376` LIVE 桥（iframe 内收集 video/audio/iframe 的实际挂载地址时过滤）。
 */
export function likeMediaUrl(u: string): boolean {
  return MEDIA_EXT_RE.test(u) || MEDIA_HINT_RE.test(u);
}
