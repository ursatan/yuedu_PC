/**
 * **站点探查**（规则工坊右栏「站点探查」）—— 全部纯函数，便于单测。
 *
 * ## 为什么单独一份（而不是写在 `WorkshopView.vue` 里）
 * 把站点「抓页面 → 看内联脚本 → 扫全局变量 → 找媒体/iframe → 解 token → 试 AES → 拼播放链」
 * 这套手工动作沉淀成工具时，真正容易出错、也最值得回归锁住的是**分析逻辑**（正则口径、
 * 数字异或解码、`@js:`/`,{options}` 拆分）。视图只做接线 + 渲染，逻辑全在这里。
 *
 * ## 只读
 * 本模块**不发任何网络请求**（抓取/转发由视图走既有 `/api/proxy`）；AES 解密由视图用
 * WebCrypto 完成（`crypto.subtle` 只在浏览器有），这里只做字符串/字节层。
 */

/* ============================ 脚本 ============================ */

export interface InlineScript {
  /** 内联脚本序号（0 起） */
  index: number;
  /** 脚本源码长度（字符） */
  length: number;
  /** 前 200 字预览 */
  preview: string;
}

export interface ScriptAnalysis {
  inline: InlineScript[];
  /** 外部 `<script src>` 列表（原样，未解析相对地址） */
  external: string[];
}

const PREVIEW_LEN = 200;

/**
 * 扫描页面里的脚本：内联 `<script>…</script>`（长度 + 前 200 字预览）与外部 `<script src>`。
 *
 * 实现走「标签行走」而不是单个正则：`<script src>…</script>` 这种**带 src 的空体**必须
 * 归入外部列表（直接按「含 src ⇒ external，否则 inline」判），且不把它的空体当内联脚本。
 */
export function analyzeScripts(html: string): ScriptAnalysis {
  const inline: InlineScript[] = [];
  const external: string[] = [];
  const openRe = /<script\b([^>]*)>/gi;
  const closeRe = /<\/script\s*>/gi;
  let seq = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    const attrs = m[1] ?? '';
    const bodyStart = m.index + m[0].length;
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(html);
    const bodyEnd = close ? close.index : html.length;
    const srcM = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (srcM) {
      const u = (srcM[1] ?? srcM[2] ?? srcM[3] ?? '').trim();
      if (u) external.push(u);
    } else {
      const body = html.slice(bodyStart, bodyEnd);
      if (body.trim()) inline.push({ index: seq++, length: body.length, preview: body.slice(0, PREVIEW_LEN) });
    }
    // 跳到该 script 体之后（避免把体里出现的字面 `<script>` 当成新标签；缺闭合则到文末）
    openRe.lastIndex = bodyEnd;
  }
  return { inline, external };
}

/* ============================ 全局变量 ============================ */

export interface GlobalVar {
  name: string;
  value: string;
  /** 值超长被截断 */
  truncated: boolean;
}

export interface DecodeParam {
  name: string;
  value: string;
}

const VALUE_PREVIEW = 80;

/** 统计子串出现次数（用于「只出现一次」判据） */
function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

/**
 * 扫 `var|let|const <name> = <值>`（值截断到 80 字）。同名只保留首次出现的声明。
 */
export function scanGlobals(html: string, maxValue = VALUE_PREVIEW): GlobalVar[] {
  const re = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  const out: GlobalVar[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1] ?? '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const raw = (m[2] ?? '').trim();
    const truncated = raw.length > maxValue;
    out.push({ name, value: truncated ? raw.slice(0, maxValue) : raw, truncated });
  }
  return out;
}

/**
 * **疑似解码参数**：形如 `hcdeedg252=22` 的「数字赋值」，且该名字在整页**只出现一次**
 * （出现多次的多半是正常变量，一次性赋值的数字常量才是可逆算法的进参）。
 *
 * 名称前用负向断言排除属性/点访问（`<a href=1` / `obj.x=1`）造成的误报。
 */
export function findDecodeParams(html: string, maxCount = 12): DecodeParam[] {
  const re = /(?<![\w$.<>])([A-Za-z_$][\w$]*)\s*=\s*(\d+)(?![\d.])/g;
  const out: DecodeParam[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1] ?? '';
    const value = m[2] ?? '';
    if (!name || seen.has(name)) continue;
    // 只出现一次（名字整体）⇒ 一次性赋值的常量，最可能是解码参数
    if (countOccurrences(html, name) !== 1) continue;
    seen.add(name);
    out.push({ name, value });
    if (out.length >= maxCount) break;
  }
  return out;
}

