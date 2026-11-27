/**
 * `#732` **外链脚本本地镜像 / 离线缓存**（jsLib · loginUrl · sortUrl）。
 *
 * ## 为什么需要（本轮实测，不是推断）
 * Movieffm（qyyuapi 系订阅源）的三个外链脚本：
 *   · `https://qyyuapi.com/dy/js/Movieffm/loginUrl.js`
 *   · `https://qyyuapi.com/dy/js/Movieffm/sortUrl.js`
 *   · `https://qyyuapi.com/js/common.js`
 * 浏览器能下载，引擎却成批超时。同一台机对照实测（2026-11-02，20 次 `https.request`）：
 * 只有 6 次 200，其余 14 次 **TCP/TLS 阶段挂死**（无状态码）；Node 全局 `fetch`（undici）
 * **0/4 成功**、每次 `fetch failed` 约 11s（10s connectTimeout 打满）。curl 直连同 URL 也时通时不通。
 * ⇒ 站点侧（Cloudflare LAX 出口）对本机**极不稳定**，不是 UA / Referer / TLS 指纹 / 代理问题
 * （UA+Referer 复测同样 20s 超时；本机 `ProxyEnable=0` 且无任何本地代理进程/端口）。
 *
 * ## ⚠️ 顺序已反转（用户 2026-11-02 决定）：**网络优先 → 镜像兜底**
 *
 * 早先的实现是「镜像优先」，用户明确否定：正常站点不该被本地文件挡住（镜像一旦过期，
 * 用户永远拿不到站点的新版本）。现在的语义：
 *   ① **先走网络**（HEAD/GET 走既有代码路径），成功 ⇒ 使用网络内容，并**回写镜像**
 *      （旁挂 `.meta.json` 记录 URL / 抓取时间 / 字节数 / sha256）；
 *      网络成功时**不读镜像**，也不会因镜像存在而跳过请求；
 *   ② **失败才用镜像**：超时 / 空响应 / 非 2xx / 连接错误 ⇒ 查 `data/jslib-mirror/<host>/<path…>`，
 *      命中 ⇒ 用镜像内容继续执行，日志写「镜像兜底命中（原因：<失败类型>）」；
 *   ③ 镜像也未命中 ⇒ 按原逻辑报失败（带明确原因，不返回静默空串）；
 *   ④ 同一 URL **连续失败达到阈值**（默认 3，`YUEDU_JSLIB_MIRROR_HINT_AFTER` 可调）⇒
 *      记一条「请手动下载」提示（同一 URL 只提示一次，跨进程持久化，见 §提示）。
 *
 * 开关：`YUEDU_JSLIB_MIRROR=0` 同时关闭**兜底读取**与**回写缓存**；`.meta.json` 校验失败按未命中回源。
 *
 * ## 提示（失败到阈值时给谁看、怎么看）
 * 本模块只负责**持久化与文案**（`data/jslib-mirror/.hints.json`），展示交给应用自己的反馈通道：
 * 服务端 `/api/diag` 的 `jslibHints` → 设置页「外链脚本」条目。
 * **不用** `java.toast` 那条通道（那是给源脚本用的）。
 *
 * ## 目录约定（用户手动放文件的地方）
 * `data/jslib-mirror/qyyuapi.com/dy/js/Movieffm/loginUrl.js`
 * `data/jslib-mirror/qyyuapi.com/dy/js/Movieffm/sortUrl.js`
 * `data/jslib-mirror/qyyuapi.com/dy/js/Movieffm/jsLib.js`
 * `data/jslib-mirror/qyyuapi.com/js/common.js`
 * 对应 URL 的 host + pathname 原样落盘（query 追加 `.__q<sha8>` 区分）。
 *
 * ## 校验与容错
 * · 有 `.meta.json` ⇒ 校验 `bytes + sha256`，**不一致按未命中**（回源）；无 meta（用户直接丢文件）⇒ 信任内容；
 * · 空文件按未命中（与 `#411` 「内容空即视为没取到」同语义）；
 * · 路径逐段净化（拒绝 `..` / Windows 保留名 / 非法字符），并二次校验落在镜像根内。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 旁挂元数据（写盘时生成；用户手动放的文件可以没有） */
export interface JsMirrorMeta {
  url: string;
  fetchedAt: string;
  bytes: number;
  sha256: string;
  /** network = 引擎回写；manual = 手工放置/测试 */
  source: 'network' | 'manual';
}

export interface JsMirrorHit {
  text: string;
  /** 相对镜像根的路径（`host/path…`，用于日志） */
  rel: string;
  meta: JsMirrorMeta | null;
}

