/**
 * `#620` **导出编排层**（前端）：取正文 → 净化 → 交给 core 的 `buildTxt` / `buildEpub`。
 *
 * ## 为什么导出放在前端而不是服务端
 * 净化语义（替换规则）住在 web：`stores/replaceRules.ts` 的 `applyContent` / `applyTitle`
 * 已经把「整章拼接后跑规则」「逐行 trim」「`compileRuleRegex` 的 Android→JS 折算」
 * 这些坑踩平了（`#252`/`#257`/`#260`/`#261`）。放服务端就要再实现一遍 ——
 * 那正是仓内铁律「同一判据写两处必然漂移」的禁区。副作用是导出的正文**与用户屏幕上看到的
 * 完全一致**（这也是验收里「替换规则在导出时生效」唯一能自证的方式）。
 *
 * ## 与整本下载（`utils/download-manager.ts`）的关系
 * 不复用它的调度（那是**持久任务 + 落 IndexedDB** 的模型），但沿用同一批参数：
 * 章内并发 3、每章重试 3 次 —— 这两个值是照上游 `onPostError`（重试 3）与本仓既有
 * 「⬇ 缓存」的实测值定的，**不要各写一份新的**。
 *
 * ## 一个刻意的不对齐点
 * 上游导出会 `refreshChapterList`（本地书先刷目录）与 `BookHelp.getContent`
 * （有缓存直接读缓存、没有就现抓）。我们**优先读缓存**（`getContent` 的调用方负责），
 * 缓存缺失才发请求 —— 语义与上游一致，且「导出已下载的书」不会再打源站。
 */

/**
 * ⚠️ **必须走 `@yuedu/core/export` 深路径**（`#631`）：根入口 `@yuedu/core` 会连带
 * `selector/js.ts → java-net.ts → node:zlib` 与 `dom/index.ts → jsdom` 一起进浏览器图，
 * 直接让 `vite build` 失败（`gunzipSync is not exported by __vite-browser-external`），
 * 且即使不报错也会把 jsdom 打进前端包。`export/` 这一层是**零 Node 依赖**的纯函数。
 */
import {
  buildEpub,
  buildTxt,
  collectExportImages,
  exportFileName,
  imageFetchUrlOf,
  type ExportChapterLike,
  type ExportImageAsset,
} from '@yuedu/core/export';

/** 与 `download-manager.ts` 同值（章内并发 / 重试），改动请两边一起改 */
export const EXPORT_CONCURRENCY = 3;
export const EXPORT_RETRY = 3;
/**
 * `#626` 图片下载并发。比正文低（3）：图片是「一次几十上百个小响应」，
 * 高并发容易撞源站的限流（实测漫画站在 6 并发开始返 429）。
 */
export const EXPORT_IMAGE_CONCURRENCY = 4;
/** `#626` 单张图重试次数（图片失败不阻断导出，所以只重试一次即可） */
export const EXPORT_IMAGE_RETRY = 1;

export interface ExportChapterSource {
  title: string;
  isVolume?: boolean;
  /** 章节地址（`#626` 用来补全正文图片的相对地址；缺省 ⇒ 相对图片原样保留） */
  url?: string;
}

export interface ExportChapterContent {
  /** 正文段落（图片源里可能是 `<img …>`） */
  paragraphs?: string[];
  /** 少数源（订阅/本地 epub 插图章）只给 html —— 这里降级成纯文本，不能整章丢掉 */
  html?: string;
}

export interface ExportDeps {
  /** 取一章正文（实现方应**先读本地缓存**；返回 null = 没有任何正文） */
  getContent(ch: ExportChapterSource, index: number): Promise<ExportChapterContent | null>;
  /**
   * 净化正文段落（替换规则）。不给 = 不净化。
   * `used` = **真正改动了正文**的规则 id（上游 `effectiveReplaceRules`），用于验收「净化确实跑了」
   */
  purifyContent?(
    paragraphs: string[],
    ch: ExportChapterSource,
    index: number,
  ): { paragraphs: string[]; used?: number[] };
  /** 净化章节标题（返回 maybe-used 规则 id 同正文） */
  purifyTitle?(title: string, ch: ExportChapterSource, index: number): { title: string; used?: number[] };
  /**
   * `#626` 取一张图片的字节（实现方走 `/api/proxy?u=…&sid=…`，才能带上源的
   * Referer/UA/Cookie —— 漫画站几乎都防盗链）。返回 null = 这张图没有，导出继续。
   *
   * 不给这个依赖 ⇒ 不做图片转存（正文保持远程地址，与 `#620` 行为一致）。
   */
  fetchImage?(url: string, ch: ExportChapterSource): Promise<Uint8Array | null>;
  /** `#626` 取封面字节（不给就导出不生成封面页） */
  fetchCover?(): Promise<{ src: string; data: Uint8Array } | null>;
  concurrency?: number;
  retry?: number;
  /** 取消信号（导出是长任务，用户可能中途走人） */
  isCancelled?(): boolean;
}