/* ============================ 锚点 / 选择器 ============================ */

export interface AnchorCount {
  value: string;
  count: number;
}

export interface AnchorAnalysis {
  classes: AnchorCount[];
  ids: AnchorCount[];
}

/**
 * 页面里出现频率最高的 `class` / `id`（各前 `top` 个，带计数）—— 对应「锚点分析」，
 * 用来判断选择器该锚在哪个容器上。`class` 按空白切分成多个类名分别计数。
 */
export function analyzeAnchors(html: string, top = 20): AnchorAnalysis {
  const classCount = new Map<string, number>();
  const idCount = new Map<string, number>();
  const classRe = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const idRe = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(html))) {
    for (const c of (m[1] ?? m[2] ?? '').split(/\s+/)) {
      if (c) classCount.set(c, (classCount.get(c) ?? 0) + 1);
    }
  }
  while ((m = idRe.exec(html))) {
    const id = (m[1] ?? m[2] ?? '').trim();
    if (id) idCount.set(id, (idCount.get(id) ?? 0) + 1);
  }
  const rank = (mp: Map<string, number>): AnchorCount[] =>
    [...mp.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, top);
  return { classes: rank(classCount), ids: rank(idCount) };
}

/* ============================ 媒体 / iframe ============================ */

export type MediaKind = 'm3u8' | 'mp4' | 'flv' | 'media' | 'blob' | 'iframe' | 'video' | 'source' | 'embed' | 'play';

export interface MediaHit {
  kind: MediaKind;
  /** 原始命中串（未补全的地址） */
  raw: string;
  /** 补全后的地址（相对地址按页面 URL 解析；无页面 URL 时原样） */
  url: string;
}

/** 把可能为相对的地址按页面 URL 补全；非 http(s)（blob:/data:/rtmp: 等）原样返回 */
export function resolveUrl(u: string, base: string): string {
  const s = u.trim();
  if (!s) return s;
  // 已有 scheme 且非 http(s)（blob:/data:/rtmp:/magnet: …）⇒ 原样
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) return s;
  if (!base) return s;
  try {
    return new URL(s, base).href;
  } catch {
    return s;
  }
}