/** 一条「请手动下载」提示（`/api/diag` 的 `jslibHints` 与设置页共用这一份形状） */
export interface JsMirrorHint {
  /** 失败的外链 URL */
  url: string;
  /** 用户应放置的**绝对路径**（Windows 反斜杠） */
  absPath: string;
  /** 连续失败次数 */
  fails: number;
  /** 最近一次失败原因（超时 / 非 2xx / 空响应…） */
  reason: string;
  /** 首次提示时间（ISO）；同一 URL 只提示一次 */
  notifiedAt: string;
  /** 完整中文提示（含 URL / 路径 / 一句话操作说明） */
  text: string;
}

interface JsMirrorHintEntry {
  fails: number;
  reason: string;
  /** 已提示过的时间（ISO）；存在 ⇒ 不再重复提示 */
  notifiedAt?: string;
  updatedAt: string;
}

interface JsMirrorHintState {
  version: 1;
  urls: Record<string, JsMirrorHintEntry>;
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[jslib-mirror] ${msg}`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * 内容是不是 **HTML/XML 文档**（而不是脚本原文）。
 *
 * 存在的理由：外链脚本（jsLib / exploreUrl）撞 WAF 时会走浏览器重放，而浏览器打开 `.js`
 * 只会渲染出「文本阅读器」文档；若把这层 DOM 当脚本正文，既会 `Unexpected token '<'`，
 * 还会被回写进镜像/持久层，让后续每次启动都复用污染内容（MYCOMIC / Komiic / 热辣漫画
 * 三源实测）。读写两侧都要拒收，旧版本已落盘的污染因此按「未命中」回源。
 * 注意：`<!--` 是合法的 JS 单行注释，不能仅凭 `<` 开头就判 HTML。
 */
export function isMarkupDocumentBody(text: unknown): boolean {
  const t = String(text ?? '').trimStart().slice(0, 200).toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html') || t.startsWith('<?xml');
}

/**
 * 是否浏览器「文本阅读器」包装页（Chromium 打开 `.js` / `.json` 时自动生成）：
 * `<html><head><meta name="color-scheme" …></head><body><pre style="word-wrap: break-word; …">原文</pre></body></html>`
 */
export function isRenderedTextDocument(text: unknown): boolean {
  const head = String(text ?? '').slice(0, 1200).toLowerCase();
  if (!head.includes('<html')) return false;
  return head.includes('name="color-scheme"') || head.includes('word-wrap: break-word');
}

/** 镜像是否开启（默认开；`YUEDU_JSLIB_MIRROR=0/false/off/no` 关闭） */
export function jsMirrorEnabled(): boolean {
  const v = String(process.env['YUEDU_JSLIB_MIRROR'] ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disable', 'disabled'].includes(v);
}

/** 镜像根目录（`YUEDU_JSLIB_MIRROR_DIR` 覆盖；默认 `<YUEDU_DATA_DIR 或 data>/jslib-mirror`） */
export function jsMirrorRoot(): string {
  const dir =
    process.env['YUEDU_JSLIB_MIRROR_DIR'] ||
    path.join(process.env['YUEDU_DATA_DIR'] || 'data', 'jslib-mirror');
  return path.resolve(dir);
}

/** 单段路径净化（decodeURIComponent 失败保持原文；Windows 保留名加前缀） */
function safeSegment(raw: string): string {
  let s = raw;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 非法 % 序列：按原文 */
  }
  s = s.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[\\/]/g, '_');
  if (!s || s === '.' || s === '..') s = '_';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s)) s = `_${s}`;
  return s;
}

/**
 * URL → 镜像相对路径（`<host>/<path…>`）。非 http(s) / 解析失败 ⇒ null。
 * query 追加 `.__q<sha8>` 到文件名，避免同一路径不同查询串互相覆盖。
 */
export function jsMirrorRelPath(url: string): string | null {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = safeSegment(u.host.toLowerCase());
  const segs = u.pathname.split('/').filter(Boolean).map(safeSegment);
  if (!segs.length) segs.push('index.js');
  if (u.search) {
    const h = createHash('sha256').update(u.search, 'utf-8').digest('hex').slice(0, 8);
    segs[segs.length - 1] = `${segs[segs.length - 1]}.__q${h}`;
  }
  return `${host}/${segs.join('/')}`;
}

/** 相对路径 → 绝对路径；越界（`..` 等）⇒ null */
function absPathOf(rel: string): string | null {
  const root = jsMirrorRoot();
  const abs = path.resolve(root, ...rel.split('/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * 读镜像。未命中 / 关闭 / 内容损坏 ⇒ null（调用方据此走「无该库」）。
 * `opts.quiet` 用于 HEAD 探测等重复读，避免刷屏；
 * `opts.reason` 是**兜底读**的失败原因（超时 / 非 2xx / 空响应…），带它时日志改为
 * 「镜像兜底命中（原因：…）」—— 网络优先后，镜像命中只可能发生在兜底路径。
 */
export function readJsMirror(url: string, opts: { quiet?: boolean; reason?: string } = {}): JsMirrorHit | null {
  if (!jsMirrorEnabled()) return null;
  const rel = jsMirrorRelPath(url);
  if (!rel) return null;
  const abs = absPathOf(rel);
  if (!abs) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  const text = buf.toString('utf-8');
  if (!text.trim()) return null;
  if (isMarkupDocumentBody(text)) {
    warnOnce(
      `markup:${rel}`,
      `镜像内容是 HTML 文档而不是脚本原文（疑似浏览器文本阅读器污染），按未命中回源：${rel}`,
    );
    return null;
  }
  const metaPath = `${abs}.meta.json`;
  let meta: JsMirrorMeta | null = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as JsMirrorMeta;
  } catch {
    /* 无 meta（用户手工放文件）⇒ 信任内容 */
  }
  if (meta) {
    const bytes = Buffer.byteLength(text, 'utf-8');
    const digest = sha256(text);
    if (Number(meta.bytes) !== bytes || String(meta.sha256) !== digest) {
      warnOnce(
        `corrupt:${rel}`,
        `镜像与 .meta.json 不一致（bytes ${Number(meta.bytes)}≠${bytes} 或 sha256 不符），按未命中回源：${rel}`,
      );
      return null;
    }
  }
  if (!opts.quiet) {
    if (opts.reason) console.log(`[jslib-mirror] 镜像兜底命中（原因：${opts.reason}）：${rel} ← ${url}`);
    else console.log(`[jslib-mirror] 命中本地镜像：${rel} ← ${url}`);
  }
  return { text, rel, meta };
}

/**
 * 回写镜像（**网络成功**时调用；也可手工导入）。空内容不写（避免把一次失败固化成永久空）。
 * 成功回写意味着「这个 URL 的网络最近一次是通的」⇒ 顺手清零连续失败计数（提示不重复打扰）。
 * @returns 写入的相对路径；未开启 / 非 http(s) / 写失败 ⇒ null
 */
export function writeJsMirror(
  url: string,
  text: string,
  source: 'network' | 'manual' = 'network',
): string | null {
  if (!jsMirrorEnabled()) return null;
  /**
   * 统一转成**原始字符串**再落盘：求值期回调进来的可能是沙箱侧的 `String` 包装对象，
   * `fs.writeFileSync` 只接受原始字符串/Buffer（否则 `The "data" argument must be …`）。
   */
  const body = String(text ?? '');
  if (!body.trim()) return null;
  if (isMarkupDocumentBody(body)) {
    warnOnce(`markup-write:${String(url)}`, `网络结果是 HTML 文档而不是脚本原文，拒绝回写镜像：${String(url)}`);
    return null;
  }
  const rel = jsMirrorRelPath(url);
  if (!rel) return null;
  const abs = absPathOf(rel);
  if (!abs) return null;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
    const meta: JsMirrorMeta = {
      url: String(url),
      fetchedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(body, 'utf-8'),
      sha256: sha256(body),
      source,
    };
    fs.writeFileSync(`${abs}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
    console.log(`[jslib-mirror] 已回写镜像（${source}）：${rel} ← ${url}`);
    noteJsMirrorSuccess(url);
    return rel;
  } catch (e) {
    warnOnce(`write:${rel}`, `回写镜像失败（不影响本次结果）：${rel} · ${(e as Error)?.message ?? e}`);
    return null;
  }
}

