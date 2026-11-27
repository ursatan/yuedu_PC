/**
 * 播放链解析（MacCMS T1，§6.4）
 *
 * 分隔符层级（默认 dollar-hash）：
 *   $$$    → 播放源（与 vod_play_from 按下标一一对应）
 *   #      → 集
 *   $      → 集名 与 地址
 *
 * ⚠️ 关键约束（zyfun t1Json.ts 的坑）：
 * 不能用 split('$') 后解构取前两项 —— 若 URL 本身含 $ 会被截断。
 * 必须改用 indexOf('$') 只切第一个分隔符。
 *
 * 兼容 3 种主流格式（用户可在源配置里用 playSplit 切换）：
 *   1) dollar-hash: '线路一$$E01$url#E02$url$$线路二$$...'
 *   2) crlf:        '线路一\r\nE01,url\r\nE02,url\r\n\r\n线路二\r\n...'（部分旧站）
 *   3) colon:       '线路一|||E01:url|||E02:url'
 * 另含分支：
 *   - vod_play_from + vod_play_url 双数组（$$$ 对齐，每段含 $ 与 #）
 *   - 仅 vod_url（单线路 fallback，挂默认线路）
 * 默认把 .m3u8 线路前置。
 */

export type PlaySplit = 'dollar-hash' | 'crlf' | 'colon';

export interface ParsedEpisode {
  /** 集名（无 $ 时默认「正片」） */
  text: string;
  /** 播放地址 */
  link: string;
}

export interface ParsedPlaySource {
  /** 播放源名（m3u8 / mp4 / 云播 ...） */
  from: string;
  episodes: ParsedEpisode[];
}

export interface ParsePlayOpts {
  /** 选集分隔方案，默认 dollar-hash */
  split?: PlaySplit;
  /**
   * `#653` **多线路分隔符**，默认 `$$$`（OmniFlow 的 `playFromSplit`）。
   * 个别源用 `$$` / `|||` / `@` 之类；不配就保持旧行为（`$$` 及更多个 `$` 都认）。
   */
  lineSep?: string;
  /** 单线路 fallback 原始串（vod_url） */
  vodUrl?: string | null;
  /** 是否把 m3u8 线路前置，默认 true */
  preferM3u8?: boolean;
}

/**
 * 解析 vod_play_from / vod_play_url（可选 vod_url 兜底）为结构化播放链。
 * 两个串长度不一致时缺失部分按空处理，不抛错（容错真实源）。
 */