function mediaKindOf(url: string): MediaKind | null {
  if (/\.m3u8(\?|#|$)/i.test(url) || /m3u8/i.test(url)) return 'm3u8';
  if (/\.mp4(\?|#|$)/i.test(url)) return 'mp4';
  if (/\.flv(\?|#|$)/i.test(url)) return 'flv';
  return null;
}

/**
 * 扫媒体命中：`m3u8|mp4|flv|blob:`、`<iframe src>`、`play.php`、`<video>`、`<source>`。
 * 逐条给「类型 + 原始串 + 补全地址」。
 */
export function scanMedia(html: string, pageUrl = ''): MediaHit[] {
  const hits: MediaHit[] = [];
  const push = (kind: MediaKind, raw: string): void => {
    const s = raw.trim();
    if (!s) return;
    hits.push({ kind, raw: s, url: resolveUrl(s, pageUrl) });
  };

  // 标签 src（iframe / video / source / embed）
  const tagRe = /<(iframe|video|source|embed)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const tag = (m[1] ?? '').toLowerCase() as MediaKind;
    push(tag, m[2] ?? m[3] ?? m[4] ?? '');
  }

  // 裸 URL：m3u8 / mp4 / flv / blob
  const urlRe = /(?:(?:https?:)?\/\/|\/|\.\/|\.\.\/)?[^\s"'<>\\]+?\.(?:m3u8|mp4|flv)(?:\?[^\s"'<>\\]*)?/gi;
  while ((m = urlRe.exec(html))) {
    const kind = mediaKindOf(m[0]);
    if (kind) push(kind, m[0]);
  }
  const blobRe = /blob:[^\s"'<>\\]+/gi;
  while ((m = blobRe.exec(html))) push('blob', m[0]);

  // play.php（含相对/绝对）
  const playRe = /[^\s"'<>\\]*play\.php[^\s"'<>\\]*/gi;
  while ((m = playRe.exec(html))) push('play', m[0]);

  // 去重（kind + url）
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.kind}\n${h.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ============================ 隐藏通道 ============================ */

export interface HiddenChannel {
  /** URL 本体（去掉 `@js:` 段与 `,{options}` 尾巴） */
  base: string;
  /** `@js:` 之后的 JS 段（若有） */
  js?: string;
  /** `,{…}` 尾巴原文（若有） */
  optionsRaw?: string;
  /** 尾巴 JSON.parse 结果（成功时） */
  options?: unknown;
  optionsOk?: boolean;
  optionsError?: string;
}

/**
 * 从 `{open}` 起找**平衡**到末尾的括号位置（同时数 `{}` 与 `[]`，跳过字符串字面量）。
 * 找不到返回 -1。
 */
function findBalancedEnd(s: string, openIdx: number): number {
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = openIdx; i < s.length; i += 1) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 拆隐藏通道：`https://…/x.html@js:'data:;base64,…',{"type":"18av"}`
 * ⇒ `{ base, js, optionsRaw, options }`。没有 `@js:` / 没有 `,{…}` 尾巴时对应字段缺省。
 *
 * 顺序：先从**整串末尾**找 `,{…}` 尾巴（平衡到串尾才算），再在剩余前缀里切 `@js:`。
 */
export function splitHiddenChannel(url: string): HiddenChannel {
  let prefix = url;
  let optionsRaw: string | undefined;
  for (let i = 0; i < url.length - 1; i += 1) {
    if (url[i] === ',' && url[i + 1] === '{') {
      const end = findBalancedEnd(url, i + 1);
      if (end === url.length - 1) {
        optionsRaw = url.slice(i + 1);
        prefix = url.slice(0, i);
        break;
      }
    }
  }
  const at = prefix.indexOf('@js:');
  const out: HiddenChannel = { base: at >= 0 ? prefix.slice(0, at) : prefix };
  if (at >= 0) out.js = prefix.slice(at + 4);
  if (optionsRaw !== undefined) {
    out.optionsRaw = optionsRaw;
    try {
      out.options = JSON.parse(optionsRaw);
      out.optionsOk = true;
    } catch (e) {
      out.optionsOk = false;
      out.optionsError = e instanceof Error ? e.message : String(e);
    }
  }
  return out;
}

/* ============================ 解码链（字符串部分） ============================ */

export interface RadixXorResult {
  sep: string;
  /** 按分隔符切出的段 */
  parts: string[];
  /** 每段的 parseInt（无法解析为 NaN） */
  values: number[];
  /** 无法解析的段 */
  badParts: string[];
  /** 每段异或后的码点（NaN 保留） */
  xored: number[];
  /** `String.fromCharCode` 拼出的文本 */
  text: string;
  error?: string;
}

/**
 * 解码链第一步：按 `sep` 切分 → `parseInt(p, radix)` → `^ xor` → `String.fromCharCode`。
 * 每一段中间结果都在返回值里（让用户看到**哪一步**出错：`badParts` 非空即进制/分隔符选错）。
 */
export function decodeRadixXor(token: string, radix: number, sep: string, xor: number): RadixXorResult {
  const parts = sep ? token.split(sep) : [token];
  const values = parts.map((p) => parseInt(p.trim(), radix));
  const badParts = parts.filter((_, i) => Number.isNaN(values[i]));
  const xored = values.map((v) => (Number.isNaN(v) ? NaN : (v ^ xor) & 0xffff));
  const text = xored.map((v) => (Number.isNaN(v) ? '' : String.fromCharCode(v))).join('');
  const out: RadixXorResult = { sep, parts, values, badParts, xored, text };
  if (badParts.length) {
    out.error = `有 ${badParts.length} 段无法按进制 ${radix} 解析：${badParts.slice(0, 5).join(', ')}`;
  }
  return out;
}

/* ============================ 字节 / base64（供视图 AES 用） ============================ */

/** UTF-8 字符串 → 字节（key / iv 用） */
export function utf8ToBytes(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

/**
 * base64（含 URL-safe）→ 字节。先规整 `-`/`_` 与补 `=`，宽松处理换行。
 * 供视图把它当 AES-CBC 密文喂给 `crypto.subtle.decrypt`。
 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  let s = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 像 base64 吗（用于判断解码结果是否可继续做 AES 输入） */
export function isLikelyBase64(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && t.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(t);
}

/* ============================ 结论块（可复制 markdown） ============================ */

export interface ReconReportInput {
  url: string;
  status?: number;
  bytes?: number;
  contentType?: string;
  scripts?: ScriptAnalysis;
  globals?: GlobalVar[];
  decodeParams?: DecodeParam[];
  anchors?: AnchorAnalysis;
  media?: MediaHit[];
  hidden?: HiddenChannel;
  /** 解码链最终文本（截断展示） */
  finalText?: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 把各段摘要拼成一段可直接粘贴的 markdown 结论块。 */
export function buildReconMarkdown(input: ReconReportInput): string {
  const lines: string[] = [];
  lines.push(`# 站点探查：${input.url}`);
  lines.push('');
  lines.push('## 概览');
  lines.push(`- HTTP 状态：${input.status ?? '—'}`);
  lines.push(`- 字节数：${input.bytes ?? '—'}`);
  lines.push(`- content-type：${input.contentType || '—'}`);
  lines.push('');

  if (input.scripts) {
    lines.push('## 脚本');
    lines.push(`- 内联：${input.scripts.inline.length} 个`);
    for (const s of input.scripts.inline.slice(0, 10)) {
      lines.push(`  - #${s.index} 长度 ${s.length}：${truncate(s.preview.replace(/\s+/g, ' '), 120)}`);
    }
    lines.push(`- 外部：${input.scripts.external.length} 个`);
    for (const u of input.scripts.external.slice(0, 10)) lines.push(`  - ${u}`);
    lines.push('');
  }

  if (input.globals || input.decodeParams) {
    lines.push('## 全局变量');
    lines.push(`- 声明：${input.globals?.length ?? 0} 个`);
    for (const g of (input.globals ?? []).slice(0, 20)) lines.push(`  - ${g.name} = ${truncate(g.value, 60)}`);
    lines.push(`- 疑似解码参数：${input.decodeParams?.length ?? 0} 个`);
    for (const p of (input.decodeParams ?? []).slice(0, 20)) lines.push(`  - **${p.name} = ${p.value}**`);
    lines.push('');
  }

  if (input.anchors) {
    lines.push('## 锚点 / 选择器');
    lines.push(`- class top：${input.anchors.classes.slice(0, 20).map((c) => `${c.value}(${c.count})`).join(', ') || '—'}`);
    lines.push(`- id top：${input.anchors.ids.slice(0, 20).map((c) => `${c.value}(${c.count})`).join(', ') || '—'}`);
    lines.push('');
  }

  if (input.media) {
    lines.push('## 媒体');
    if (!input.media.length) lines.push('- （无）');
    for (const h of input.media.slice(0, 30)) lines.push(`- [${h.kind}] ${h.url}`);
    lines.push('');
  }

  if (input.hidden) {
    lines.push('## 隐藏通道');
    lines.push(`- URL 本体：${input.hidden.base}`);
    if (input.hidden.js !== undefined) lines.push(`- JS 段：${truncate(input.hidden.js, 200)}`);
    if (input.hidden.optionsRaw !== undefined) {
      lines.push(`- 选项：${truncate(input.hidden.optionsRaw, 200)}${input.hidden.optionsOk === false ? '（JSON 解析失败）' : ''}`);
    }
    lines.push('');
  }

  if (input.finalText !== undefined) {
    lines.push('## 解码链');
    lines.push(`- 文本：${truncate(input.finalText, 400)}`);
  }

  return lines.join('\n');
}

/** 概览里的 JSON 美化（前若干 KB；非 JSON 原样返回） */
export function prettyJson(text: string, maxBytes = 20_000): { isJson: boolean; pretty: string } {
  const head = text.slice(0, maxBytes);
  try {
    const parsed = JSON.parse(text);
    return { isJson: true, pretty: JSON.stringify(parsed, null, 2) };
  } catch {
    // 内容可能被截断（大响应）⇒ 就头部再试一次；仍失败则原样
    try {
      const parsed = JSON.parse(head);
      return { isJson: true, pretty: JSON.stringify(parsed, null, 2) };
    } catch {
      return { isJson: false, pretty: head };
    }
  }
}