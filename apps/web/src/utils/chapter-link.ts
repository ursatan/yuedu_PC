/**
 * 「正文里的链接是不是**本书某一章**」的唯一实现（`#387d`，AGE动漫「选集」实测）。
 *
 * ## 为什么需要
 * 正文 HTML 里常带**站点自己的选集/分集 UI**（AGE 章节页的 `.card-body` 就是
 * `<a href="/play/20260335/1/1" class="video_detail_spisode_link">`）。
 * 壳层的**页内导航桥**（`utils/html-shell.ts` 的 `buildNavBridge`）会把**所有** `<a>` 点击
 * 拦下来交给宿主 → 宿主 `navGo(url)` 把整页换成那个地址（重新抓取 + 换 srcdoc）。
 * 对选集链接来说这是**错的行为**：用户点了「第02集」，得到的是「整页被换掉/被带离当前播放页」，
 * 而不是「换一集继续看」。
 *
 * ## 判据（唯一）
 * 点到的绝对 URL **命中本书章节目录里的某一章** ⇒ 那是「换集」，宿主应当走**换章**
 * （`reader.openChapter(ch)`，与目录点击同一条路）而不是页内跳转。
 *
 * ## 归一化口径（必须宽，否则同一条链接会漏判）
 *  · **不看 scheme**：`http://www.agedm.io/play/1/1` 与 `https://www.agedm.io/play/1/1` 同一章
 *    （站点自己在详情页写 `http://`、在 `https` 页面里写相对路径，两边都会出现）；
 *  · **host 小写 + path 去尾斜杠**；
 *  · **query 只用来打破「同 host+path 多章」的歧义**（通常为空）；
 *  · 章节目录里的 `url` 可能是**相对路径** ⇒ 按候选链接的 origin 补全（同一站点）；
 *  · `#fragment` 不参与比较。
 *
 * 命中「同 host+path 多章」且 query 也对不上时返回 -1（宁可当普通链接跳转，也不猜错章）。
 */

/**
 * 章节目录项的最小可用面 —— 与 **store 里 `detail.chapters` 的真实形状**一致：
 * 前端章节项只有 `title` / `payload`，地址在 `payload.chapterUrl`（源给的章节地址），
 * 老形态回落 `payload.url`。⚠️ 口径与 `stores/reader.ts:1240`（续读定位用同一套）保持一致：
 * 写成两处必然漂移（改这里请同时看那边）。
 */
export interface ChapterUrlLike {
  /** 少数形态直接在项上带地址 */
  url?: string;
  /** store 里是 `unknown`（契约层不约束 payload 内部）⇒ 这里按需窄化 */
  payload?: unknown;
}

/** 取一个章节目的地址（**唯一实现**）。空 ⇒ ''（调用方跳过） */
export function chapterUrlOf(ch: ChapterUrlLike | undefined): string {
  if (!ch) return '';
  const raw = ch.payload;
  const p = raw && typeof raw === 'object' ? (raw as { chapterUrl?: unknown; url?: unknown }) : {};
  return String(ch.url ?? p.chapterUrl ?? p.url ?? '');
}

interface Norm {
  host: string;
  path: string;
  query: string;
}

/** 解析成比较用三元组；失败返回 null（调用方跳过） */
function norm(u: string, base?: string): Norm | null {
  try {
    const x = base ? new URL(u, base) : new URL(u);
    return {
      host: x.host.toLowerCase(),
      // 去尾斜杠：`/play/1/1/` 与 `/play/1/1` 同一章
      path: x.pathname.replace(/\/+$/, ''),
      query: x.search,
    };
  } catch {
    return null;
  }
}

/**
 * 在章节目录里找 `url` 对应的下标；找不到返回 **-1**。
 *
 * @param chapters 本书章节目录（`detail.chapters`）
 * @param url      正文里点到的链接（壳层已绝对化）
 */
export function findChapterIndexByUrl(chapters: readonly ChapterUrlLike[], url: string): number {
  const target = norm(url);
  if (!target) return -1;
  let first = -1;
  let samePath = 0;
  for (let i = 0; i < chapters.length; i++) {
    const raw = chapterUrlOf(chapters[i]);
    if (!raw) continue;
    // 相对章节 url 按候选的 origin 补全（同一站点 —— 正文就是这章自己的页面）
    const c = norm(raw, raw.startsWith('http') ? undefined : `https://${target.host}`);
    if (!c) continue;
    if (c.host !== target.host || c.path !== target.path) continue;
    samePath += 1;
    if (c.query === target.query) return i;
    if (first === -1) first = i;
  }
  // 同 host+path 只有一章、且它 query 为空（或候选 query 为空）⇒ 直接算命中
  return samePath === 1 ? first : -1;
}
