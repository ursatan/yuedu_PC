/**
 * **取数统一口**：详情/目录 与 正文。
 *
 * ## 为什么必须有这一个文件（`#207`）
 * 「整本下载」与「打开一章阅读」取的是**同一个东西**，但原先只有阅读器（`stores/reader.ts`）
 * 里有 `fetchDetail` / `fetchContent` 两份私有实现。下载中心若自己再写一遍，迟早出现
 * 「阅读能读到、下载下来是空的」这类偏差（本仓已经因为「两条路径各写一份」返工过：
 * 见 `#217` 的 `/api/user/local-books/content` 前缀坑）。
 * ⇒ 抽成**唯一实现**，阅读器与下载中心都调它。
 *
 * ## 两条通道
 *  · **本地书**（`origin === LOCAL_TAG`）：没有源，目录已由导入端点落库、正文按章号现取
 *    （见 `user-data.ts` 的 `getLocalBookContent`）。⚠️ 本地书**不需要下载**（正文本就在本机），
 *    下载中心会拒绝它 —— 对齐上游 `CacheBook.start()` 的 `if (!book.isLocal)`。
 *  · **书源 / 影视源**：走引擎 `runAction`（`detail` / `content`）。
 */
import { runAction } from '../api';
import { LOCAL_TAG } from '@yuedu/core/contract';
import type { ContentUiMark } from '@yuedu/core/contract';
import { getLocalBookContent } from '../user-data';

/** 这本书是不是本地书（`origin === LOCAL_TAG`） */
export function isLocalBookSource(src: string): boolean {
  return src === LOCAL_TAG;
}

export interface BookContent {
  title?: string;
  paragraphs?: string[];
  /**
   * `#308` 正文 HTML（与 `paragraphs` **互斥**）——
   * 上游订阅源正文是「组装后交给 WebView 的完整 HTML」（见契约 `UnifiedContent.html`），
   * 影视聚合播放器 / 24凹凸图集都靠它传下来。前端必须用能执行脚本的容器渲染。
   */
  html?: string;
  /** `#308` `html` 的相对地址基准 */
  htmlBaseUrl?: string;
  /** `#583` 正文源按钮（段评 / 本章说 / 神评 / 书评），与 `paragraphs` 并存 */
  uiMarks?: ContentUiMark[];
  subContent?: string;
  imageStyle?: string;
  imageDecode?: boolean;
  media?: { url: string; format?: string; alternatives?: string[]; headers?: Record<string, string> };
}

/**
 * 取**正文**。
 *
 * @param ch.payload 目录行里的章节标识（本地书是 `{ index }`）
 * @param opts.localBookUrl 本地书的 `bookUrl`（**已 `encodeItemKey` 过的**）。
 *        本地书走这条通道时必填 —— 它没有 payload 里的 chapterUrl，定位靠章号。
 */
export async function fetchBookContent(
  src: string,
  _bookPayload: unknown,
  ch: { title?: string; payload: unknown },
  /**
   * `#675` `signal`：**用户切走/切书时中断这次取正文**。
   *
   * 之前只有「结果不再采用」（`#674` 的代次守卫），但请求仍在飞、服务端也在跑真实抓取
   * （慢源能跑到 60s）。用户切走后立刻 abort，浏览器会断连接、服务端 `clientAbort` 也能
   * 提前收摊 —— 少一次白跑、也少一次对源站的请求。
   */
  opts: { localBookUrl?: string; signal?: AbortSignal } = {},
): Promise<BookContent> {
  if (isLocalBookSource(src)) {
    const idx = Number((ch.payload as { index?: number } | undefined)?.index ?? -1);
    if (!Number.isFinite(idx) || idx < 0) {
      throw new Error('本地书章节缺少章号（目录可能已损坏，重新导入一次即可）');
    }
    if (!opts.localBookUrl) throw new Error('本地书缺少 bookUrl，无法定位正文');
    const r = await getLocalBookContent(opts.localBookUrl, idx);
    // `#212` Step2：含图章（epub 插图）服务端会给 html —— 与 `paragraphs` 互斥，
    // 阅读器见到 html 即走 iframe 通路（`isHtmlChapter`），详见 `ReaderOverlay.vue`。
    return r.html ? { title: r.title, paragraphs: r.paragraphs, html: r.html } : { title: r.title, paragraphs: r.paragraphs };
  }
  return (await runAction(src, 'content', {
    id: JSON.stringify(ch.payload ?? {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) as BookContent;
}
