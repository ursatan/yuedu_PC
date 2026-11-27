/**
 * `#820` **朗读分段**（服务端纯逻辑；不含 Web API，可单测）。
 *
 * 与 `apps/web/src/utils/read-aloud-core.ts` 的关系：
 *  · 那份是**阅读器侧**的分句（带「当前句高亮/滚动」用的章内偏移），本轮 UI 不动、也不改它；
 *  · 服务端要用同一套「可朗读判定 + 不吞字符」的纪律，否则「哪句在播」与「发出去的是哪句」
 *    会错位。等到 UI 那轮再把 Web 侧切到这份实现（那时才允许改 `.vue` / stores）。
 *
 * 三条硬约束：
 *  1. **不吞字符**：所有分段的 `text` 拼起来 = 输入里所有非空白内容（空白只在段边界被裁掉）；
 *  2. **偏移是原串下标**：`start/end` 与 `chapter-text` 的坐标系一致，供「当前句高亮」复用；
 *  3. **单段有上限**：超长句按标点/空白切，最后才硬切 —— 不许把整章塞进一次请求。
 */
import type { TtsErrorCode } from './types';
import { TTS_LIMITS } from './types';

/** 一条朗读分段（`start/end` = 原串字符下标，左闭右开） */
export interface TtsSegment {
  index: number;
  text: string;
  start: number;
  end: number;
}

export type TtsSegmentResult =
  | { ok: true; segments: TtsSegment[] }
  | { ok: false; code: Extract<TtsErrorCode, 'TTS_TEXT_EMPTY' | 'TTS_TEXT_TOO_LONG'>; message: string };

/** 上游 `AppPattern.notReadAloudRegex`（`AppPattern.kt:60`）：整串只有空白/控制/标点/符号 ⇒ 不读 */
const NOT_READ_ALOUD = /^(?:\s|\p{C}|\p{P}|\p{Z}|\p{S})+$/u;

/** 句末标点（与 Web 侧退化切分同一集合） */
const SENTENCE_END = '。！？!?…\n';
/** 长句优先在「句内停顿」处切（避免把词切断） */
const CLAUSE_END = '，；、,;:：— \t';
/** 句末标点后的收尾符（连续标点并进同一句） */
const TRAIL = '。！？!?…」』”）)\'"\n';

interface Unit {
  start: number;
  end: number;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** 环境不支持的 `Intl.Segmenter` 一律返回 null（退化切分，绝不抛错） */
function segmenterFor(): { segment(s: string): Iterable<{ segment: string }> } | null {
  try {
    const Seg = (Intl as unknown as {
      Segmenter?: new (l?: string, o?: { granularity: string }) => unknown;
    }).Segmenter;
    if (!Seg) return null;
    return new Seg('zh', { granularity: 'sentence' }) as { segment(s: string): Iterable<{ segment: string }> };
  } catch {
    return null;
  }
}

/** 按句切分成**首尾相接**的单元（不吞字符） */
function sentenceUnits(text: string): Unit[] {
  const seg = segmenterFor();
  const out: Unit[] = [];
  if (seg) {
    let cursor = 0;
    for (const s of seg.segment(text)) {
      const len = s.segment.length;
      if (len > 0) out.push({ start: cursor, end: cursor + len });
      cursor += len;
    }
    if (cursor < text.length) out.push({ start: cursor, end: text.length });
    if (out.length) return out;
  }
  // 退化：按中英句末标点切（与 Web 侧 `fallbackSplit` 同口径）
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (!SENTENCE_END.includes(text[i]!)) continue;
    let end = i + 1;
    while (end < text.length && TRAIL.includes(text[end]!)) end += 1;
    if (end > start) out.push({ start, end });
    start = end;
    i = end - 1;
  }
  if (text.length > start) out.push({ start, end: text.length });
  return out;
}

