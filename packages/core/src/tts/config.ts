/**
 * `#820` TTS 引擎配置的**归一与校验**（唯一实现：store / 路由 / 单测都调这里）。
 *
 * 纪律：
 *  · **不做「猜测式修复」** —— 配置错就返回明确的 `TtsConfigError`，让界面能指出哪一项错；
 *    静默补默认值会把「用户配错了」变成「朗读没声音」，两者排查成本差一个数量级。
 *  · **不内置任何引擎** —— 发布包不提供任何源/引擎规则（产品定位），这里只认用户写入的配置。
 */
import type {
  TtsConfigError, TtsConfigFile, TtsEngineConfig, TtsValidation, TtsVoiceSlot, TtsVoiceSlotConfig,
} from './types';
import { EMPTY_TTS_CONFIG, TTS_LIMITS } from './types';

/** 合法的音频类型（配置里的 `contentType` 只能是这些；其余按配错处理） */
const AUDIO_CT_RE = /^audio\/[a-z0-9][a-z0-9.+_-]*$/i;
const BINARY_CT = new Set(['application/octet-stream', 'binary/octet-stream']);

/** 该类型是否被允许作为「音频回传类型」 */
export function isTtsAudioContentType(ct: string): boolean {
  const t = String(ct ?? '').trim().toLowerCase();
  return AUDIO_CT_RE.test(t);
}

function isAllowedConfiguredContentType(ct: string): boolean {
  const t = ct.trim().toLowerCase();
  return isTtsAudioContentType(t) || BINARY_CT.has(t);
}

function fail(error: TtsConfigError, message: string): TtsValidation {
  return { ok: false, error, message };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function trimOrUndefined(v: unknown, max: number): string | undefined {
  const s = asString(v).trim();
  if (!s) return undefined;
  return s.slice(0, max);
}

/** FNV-1a 32 位（稳定 id 用；不是安全哈希，也不需要） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h >>> 0) * 0x01000193;
  }
  return (h >>> 0).toString(36);
}

/** 由 `name + url` 推出稳定 id（同配置重复导入不会产生两条） */
export function deriveTtsEngineId(name: string, url: string): string {
  return `tts-${fnv1a(`${name}\n${url}`)}`;
}

/**
 * `@js:` 形态判定（Legado `AnalyzeUrl.analyzeJs` 的两种标记：`@js:` 与 `<js>…</js>`）。
 * UI 用它决定「默认折叠」—— 本仓不主动展开脚本配置。
 */
export function isTtsJsRule(raw: string): boolean {
  return /<js>[\w\S]*?<\/js>|@js:/i.test(String(raw ?? ''));
}

/** 是否含 `{{}}` 插值（UI 决定是否显示「模板」标记；也用于 URL 静态校验放宽） */
export function hasTtsTemplate(raw: string): boolean {
  const s = String(raw ?? '');
  return s.includes('{{') && s.includes('}}');
}

/**
 * Legado `header` 原始串 → 头对象。
 * 两种形态都收（上游两种都存在）：JSON 对象，或「Key: Value」逐行（`#` 开头为注释）。
 * 解析不出时就返回已识别到的条目 —— 调用方（`normalizeTtsEngine`）据此判 `HEADER_INVALID`。
 */
export function parseTtsHeader(raw: unknown): Record<string, string> {
  const text = asString(raw).trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as unknown;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v == null) continue;
        out[k.trim()] = String(v);
      }
      return out;
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf(':');
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** 头对象校验：条数/单值长度；键与值必须是字符串 */
function normalizeHeaders(raw: unknown): Record<string, string> | null {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > TTS_LIMITS.headers) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = k.trim();
    if (!key || /\s/.test(key)) return null;
    if (v == null) continue;
    out[key] = String(v).slice(0, TTS_LIMITS.headerValue);
  }
  return out;
}

/**
 * Legado `concurrentRate` → **两次请求的最小间隔（毫秒）**。
 *
 * 上游写法两种都收：`1/1500`（每 1.5s 最多 1 次）与纯毫秒 `1500`；`0` / 空 = 不限。
 * 返回 `null` 表示格式非法（配置校验据此报 `CONCURRENT_RATE_INVALID`，不静默忽略）。
 */
export function parseTtsConcurrentRate(raw: unknown): number | null {
  const s = asString(raw).trim();
  if (!s) return 0;
  const m = /^([0-9]{1,3})\s*\/\s*([0-9]{1,5})$/.exec(s);
  if (m) {
    const count = Number(m[1]);
    const windowMs = Number(m[2]);
    if (count === 0) return 0;
    return Math.round(windowMs / Math.max(count, 1));
  }
  if (/^[0-9]{1,5}$/.test(s)) return Number(s);
  return null;
}