export interface ExportRequest {
  name: string;
  author?: string;
  intro?: string;
  chapters: readonly ExportChapterSource[];
  /** 章节下标闭区间（含两端）；缺省 = 全部 */
  from?: number;
  to?: number;
  format: 'txt' | 'epub';
  /** 是否写章节标题（上游 `!AppConfig.exportNoChapterName`） */
  includeChapterTitle?: boolean;
  /** 是否写书头（书名/作者/简介） */
  includeHeader?: boolean;
  /**
   * `#626` 是否把正文图片转存进 epub（默认 **true**；仅 epub 有效）。
   * 关掉 = 正文保持远程图片地址（`#620` 的老行为）。
   */
  embedImages?: boolean;
}

export interface ExportStats {
  /** 计划导出的章节数（区间内） */
  total: number;
  /** 实际写进文件的章节数 */
  written: number;
  /** 没有正文而跳过的（上游 `Pair("", null)`） */
  skipped: number;
  /** 取正文失败的章数（重试后仍失败） */
  failed: number;
  /** 起效的净化规则数（去重后；对不上就说明导出没走净化） */
  replaceUsed: number;
  /**
   * `#626` 图片统计（txt 恒为 0）。
   * `failed` 必须上报：图片挂了**不影响导出成功**，用户只能靠这个数字知道「少了几张图」。
   */
  images: { total: number; embedded: number; failed: number };
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  bytes: number;
  stats: ExportStats;
  /** txt 的全文（便于测试与「预览前 N 字」） */
  text?: string;
}