export function parsePlayList(
  fromStr: string | undefined,
  urlStr: string | undefined,
  opts: ParsePlayOpts = {},
): ParsedPlaySource[] {
  const split = opts.split ?? 'dollar-hash';
  const preferM3u8 = opts.preferM3u8 !== false;
  /**
   * `#653` 线路分隔：显式配了 `lineSep` 就**按字面串**切；没配保持旧的 `$$+` 正则
   * （历史数据里有 `$$` 写的源，不能因为改成分隔符就认不出）。
   */
  const lineSep = (opts.lineSep ?? '').trim();
  const hasLineSep = (t: string): boolean => (lineSep ? t.includes(lineSep) : /\$\$+/.test(t));
  const splitLines = (t: string): string[] => (lineSep ? t.split(lineSep) : t.split(/\$\$+/));

  const safeSrc = (urlStr ?? '').trim();
  const vodUrl = (opts.vodUrl ?? '').trim();
  const vodPlayFrom = (fromStr ?? '').trim();
  const out: ParsedPlaySource[] = [];

  const pushLine = (name: string, pairs: Array<{ name: string; url: string }>) => {
    const plays = pairs
      .filter((p) => p.name || p.url)
      .map((p) => ({ text: p.name || '正片', link: p.url }));
    if (plays.length) out.push({ from: name || `线路${out.length + 1}`, episodes: plays });
  };

  const splitPairs = (raw: string): Array<{ name: string; url: string }> => {
    const s = raw.trim();
    if (!s) return [];
    return s
      .split('#')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => {
        const d = e.indexOf('$');
        if (d > 0) return { name: e.slice(0, d), url: e.slice(d + 1) };
        return { name: '', url: e };
      });
  };

  // ---- 分支 1：vod_play_from[] + vod_play_url[] 双数组（$$$ 对齐）----
  // 只要 from 与 url 都含 $$$ 且按 $$$ 分段数一致，即视为标准双数组格式。
  // 不强制每段都含 '#'（单集线路 "第1集$url" 合法）。
  if (vodPlayFrom && (safeSrc || vodUrl)) {
    const urlText = safeSrc || vodUrl || '';
    const hasLineSepFrom = hasLineSep(vodPlayFrom);
    const hasLineSepUrls = hasLineSep(urlText);
    if (hasLineSepFrom || hasLineSepUrls) {
      const fromArr = splitLines(vodPlayFrom).map((s) => s.trim()).filter(Boolean);
      const urlArr = splitLines(urlText).map((s) => s.trim()).filter(Boolean);
      if (fromArr.length && urlArr.length && fromArr.length === urlArr.length) {
        for (let i = 0; i < fromArr.length; i++) {
          pushLine(fromArr[i] ?? `线路${i + 1}`, splitPairs(urlArr[i] ?? ''));
        }
        return preferM3u8 ? sortM3u8(out) : out;
      }
    }
  }

  // ---- 分支 3：仅 vod_url（单线路 fallback）----
  if (!safeSrc && vodUrl) {
    pushLine(vodPlayFrom || '默认线路', splitPairs(vodUrl));
    return preferM3u8 ? sortM3u8(out) : out;
  }

  const src = safeSrc;
  if (!src) return preferM3u8 ? sortM3u8(out) : out;

  // ---- crlf 格式 ----
  if (split === 'crlf' || (split === 'dollar-hash' && /[\r\n]/.test(src) && !hasLineSep(src) && !src.includes('|||'))) {
    const groups = src.split(/\r?\n\s*\r?\n/);
    for (const g of groups) {
      const lines = g.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) continue;
      const lineName = lines.shift()!;
      const pairs = lines.map((item) => {
        const comma = item.indexOf(',');
        if (comma > 0) return { name: item.slice(0, comma), url: item.slice(comma + 1) };
        const dol = item.indexOf('$');
        if (dol > 0) return { name: item.slice(0, dol), url: item.slice(dol + 1) };
        return { name: '', url: item };
      });
      pushLine(lineName, pairs);
    }
    return preferM3u8 ? sortM3u8(out) : out;
  }

  // ---- colon 格式 ----
  if (split === 'colon' || src.includes('|||')) {
    const tokens = src.split(/\|\|\|/).map((s) => s.trim()).filter(Boolean);
    let current = `线路${out.length + 1}`;
    let buffer: Array<{ name: string; url: string }> = [];
    for (const tok of tokens) {
      const sep = tok.indexOf(':');
      if (sep < 0 || sep === tok.length - 1) {
        if (buffer.length) {
          pushLine(current, buffer);
          buffer = [];
        }
        current = tok || current;
        continue;
      }
      const label = tok.slice(0, sep).trim();
      const url = tok.slice(sep + 1).trim();
      if (label && url) buffer.push({ name: label, url });
    }
    if (buffer.length) pushLine(current, buffer);
    return preferM3u8 ? sortM3u8(out) : out;
  }

  // ---- dollar-hash（默认）----
  const lines = splitLines(src).map((s) => s.trim()).filter(Boolean);
  let i = 0;
  while (i < lines.length) {
    const first = lines[i]!;
    const looksLikePairs = first.includes('$') && first.includes('#');
    let lineName: string;
    let pairsStr: string;
    if (looksLikePairs || i + 1 >= lines.length) {
      lineName = `线路${out.length + 1}`;
      pairsStr = first;
      i += 1;
    } else {
      lineName = first;
      pairsStr = lines[i + 1] ?? '';
      i += 2;
    }
    pushLine(lineName, splitPairs(pairsStr));
  }
  return preferM3u8 ? sortM3u8(out) : out;
}

function sortM3u8(lines: ParsedPlaySource[]): ParsedPlaySource[] {
  return lines.slice().sort((a, b) => {
    const aM = a.episodes.some((p) => /\.m3u8(\?|#|$)/i.test(p.link || '')) ? 0 : 1;
    const bM = b.episodes.some((p) => /\.m3u8(\?|#|$)/i.test(p.link || '')) ? 0 : 1;
    return aM - bM;
  });
}

/** 由地址后缀推断播放类型，交给播放器决定怎么放 */
export function inferFormat(url: string): 'm3u8' | 'mp4' | 'audio' | 'unknown' {
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) return 'm3u8';
  if (/\.mp4(\?|#|$)/i.test(url)) return 'mp4';
  if (/\.(mp3|m4a|aac|wav|ogg|flac)(\?|#|$)/i.test(url)) return 'audio';
  return 'unknown';
}