/** `url` 静态形态校验（模板/脚本形态只要求「不是纯相对路径」，运行时再严判） */
function urlShapeOk(url: string): boolean {
  if (isTtsJsRule(url) || hasTtsTemplate(url)) {
    // 允许 `https://…{{x}}` / `@js:…` / `<js>…</js>`；纯相对路径（`/tts?…`）没有 base 可依附
    return /^(?:https?:\/\/|@js:|<js>|.*@js:)/i.test(url) || url.startsWith('{{');
  }
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 副槽校验结果（`null` = 没配置副槽） */
export type TtsVoiceSlotValidation =
  | { ok: true; slot: TtsVoiceSlotConfig | null }
  | { ok: false; error: TtsConfigError; message: string };

/** 会影响请求/音色的副槽字段（只有 `name`/`remark` 不算「配了副音色」） */
const VOICE2_REQUEST_FIELDS = [
  'url', 'contentType', 'method', 'body', 'headers', 'header', 'jsLib', 'timeoutMs',
] as const;

/**
 * 副音色槽归一 + 校验（字段与主槽同名同义）。
 *
 * ★ `url` 对副槽是**可选**：留空表示「沿用主槽地址、只改其它参数」。
 * ★ 只填 `name`/`remark` 的副槽视为**没配置**（返回 null），避免界面显示一个发音相同的假副槽。
 */
export function normalizeTtsVoiceSlot(input: unknown): TtsVoiceSlotValidation {
  if (input == null) return { ok: true, slot: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'VOICE2_INVALID', message: '副音色配置必须是对象' };
  }
  const it = input as TtsVoiceSlotConfig;

  const name = asString(it.name).trim();
  if (name.length > TTS_LIMITS.name) {
    return { ok: false, error: 'VOICE2_NAME_TOO_LONG', message: `副音色名称超过 ${TTS_LIMITS.name} 字` };
  }

  const url = asString(it.url).trim();
  if (url.length > TTS_LIMITS.url) {
    return { ok: false, error: 'VOICE2_URL_TOO_LONG', message: `副音色地址超过 ${TTS_LIMITS.url} 字` };
  }
  if (url && !urlShapeOk(url)) {
    return { ok: false, error: 'VOICE2_URL_INVALID', message: '副音色地址必须是 http(s) 绝对地址（或 @js: / {{}} 模板）' };
  }

  const contentTypeRaw = asString(it.contentType).trim();
  if (contentTypeRaw && !isAllowedConfiguredContentType(contentTypeRaw)) {
    return { ok: false, error: 'VOICE2_CONTENT_TYPE_INVALID', message: `副音色 contentType「${contentTypeRaw}」不是音频类型` };
  }

  const methodRaw = asString(it.method).trim().toUpperCase();
  if (methodRaw && methodRaw !== 'GET' && methodRaw !== 'POST') {
    return { ok: false, error: 'VOICE2_METHOD_INVALID', message: '副音色 method 只能是 GET 或 POST' };
  }

  const body = asString(it.body);
  if (body.length > TTS_LIMITS.body) {
    return { ok: false, error: 'VOICE2_BODY_TOO_LONG', message: `副音色 body 超过 ${TTS_LIMITS.body} 字` };
  }

  const jsLib = asString(it.jsLib);
  if (jsLib.length > TTS_LIMITS.jsLib) {
    return { ok: false, error: 'VOICE2_JS_LIB_TOO_LONG', message: `副音色 jsLib 超过 ${TTS_LIMITS.jsLib} 字` };
  }

  const headers = normalizeHeaders(it.headers);
  if (headers == null) {
    return { ok: false, error: 'VOICE2_HEADER_INVALID', message: `副音色 headers 必须是对象，且不超过 ${TTS_LIMITS.headers} 条` };
  }
  const headerRaw = asString(it.header).trim();
  if (headerRaw.length > TTS_LIMITS.headerRaw) {
    return { ok: false, error: 'VOICE2_HEADER_TOO_LARGE', message: `副音色 header 超过 ${TTS_LIMITS.headerRaw} 字` };
  }
  if (headerRaw && Object.keys(parseTtsHeader(headerRaw)).length === 0) {
    return { ok: false, error: 'VOICE2_HEADER_INVALID', message: '副音色 header 既不是 JSON 对象，也没有一行「Key: Value」' };
  }

  let timeoutMs: number | undefined;
  if (it.timeoutMs != null) {
    const n = Number(it.timeoutMs);
    if (!Number.isFinite(n) || n < TTS_LIMITS.timeoutMin || n > TTS_LIMITS.timeoutMax) {
      return { ok: false, error: 'VOICE2_TIMEOUT_INVALID', message: `副音色 timeoutMs 必须在 ${TTS_LIMITS.timeoutMin}~${TTS_LIMITS.timeoutMax} 之间` };
    }
    timeoutMs = Math.round(n);
  }

  const slot: TtsVoiceSlotConfig = {
    ...(name ? { name } : {}),
    ...(trimOrUndefined(url, TTS_LIMITS.url) ? { url } : {}),
    ...(contentTypeRaw ? { contentType: contentTypeRaw } : {}),
    ...(methodRaw ? { method: methodRaw as 'GET' | 'POST' } : {}),
    ...(body ? { body } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(headerRaw ? { header: headerRaw } : {}),
    ...(jsLib ? { jsLib } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(trimOrUndefined(it.remark, 200) ? { remark: trimOrUndefined(it.remark, 200) } : {}),
  };
  const configured = VOICE2_REQUEST_FIELDS.some((k) => {
    const v = (slot as Record<string, unknown>)[k];
    if (k === 'headers') return !!v && typeof v === 'object' && Object.keys(v as object).length > 0;
    return v != null && v !== '';
  });
  return { ok: true, slot: configured ? slot : null };
}

/** 引擎是否**真的配了**副音色（供回退判定与 UI 标记） */
export function hasTtsSecondaryVoice(engine: TtsEngineConfig | null | undefined): boolean {
  const s = engine?.secondary;
  if (!s) return false;
  return VOICE2_REQUEST_FIELDS.some((k) => {
    const v = (s as Record<string, unknown>)[k];
    if (k === 'headers') return !!v && typeof v === 'object' && Object.keys(v as object).length > 0;
    return v != null && v !== '';
  });
}

/**
 * 按全局配置选音色槽（`#821` 的唯一选槽入口：store/service/UI 都调这里）。
 *
 * 回退规则（用户拍板）：**副槽没配** ⇒ 走副槽时自动用主槽，`fellBack=true`。
 * 单音色（`dualVoice=false`）永远返回主槽，且请求对象与原来**逐字节一致**（回归锁）。
 */
export function resolveTtsVoice(
  engine: TtsEngineConfig,
  cfg: Pick<TtsConfigFile, 'dualVoice' | 'activeVoice'>,
): { engine: TtsEngineConfig; slot: TtsVoiceSlot; fellBack: boolean } {
  if (!cfg.dualVoice || cfg.activeVoice !== 'secondary') {
    return { engine, slot: 'primary', fellBack: false };
  }
  if (!hasTtsSecondaryVoice(engine)) {
    return { engine, slot: 'primary', fellBack: true };
  }
  const { secondary, ...base } = engine;
  return {
    engine: {
      ...base,
      ...secondary,
      // id/name/enabled 是「引擎级」字段，不能被槽位覆盖（否则界面与默认引擎会对不上）
      id: engine.id,
      name: engine.name,
      enabled: engine.enabled,
    },
    slot: 'secondary',
    fellBack: false,
  };
}

/**
 * 单条引擎配置归一 + 校验。
 *
 * `existing` 仅用于「更新时保留 id」——更新接口允许只改一部分字段，但 id 不能漂。
 */
export function normalizeTtsEngine(input: unknown, existing?: TtsEngineConfig | null): TtsValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('NAME_REQUIRED', '配置必须是对象');
  }
  const it = input as Partial<TtsEngineConfig>;
  const name = asString(it.name).trim();
  if (!name) return fail('NAME_REQUIRED', '缺少引擎名');
  if (name.length > TTS_LIMITS.name) return fail('NAME_TOO_LONG', `引擎名超过 ${TTS_LIMITS.name} 字`);

  const url = asString(it.url).trim();
  if (!url) return fail('URL_REQUIRED', '缺少请求地址');
  if (url.length > TTS_LIMITS.url) return fail('URL_TOO_LONG', `请求地址超过 ${TTS_LIMITS.url} 字`);
  if (!urlShapeOk(url)) return fail('URL_INVALID', '请求地址必须是 http(s) 绝对地址（或 @js: / {{}} 模板）');

  const contentTypeRaw = asString(it.contentType).trim();
  if (contentTypeRaw && !isAllowedConfiguredContentType(contentTypeRaw)) {
    return fail('CONTENT_TYPE_INVALID', `contentType「${contentTypeRaw}」不是音频类型`);
  }

  const methodRaw = asString(it.method).trim().toUpperCase();
  if (methodRaw && methodRaw !== 'GET' && methodRaw !== 'POST') {
    return fail('METHOD_INVALID', 'method 只能是 GET 或 POST');
  }

  const body = asString(it.body);
  if (body.length > TTS_LIMITS.body) return fail('BODY_TOO_LONG', `body 超过 ${TTS_LIMITS.body} 字`);

  const jsLib = asString(it.jsLib);
  if (jsLib.length > TTS_LIMITS.jsLib) return fail('JS_LIB_TOO_LONG', `jsLib 超过 ${TTS_LIMITS.jsLib} 字`);

  const headers = normalizeHeaders(it.headers);
  if (headers == null) {
    return fail('HEADER_INVALID', `headers 必须是对象，且不超过 ${TTS_LIMITS.headers} 条`);
  }
  const headerRaw = asString(it.header).trim();
  if (headerRaw.length > TTS_LIMITS.headerRaw) {
    return fail('HEADER_TOO_LARGE', `header 超过 ${TTS_LIMITS.headerRaw} 字`);
  }
  if (headerRaw && Object.keys(parseTtsHeader(headerRaw)).length === 0) {
    return fail('HEADER_INVALID', 'header 既不是 JSON 对象，也没有一行「Key: Value」');
  }

  let timeoutMs: number | undefined;
  if (it.timeoutMs != null) {
    const n = Number(it.timeoutMs);
    if (!Number.isFinite(n) || n < TTS_LIMITS.timeoutMin || n > TTS_LIMITS.timeoutMax) {
      return fail('TIMEOUT_INVALID', `timeoutMs 必须在 ${TTS_LIMITS.timeoutMin}~${TTS_LIMITS.timeoutMax} 之间`);
    }
    timeoutMs = Math.round(n);
  }

  // `#873` 对齐上游 HttpTTS：pauseDuration / loginUi / loginCheckJs / concurrentRate
  let pauseDuration: number | undefined;
  if (it.pauseDuration != null) {
    const n = Number(it.pauseDuration);
    if (!Number.isFinite(n) || n < 0 || n > TTS_LIMITS.pauseMax) {
      return fail('PAUSE_INVALID', `pauseDuration 必须在 0~${TTS_LIMITS.pauseMax} 毫秒之间`);
    }
    pauseDuration = Math.round(n);
  }

  const loginUi = asString(it.loginUi).trim();
  if (loginUi) {
    if (loginUi.length > TTS_LIMITS.loginUi) {
      return fail('LOGIN_UI_TOO_LARGE', `loginUi 超过 ${TTS_LIMITS.loginUi} 字`);
    }
    try {
      JSON.parse(loginUi);
    } catch {
      return fail('LOGIN_UI_INVALID', 'loginUi 必须是合法 JSON（上游登录表单定义）');
    }
  }

  const loginCheckJs = asString(it.loginCheckJs);
  if (loginCheckJs.length > TTS_LIMITS.loginCheckJs) {
    return fail('LOGIN_CHECK_JS_TOO_LARGE', `loginCheckJs 超过 ${TTS_LIMITS.loginCheckJs} 字`);
  }

  const concurrentRate = asString(it.concurrentRate).trim();
  if (concurrentRate && parseTtsConcurrentRate(concurrentRate) == null) {
    return fail('CONCURRENT_RATE_INVALID', 'concurrentRate 只能是「1/1500」或毫秒数（0 = 不限）');
  }

  const idRaw = asString(it.id).trim();
  if (idRaw && !/^[A-Za-z0-9_-]{1,64}$/.test(idRaw)) {
    return fail('ID_INVALID', 'id 只能包含字母/数字/下划线/连字符，最长 64');
  }

  // `#821` 副音色槽：校验失败直接带槽位前缀的错误码，不静默丢配置
  const voice2 = normalizeTtsVoiceSlot(it.secondary);
  if (!voice2.ok) return fail(voice2.error, voice2.message);

  const engine: TtsEngineConfig = {
    // 更新时以 existing.id 为准：允许调用方不带 id 只改内容
    id: existing?.id || idRaw || deriveTtsEngineId(name, url),
    name,
    // **默认关**：只有显式 true 才算启用
    enabled: it.enabled === true,
    url,
    ...(contentTypeRaw ? { contentType: contentTypeRaw } : {}),
    ...(methodRaw ? { method: methodRaw as 'GET' | 'POST' } : {}),
    ...(body ? { body } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(headerRaw ? { header: headerRaw } : {}),
    ...(jsLib ? { jsLib } : {}),
    ...(trimOrUndefined(it.loginUrl, 4096) ? { loginUrl: trimOrUndefined(it.loginUrl, 4096) } : {}),
    ...(loginUi ? { loginUi } : {}),
    ...(loginCheckJs.trim() ? { loginCheckJs } : {}),
    ...(pauseDuration != null && pauseDuration > 0 ? { pauseDuration } : {}),
    ...(it.enabledCookieJar === true ? { enabledCookieJar: true } : {}),
    ...(trimOrUndefined(it.concurrentRate, 64) ? { concurrentRate: trimOrUndefined(it.concurrentRate, 64) } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(trimOrUndefined(it.remark, 200) ? { remark: trimOrUndefined(it.remark, 200) } : {}),
    ...(voice2.slot ? { secondary: voice2.slot } : {}),
    ...(typeof it.updatedAt === 'number' && Number.isFinite(it.updatedAt) ? { updatedAt: it.updatedAt } : {}),
  };
  return { ok: true, engine };
}

/**
 * 落盘文件归一：坏条目**丢弃但不报错**（与源库同样的「读时容错」纪律 ——
 * 一条手改坏的数据不该让整个 TTS 功能起不来）。
 * `enabled` 只认**严格 true**：`"true"` / `1` 一律视为关（默认关的判据不能含糊）。
 */
export function normalizeTtsConfigFile(raw: unknown): TtsConfigFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_TTS_CONFIG, engines: [] };
  const it = raw as Partial<TtsConfigFile>;
  const engines: TtsEngineConfig[] = [];
  const seen = new Set<string>();
  if (Array.isArray(it.engines)) {
    for (const e of it.engines) {
      const r = normalizeTtsEngine(e);
      if (!r.ok) continue;
      if (seen.has(r.engine.id)) continue;
      seen.add(r.engine.id);
      engines.push(r.engine);
    }
  }
  const wantDefault = asString(it.defaultEngineId).trim();
  const defaultEngineId = wantDefault && seen.has(wantDefault) ? wantDefault : '';
  return {
    enabled: it.enabled === true,
    // `#821` 双音色：只认严格 true；槽位只认 secondary，其余（含脏数据）一律回主槽
    dualVoice: it.dualVoice === true,
    activeVoice: it.activeVoice === 'secondary' ? 'secondary' : 'primary',
    defaultEngineId,
    engines,
  };
}