/** html 章节的兜底降级：剥标签、还原常见实体、段落化。够用就好，不做完整 HTML 解析 */
export function htmlToPlainParagraphs(html: string): string[] {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h\d|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 跑一次导出。返回 Blob（调用方负责 `URL.createObjectURL` + `<a download>`）。
 *
 * 失败语义：**单章失败不打死整本**（记入 `stats.failed` 继续跑），
 * 只有「全书一章都没拿到」才抛 —— 那种情况导出的空文件毫无意义。
 */
export async function exportBook(
  req: ExportRequest,
  deps: ExportDeps,
  onProgress?: (p: {
    done: number;
    total: number;
    failed: number;
    /** `#626`：区分「取正文」与「取图片」两个阶段（进度条文案不同） */
    phase?: 'chapters' | 'images';
    images?: { done: number; total: number; failed: number };
  }) => void,
): Promise<ExportResult> {
  const from = Math.max(0, req.from ?? 0);
  const to = Math.min(req.chapters.length - 1, req.to ?? req.chapters.length - 1);
  const picked: { ch: ExportChapterSource; index: number }[] = [];
  for (let i = from; i <= to; i++) {
    const ch = req.chapters[i];
    if (ch) picked.push({ ch, index: i });
  }

  const out: ExportChapterLike[] = new Array(picked.length);
  const stats: ExportStats = {
    total: picked.length,
    written: 0,
    skipped: 0,
    failed: 0,
    replaceUsed: 0,
    images: { total: 0, embedded: 0, failed: 0 },
  };
  const usedRules = new Set<string>();
  const concurrency = Math.max(1, deps.concurrency ?? EXPORT_CONCURRENCY);
  const retry = Math.max(0, deps.retry ?? EXPORT_RETRY);
  let done = 0;

  const one = async (ch: ExportChapterSource, index: number): Promise<ExportChapterLike> => {
    // 卷没有正文页（引擎对卷直接返回空内容、不发请求）—— 别为它打一次源站
    if (ch.isVolume) {
      stats.written += 1;
      return { title: ch.title, isVolume: true, paragraphs: null };
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retry; attempt++) {
      if (deps.isCancelled?.()) throw new Error('EXPORT_CANCELLED');
      try {
        const c = await deps.getContent(ch, index);
        if (!c) break;
        let paragraphs = c.paragraphs ?? (c.html ? htmlToPlainParagraphs(c.html) : []);
        if (!paragraphs.length) break;
        if (deps.purifyContent) {
          const r = deps.purifyContent(paragraphs, ch, index);
          paragraphs = r.paragraphs;
          for (const id of r.used ?? []) usedRules.add(String(id));
        }
        stats.written += 1;
        return { title: ch.title, paragraphs, isVolume: false };
      } catch (e) {
        lastErr = e;
        if (attempt < retry) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    if (lastErr) {
      stats.failed += 1;
      // 失败章按「没有正文」处理（上游 `Pair("", null)` 也是静默跳过）——
      // 但计数单独记，UI 必须告诉用户「少了几章」，否则用户以为导出完整
      stats.skipped += 1;
      return { title: ch.title, paragraphs: null };
    }
    stats.skipped += 1;
    return { title: ch.title, paragraphs: null };
  };

  // 保持顺序：拆成 concurrency 条泳道，各自按序取（结果按下标回填，不受完成顺序影响）
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, picked.length || 1) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= picked.length) return;
        const { ch, index } = picked[i]!;
        let title = ch.title;
        if (deps.purifyTitle) {
          const t = deps.purifyTitle(ch.title, ch, index);
          title = t.title;
          for (const id of t.used ?? []) usedRules.add(String(id));
        }
        const built = await one({ ...ch, title }, index);
        out[i] = built;
        done += 1;
        onProgress?.({ done, total: stats.total, failed: stats.failed });
      }
    }),
  );

  if (stats.total === 0) throw new Error('导出范围为空');
  if (stats.written === 0) {
    throw new Error(
      `一章正文都没拿到（共 ${stats.total} 章，失败 ${stats.failed}）—— 先把书缓存/打开几章再导出，或换源`,
    );
  }

  stats.replaceUsed = usedRules.size;
  const includeChapterTitle = req.includeChapterTitle !== false;

  if (req.format === 'epub') {
    /**
     * `#626` 图片转存：**先按正文实际内容算清单，再并发取字节**。
     *
     * 顺序不能反：清单必须来自**净化后**的段落（`collectExportImages` 内部先跑
     * `sanitizeExportContent`），否则会去抓那些「导出时注定被剔掉」的段评图
     * ——在慢源上就是白等几十秒，且 stats 里的数字与正文对不上。
     */
    const wantImages = new Map<string, string>(); // 原样 src → 绝对地址
    if (deps.fetchImage && req.embedImages !== false) {
      out.forEach((c, i) => {
        if (!c?.paragraphs?.length) return;
        const ch = picked[i]!.ch;
        for (const src of collectExportImages(c.paragraphs)) {
          if (wantImages.has(src)) continue;
          wantImages.set(src, imageFetchUrlOf(ch.url ?? '', src).trim());
        }
      });
    }
    // 同一张图可能在多章出现（相对/绝对两种写法 ⇒ 两个 rawSrc、同一个 URL）⇒ 按 URL 只下一次
    const uniqUrls = [...new Set([...wantImages.values()].filter(Boolean))];
    const bytesByUrl = new Map<string, Uint8Array | null>();
    stats.images.total = uniqUrls.length;
    if (uniqUrls.length) {
      let imgCursor = 0;
      let imgDone = 0;
      const imgConcurrency = Math.max(1, Math.min(EXPORT_IMAGE_CONCURRENCY, uniqUrls.length));
      await Promise.all(
        Array.from({ length: imgConcurrency }, async () => {
          for (;;) {
            const i = imgCursor++;
            if (i >= uniqUrls.length) return;
            if (deps.isCancelled?.()) throw new Error('EXPORT_CANCELLED');
            const url = uniqUrls[i]!;
            let got: Uint8Array | null = null;
            for (let attempt = 0; attempt <= EXPORT_IMAGE_RETRY; attempt++) {
              try {
                got = await deps.fetchImage!(url, picked[0]!.ch);
                if (got && got.length) break;
                got = null;
              } catch {
                got = null;
              }
            }
            bytesByUrl.set(url, got);
            if (!got) stats.images.failed += 1;
            imgDone += 1;
            onProgress?.({
              done: stats.total,
              total: stats.total,
              failed: stats.failed,
              phase: 'images',
              images: { done: imgDone, total: uniqUrls.length, failed: stats.images.failed },
            });
          }
        }),
      );
    }
    const assets: ExportImageAsset[] = [];
    for (const [src, url] of wantImages) {
      const data = url ? bytesByUrl.get(url) : null;
      if (!data || !data.length) continue; // 取不到 ⇒ 正文保留原地址（不阻断导出）
      assets.push({ src, url: url || src, data });
      stats.images.embedded += 1;
    }
    const coverHit = deps.fetchCover ? await deps.fetchCover().catch(() => null) : null;

    const bytes = await buildEpub({
      name: req.name,
      author: req.author,
      intro: req.intro,
      chapters: out,
      includeChapterTitle,
      ...(assets.length ? { images: assets } : {}),
      ...(coverHit?.data?.length ? { cover: { src: coverHit.src, data: coverHit.data } } : {}),
    });
    return {
      blob: new Blob([bytes as unknown as BlobPart], { type: 'application/epub+zip' }),
      filename: exportFileName(req.name, req.author, 'epub'),
      bytes: bytes.length,
      stats,
    };
  }

  const text = buildTxt({
    name: req.name,
    author: req.author,
    intro: req.intro,
    chapters: out,
    includeChapterTitle,
    includeHeader: req.includeHeader !== false,
  });
  return {
    blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
    filename: exportFileName(req.name, req.author, 'txt'),
    bytes: text.length,
    stats,
    text,
  };
}

/** 浏览器下载（不依赖任何库；导出入口与测试都走它，避免各处自造 `<a download>`） */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器（Safari）下载失败 —— 留一点余量
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