/** 超长句：优先在句内标点后切，其次空白，最后按 `maxChars` 硬切 */
function splitLongUnit(text: string, unit: Unit, maxChars: number): Unit[] {
  const out: Unit[] = [];
  let s = unit.start;
  while (unit.end - s > maxChars) {
    const windowEnd = s + maxChars;
    let cut = -1;
    // ① 句内标点（含标点本身）
    for (let i = windowEnd - 1; i >= s; i -= 1) {
      if (CLAUSE_END.includes(text[i]!)) {
        cut = i + 1;
        break;
      }
    }
    // ② 空白
    if (cut <= s) {
      for (let i = windowEnd - 1; i >= s; i -= 1) {
        if (/\s/.test(text[i]!)) {
          cut = i + 1;
          break;
        }
      }
    }
    // ③ 硬切（不许让「没有标点的长串」变成一次超大请求）
    if (cut <= s) cut = windowEnd;
    // 单字符守卫：切点退得太靠前时宁可硬切，避免一段只出 1~2 个字
    if (cut - s < Math.floor(maxChars / 4)) cut = windowEnd;
    out.push({ start: s, end: cut });
    s = cut;
  }
  if (unit.end > s) out.push({ start: s, end: unit.end });
  return out;
}

/** 去掉首尾空白（只缩边界，不改文本内容 ⇒ 偏移仍指向原串） */
function trimUnit(text: string, u: Unit): Unit | null {
  let s = u.start;
  let e = u.end;
  while (s < e && /\s/.test(text[s]!)) s += 1;
  while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
  if (e <= s) return null;
  return { start: s, end: e };
}

/**
 * 章内正文 → 朗读分段。
 *
 * `maxChars` 是**目标**不是硬上限：句子边界优先（一句话 260 字时宁可让它整段发，
 * 也好过在词中间切）；只有单句超过 `maxChars` 才走 `splitLongUnit`。
 */
export function segmentTtsText(
  text: string,
  opts: { maxChars?: number } = {},
): TtsSegmentResult {
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: false, code: 'TTS_TEXT_EMPTY', message: '没有可朗读的文字' };
  if (raw.length > TTS_LIMITS.segmentInput) {
    return {
      ok: false,
      code: 'TTS_TEXT_TOO_LONG',
      message: `文本超过 ${TTS_LIMITS.segmentInput} 字，请按章/段提交`,
    };
  }
  // 缺省 = `segmentChars`；显式 NaN（路由把 undefined 转成了 Number）也按缺省，不能落到下限 20
  const maxChars = Number.isFinite(opts.maxChars)
    ? clampInt(opts.maxChars as number, 20, 1000)
    : TTS_LIMITS.segmentChars;

  const units: Unit[] = [];
  for (const u of sentenceUnits(raw)) {
    const piece = raw.slice(u.start, u.end);
    if (!piece) continue;
    // 纯标点/空白不发给引擎（上游 `notReadAloudRegex` 同语义）
    if (NOT_READ_ALOUD.test(piece)) continue;
    if (u.end - u.start > maxChars) units.push(...splitLongUnit(raw, u, maxChars));
    else units.push(u);
  }

  // 合并相邻单元到 `maxChars` 以内（短句连读更自然，也少发请求）
  const merged: Unit[] = [];
  let cur: Unit | null = null;
  for (const u of units) {
    if (!cur) {
      cur = { ...u };
      continue;
    }
    const len = u.end - u.start;
    if (cur.end - cur.start + len <= maxChars) cur.end = u.end;
    else {
      merged.push(cur);
      cur = { ...u };
    }
  }
  if (cur) merged.push(cur);

  const segments: TtsSegment[] = [];
  for (const u of merged) {
    const t = trimUnit(raw, u);
    if (!t) continue;
    segments.push({ index: segments.length, text: raw.slice(t.start, t.end), start: t.start, end: t.end });
    if (segments.length >= TTS_LIMITS.segments) break;
  }
  if (!segments.length) return { ok: false, code: 'TTS_TEXT_EMPTY', message: '没有可朗读的文字' };
  return { ok: true, segments };
}