/**
 * 设置面（全局开关 / 默认引擎 / 双音色）的归一；各字段都可单独更新。
 * `activeVoice` 是枚举，传错值直接拒绝（不静默改成 primary，否则用户会以为切换生效了）。
 */
export function normalizeTtsSettings(
  input: unknown,
  cur: TtsConfigFile,
): { ok: true; config: TtsConfigFile } | { ok: false; error: 'DEFAULT_ENGINE_NOT_FOUND' | 'VOICE_SLOT_INVALID' } {
  const it = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Partial<TtsConfigFile>;
  const nextDefault = it.defaultEngineId === undefined
    ? cur.defaultEngineId
    : asString(it.defaultEngineId).trim();
  if (nextDefault && !cur.engines.some((e) => e.id === nextDefault)) {
    return { ok: false, error: 'DEFAULT_ENGINE_NOT_FOUND' };
  }
  let nextActive: TtsVoiceSlot = cur.activeVoice;
  if (it.activeVoice !== undefined) {
    const v = asString(it.activeVoice).trim();
    if (v !== 'primary' && v !== 'secondary') {
      return { ok: false, error: 'VOICE_SLOT_INVALID' };
    }
    nextActive = v;
  }
  return {
    ok: true,
    config: {
      enabled: it.enabled === undefined ? cur.enabled : it.enabled === true,
      dualVoice: it.dualVoice === undefined ? cur.dualVoice : it.dualVoice === true,
      activeVoice: nextActive,
      defaultEngineId: nextDefault,
      engines: cur.engines.map((e) => ({
        ...e,
        ...(e.secondary ? { secondary: { ...e.secondary } } : {}),
      })),
    },
  };
}