/**
 * 镜像内容的 etag（给 `java.head` 的 etag 探测用）。
 * 命中 ⇒ 用内容 sha256 当 etag（用户换镜像文件 ⇒ etag 变 ⇒ 源侧 `Reload` 会重取）。
 */
export function jsMirrorEtag(url: string): string | null {
  const hit = readJsMirror(url, { quiet: true });
  if (!hit) return null;
  return hit.meta?.sha256 || sha256(hit.text);
}

/* ============================================================================
 * 「请手动下载」提示（连续失败到阈值 ⇒ 一次；跨进程持久化，防刷屏）
 * ========================================================================== */

/** 提示阈值（默认 3 次；`YUEDU_JSLIB_MIRROR_HINT_AFTER` 可调，最小 1） */
export function jsMirrorHintThreshold(): number {
  const n = Number(process.env['YUEDU_JSLIB_MIRROR_HINT_AFTER']);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

/** URL → 应放置的**绝对路径**（Windows 反斜杠）；非 http(s) ⇒ null */
export function jsMirrorAbsPath(url: string): string | null {
  const rel = jsMirrorRelPath(url);
  if (!rel) return null;
  return absPathOf(rel);
}

function hintsFile(): string {
  return path.join(jsMirrorRoot(), '.hints.json');
}

function loadHints(): JsMirrorHintState {
  try {
    const raw = JSON.parse(fs.readFileSync(hintsFile(), 'utf-8')) as JsMirrorHintState;
    if (raw && raw.version === 1 && raw.urls && typeof raw.urls === 'object') return raw;
  } catch {
    /* 首次 / 损坏 ⇒ 空表 */
  }
  return { version: 1, urls: {} };
}

function saveHints(state: JsMirrorHintState): void {
  try {
    fs.mkdirSync(jsMirrorRoot(), { recursive: true });
    fs.writeFileSync(hintsFile(), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (e) {
    warnOnce('hints-write', `写提示记录失败（不影响取数）：${(e as Error)?.message ?? e}`);
  }
}

/** 提示文案（三要素：URL / 应放路径 / 一句话操作说明） */
function hintText(url: string, fails: number, reason: string, absPath: string): string {
  return (
    `外链脚本连续 ${fails} 次下载失败（最近一次：${reason}）。\n` +
    `请用浏览器下载 ${url} ，保存到：${absPath}\n` +
    `浏览器下载后按此路径保存，重启服务生效。`
  );
}

/**
 * 记一次**网络失败**（同一 URL 连续失败计数）。
 *
 * @returns 达到阈值且**首次**提示时返回提示载荷；其余情况 null（同 URL 只提示一次）。
 *          `YUEDU_JSLIB_MIRROR=0` 时完全不记账（镜像已关，提示无处可放也没有意义）。
 */
export function noteJsMirrorFailure(url: string, reason: string): JsMirrorHint | null {
  if (!jsMirrorEnabled()) return null;
  const absPath = jsMirrorAbsPath(url);
  if (!absPath) return null;
  const key = String(url);
  const state = loadHints();
  const prev = state.urls[key];
  const entry: JsMirrorHintEntry = {
    fails: (prev?.fails ?? 0) + 1,
    reason: String(reason || '未知原因'),
    notifiedAt: prev?.notifiedAt,
    updatedAt: new Date().toISOString(),
  };
  let hint: JsMirrorHint | null = null;
  if (entry.fails >= jsMirrorHintThreshold() && !entry.notifiedAt) {
    entry.notifiedAt = new Date().toISOString();
    hint = {
      url: key,
      absPath,
      fails: entry.fails,
      reason: entry.reason,
      notifiedAt: entry.notifiedAt,
      text: hintText(key, entry.fails, entry.reason, absPath),
    };
    // 服务端日志也要有（设置页读的是同一份 `.hints.json`）
    console.warn(`[jslib-mirror] ${hint.text}`);
  }
  state.urls[key] = entry;
  saveHints(state);
  return hint;
}

/** 网络成功（或手工回写镜像）⇒ 清零连续失败计数（已提示过的 `notifiedAt` 保留，不重复弹）。 */
export function noteJsMirrorSuccess(url: string): void {
  if (!jsMirrorEnabled()) return;
  const key = String(url);
  const state = loadHints();
  const entry = state.urls[key];
  if (!entry || entry.fails === 0) return;
  entry.fails = 0;
  entry.updatedAt = new Date().toISOString();
  state.urls[key] = entry;
  saveHints(state);
}

/** 已提示过的条目（`/api/diag` 的 `jslibHints`；设置页原样展示） */
export function listJsMirrorHints(): JsMirrorHint[] {
  if (!jsMirrorEnabled()) return [];
  const state = loadHints();
  return Object.entries(state.urls)
    .filter(([, e]) => Boolean(e.notifiedAt))
    .map(([url, e]) => {
      const absPath = jsMirrorAbsPath(url) ?? '';
      return {
        url,
        absPath,
        fails: e.fails,
        reason: e.reason,
        notifiedAt: String(e.notifiedAt),
        text: hintText(url, e.fails, e.reason, absPath),
      };
    })
    .sort((a, b) => a.notifiedAt.localeCompare(b.notifiedAt));
}

/** 测试专用：清空提示记录（含已提示标记） */
export function __resetJsMirrorHintsForTest(): void {
  try {
    fs.rmSync(hintsFile(), { force: true });
  } catch {
    /* 不存在就算了 */
  }
}

/** 测试专用：清空 warnOnce 去重表 */
export function __resetJsMirrorWarningsForTest(): void {
  warned.clear();
}
