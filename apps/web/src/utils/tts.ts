/**
 * `#822` **B2 HTTP TTS —— Web 侧接线层**（设置页与阅读页共用）。
 *
 * 两层职责：
 *  · `/api/tts/*` 的薄封装（URL 与方法只有这一份，设置/阅读都调这里）；
 *  · **失败码 → 人话**（用户 2026-11-06 要求：超时 / 限流 / 返回的不是音频要说清楚，
 *    不能只弹「失败」）。服务端回的是稳定 `code`，此处按 `code` 出文案，不靠 `message` 猜。
 *
 * 分段复用 `@yuedu/core/tts` 的 `segmentTtsText`（与内核同一份实现，避免第二份切分规则）。
 */
import { segmentTtsText, type TtsEngineConfig, type TtsVoiceSlot } from '@yuedu/core/tts';

/** 服务端 `/api/tts/config` 一条引擎（`jsRule` = 该引擎是否 `@js:` 形态，供 UI 默认折叠） */
export interface TtsEngineView extends TtsEngineConfig {
  jsRule?: boolean;
  /** `#821` 是否真的配了副音色（服务端按请求字段判定，name/remark 不算） */
  hasSecondary?: boolean;
}

export interface TtsConfigView {
  enabled: boolean;
  /** `#821` 双音色总开关（默认 false ⇒ 单音色行为不变） */
  dualVoice: boolean;
  /** 双音色开启时用哪个槽（副槽缺失会自动回退主槽） */
  activeVoice: TtsVoiceSlot;
  defaultEngineId: string;
  engines: TtsEngineView[];
}

/** 朗读分段（与 `read-aloud-core.ts` 的 `Sentence` 同形，便于 store 直接使用） */
export interface TtsReadSegment {
  text: string;
  start: number;
  end: number;
}

/** 只在诊断里展示的安全长度（不要把整页报错 HTML 灌进界面/日志） */
function trimDetail(detail: string): string {
  const d = String(detail ?? '').replace(/\s+/g, ' ').trim();
  return d.length > 80 ? `${d.slice(0, 80)}…` : d;
}

/**
 * 失败码 → 人能看懂的一句话。
 *
 * ★ `message` 只作为**未知码**的兜底；已知码一律用这里的中文口径 ——
 *   服务端的 `message` 有时带引擎名/HTTP 状态，适合日志，不一定适合直接怼给用户。
 */
export function describeTtsError(code: string, message = '', detail = ''): string {
  const d = String(detail ?? '').replace(/\s+/g, ' ').trim();
  switch (code) {
    case 'TTS_DISABLED':
      return '在线朗读总开关没打开（去「设置 → 朗读」打开并选一条引擎）';
    case 'TTS_ENGINE_NOT_FOUND':
      return '还没有选择朗读引擎（去「设置 → 朗读」里选一条）';
    case 'TTS_ENGINE_DISABLED':
      return '这条朗读引擎没启用（去「设置 → 朗读」里打开它）';
    case 'TTS_CONFIG_INVALID':
      return message || '引擎配置不完整，去「设置 → 朗读」检查一下';
    case 'TTS_TEXT_EMPTY':
      return '这一段没有可朗读的文字';
    case 'TTS_TEXT_TOO_LONG':
      return '这一段的文字太长了（单段上限 5000 字），请先切小一点';
    case 'TTS_JS_TIMEOUT':
      return '引擎脚本执行超时（@js: 2 秒内没跑完），检查脚本是不是死循环了';
    case 'TTS_JS_ERROR':
      return `引擎脚本出错了${d ? `：${trimDetail(d)}` : ''}`;
    case 'TTS_URL_INVALID':
      return '引擎地址无效（需要 http(s) 绝对地址，或 @js: / {{}} 模板）';
    case 'TTS_HTTP_TIMEOUT':
      return '引擎响应超时（对方没在限定时间内返回音频，换条线路/引擎再试）';
    case 'TTS_HTTP_ERROR':
      return `连不上引擎地址（网络错误）${d ? `：${trimDetail(d)}` : ''}`;
    case 'TTS_HTTP_STATUS': {
      const status = /HTTP\s+(\d{3})/i.exec(d)?.[1];
      return status ? `对方服务器返回错误（HTTP ${status}）` : '对方服务器返回了错误状态码';
    }
    case 'TTS_CONTENT_TYPE':
      if (/ratelimit|rate limit|too many|529|限流/i.test(d)) {
        return '对方限流了（请求太频繁），稍后再试或换一条引擎';
      }
      return '对方返回的不是音频（可能被限流、需要登录，或参数不对）';
    case 'TTS_EMPTY_AUDIO':
      return '对方返回了空响应，没有音频数据';
    /**
     * 内置 Edge 在线音色（`#edge`）：**免 Key，但必须联网**。
     * 文案统一带「切回系统语音」的出路 —— 用户在飞机上/断网时不该只看到一句「失败」。
     */
    case 'TTS_EDGE_OFFLINE':
      return `Edge 在线音色连不上（需要联网）${d ? `：${trimDetail(d)}` : ''}`;
    case 'TTS_EDGE_NETWORK':
      return 'Edge 在线音色合成失败（网络异常，可切回「本机系统语音」）';
    case 'TTS_EDGE_TIMEOUT':
      return 'Edge 在线音色响应超时（网络慢或被拦截，可切回「本机系统语音」）';
    case 'TTS_EDGE_VOICE_INVALID':
      return 'Edge 音色无效（重新选一个音色再试）';
    case 'TTS_EDGE_TOO_LARGE':
      return 'Edge 返回的音频过大（这一段可能太长了）';
    default:
      return message ? `${message}${d ? `（${trimDetail(d)}）` : ''}` : '朗读失败（未知原因）';
  }
}

/** 带 `code` 的失败（设置页可以直接定位错误码，阅读页用 `message` 显示人话） */
export class TtsApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string;

  constructor(code: string, message: string, status: number, detail = '') {
    super(describeTtsError(code, message, detail));
    this.name = 'TtsApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

async function parseError(r: Response): Promise<TtsApiError> {
  let code = 'TTS_HTTP_ERROR';
  let message = `HTTP ${r.status}`;
  let detail = '';
  try {
    const j = (await r.json()) as {
      error?: { code?: string; message?: string; detail?: string };
      /** Fastify 自带错误体（`FST_ERR_CTP_EMPTY_JSON_BODY` 等）：不是 TTS 的业务码 */
      statusCode?: number;
      code?: string;
      message?: string;
    };
    if (j?.error?.code) {
      code = String(j.error.code);
      message = String(j.error.message || message);
      detail = String(j.error.detail || '');
    } else if (j?.code || j?.message) {
      /**
       * ★ 不是 `/api/tts/*` 的业务错误（业务错误一定有 `error.code`）。
       * 历史 bug：DELETE 带 `content-type: application/json` 但没 body ⇒ Fastify 400，
       * 这里会落到 `TTS_HTTP_ERROR` ⇒ 文案变成「连不上引擎地址」，把请求格式错说成网络故障。
       * 统一按 HTTP 状态码报，走 `TTS_HTTP_STATUS` 的「对方服务器返回错误（HTTP n）」文案。
       */
      code = 'TTS_HTTP_STATUS';
      message = `HTTP ${r.status}`;
      detail = `HTTP ${r.status}: ${String(j.message || j.code || '')}`;
    }
  } catch {
    /* 响应不是 JSON（网关文本）：保留 HTTP 状态码即可 */
  }
  return new TtsApiError(code, message, r.status, detail);
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  /**
   * ★ 只有真的带 body 的请求才发 `content-type: application/json`。
   * Fastify 5 对「声明 JSON 但没有 body」的请求直接回 400（`FST_ERR_CTP_EMPTY_JSON_BODY`），
   * 而 DELETE/GET 本就没有 body —— 之前统一加头导致「删引擎」被误报成连不上引擎。
   */
  const hasBody = init?.body != null && init.body !== '';
  const headers = new Headers(init?.headers);
  if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const r = await fetch(url, { ...init, headers });
  if (!r.ok) throw await parseError(r);
  return (await r.json()) as T;
}

/**
 * 设置面 → 朗读后端的**变化指纹**（`#873`）。
 *
 * 只比 `engineId` 会漏掉三类必须重启的切换：换音色槽（`activeVoice`）、
 * 引擎配置被编辑（`updatedAt`/`name`）、开关状态变化。
 * 指纹相同 ⇒ 不重启动朗读（避免每次打开阅读页都从头念一遍）。
 */
export function ttsBackendSignature(
  cfg: Pick<TtsConfigView, 'enabled' | 'dualVoice' | 'activeVoice' | 'defaultEngineId'>,
  target: Pick<TtsEngineView, 'name' | 'enabled' | 'updatedAt'> | undefined,
): string {
  return [
    cfg.enabled ? '1' : '0',
    cfg.dualVoice ? '1' : '0',
    cfg.activeVoice,
    cfg.defaultEngineId,
    target?.name ?? '',
    target?.enabled ? '1' : '0',
    target?.updatedAt ?? 0,
  ].join('|');
}

/* ---------------- 设置面 ---------------- */

export const getTtsConfig = () => json<TtsConfigView>('/api/tts/config');

export const saveTtsSettings = (patch: {
  enabled?: boolean;
  defaultEngineId?: string;
  /** `#821` 双音色开关（缺省 false；关掉后行为与单音色完全一致） */
  dualVoice?: boolean;
  /** `#821` 当前音色槽（副槽缺失时服务端自动回退主槽） */
  activeVoice?: TtsVoiceSlot;
}) =>
  json<{ ok: true; config: TtsConfigView }>('/api/tts/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const saveTtsEngine = (engine: Partial<TtsEngineConfig>) =>
  json<{ ok: true; engine: TtsEngineView; jsRule?: boolean; hasSecondary?: boolean }>('/api/tts/engines', {
    method: 'PUT',
    body: JSON.stringify(engine),
  });

export const removeTtsEngine = (id: string) =>
  json<{ ok: true }>(`/api/tts/engines?id=${encodeURIComponent(id)}`, { method: 'DELETE' });

/* ---------------- 合成 / 分段 ---------------- */

export interface TtsAudioBlob {
  blob: Blob;
  contentType: string;
}

/**
 * 一段文字 → 音频字节。
 *
 * ★ 与设置面不同：这里失败也回 JSON（`{error:{code,message,detail}}`），
 *   成功才回音频字节 ⇒ 必须按 `r.ok` 分流，不能一律 `.json()`。
 */
export async function speakTts(
  input: { engineId?: string; text: string; speed?: number },
  signal?: AbortSignal,
): Promise<TtsAudioBlob> {
  const r = await fetch('/api/tts/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) throw await parseError(r);
  const blob = await r.blob();
  if (!blob.size) throw new TtsApiError('TTS_EMPTY_AUDIO', '', 502);
  return { blob, contentType: r.headers.get('content-type') || 'audio/mpeg' };
}

/**
 * 章内正文 → 朗读分段（**本地算**，不额外打 `/api/tts/segment`）。
 *
 * 为什么不在阅读页调服务端分段接口：朗读是逐段连续拉音频，分段只发生在换章那一刻；
 * 本地算能立刻开播，且与内核共用 `segmentTtsText`，不存在两套切分规则。
 * 失败（空文本/超长）回空数组，由调用方回落到客户端分句。
 */
export function segmentForReadAloud(text: string): TtsReadSegment[] {
  const r = segmentTtsText(text);
  if (!r.ok) return [];
  return r.segments.map((s) => ({ text: s.text, start: s.start, end: s.end }));
}

/* ---------------- 内置 Edge 在线音色（免 Key、需联网） ---------------- */

/**
 * 一条 Edge 神经音色（服务端 `/api/tts/edge/voices` 的原样结构）。
 *
 * ★ 与系统语音的区别：这些是**云端** neural voices，不是本机 SAPI 语音包 ⇒
 *   Electron/Chromium 的 `speechSynthesis.getVoices()` 永远拿不到它们，
 *   必须走服务端合成（音频从 `/api/tts/edge/speak` 以 MP3 回来）。
 */
export interface EdgeVoice {
  /** Edge 的短名，如 `zh-CN-XiaoxiaoNeural`（直接作为合成参数） */
  id: string;
  /** 界面显示名，服务端已拼好「晓晓 · 普通话（中国大陆）」之类的可读名 */
  name: string;
  /** BCP-47，如 `zh-CN` */
  locale: string;
  localeName: string;
  gender: string;
}

/** 默认 Edge 音色（用户切到 Edge 但还没选时用这个；中文女声里最通用的一条） */
export const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 取 Edge 完整音色表（服务端缓存 6 小时；`force` 强制刷新） */
export async function listEdgeVoices(
  force = false,
): Promise<{ cachedAt: number; voices: EdgeVoice[] }> {
  const r = await fetch(`/api/tts/edge/voices${force ? '?refresh=1' : ''}`);
  if (!r.ok) throw await parseError(r);
  const j = (await r.json()) as { cachedAt?: number; voices?: EdgeVoice[] };
  if (!Array.isArray(j.voices) || !j.voices.length) {
    throw new TtsApiError('TTS_EDGE_OFFLINE', 'Edge 音色列表格式异常', 502);
  }
  return { cachedAt: Number(j.cachedAt) || 0, voices: j.voices };
}

/**
 * 一段文字 → Edge 合成 MP3。
 *
 * 失败体是 `{error:{code,...}}`（与 `/api/tts/speak` 同形）⇒ 同样按 `r.ok` 分流。
 */
export async function speakEdgeTts(
  input: { text: string; voice: string; speed?: number },
  signal?: AbortSignal,
): Promise<Blob> {
  const r = await fetch('/api/tts/edge/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) throw await parseError(r);
  const blob = await r.blob();
  if (!blob.size) throw new TtsApiError('TTS_EMPTY_AUDIO', '', 502);
  return blob;
}

/* ---------------- Legado `HttpTTS` JSON 粘贴 ---------------- */

const STRING_FIELDS = [
  'id', 'name', 'url', 'contentType', 'method', 'body', 'header', 'jsLib',
  'loginUrl', 'loginUi', 'loginCheckJs', 'concurrentRate', 'remark',
] as const;

/** 副音色槽（`#821`）的字符串字段：与主槽同名，不含 `loginUrl`/`concurrentRate`（引擎级） */
const VOICE2_STRING_FIELDS = [
  'name', 'url', 'contentType', 'method', 'body', 'header', 'jsLib', 'remark',
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 解析用户粘贴的一条 Legado `HttpTTS` JSON。
 *
 * 宽容三种外壳（都实测过）：
 *  · 单对象 `{ "name": "...", "url": "..." }`；
 *  · 数组（Legado 导出多条）⇒ **只取第一条**，并明确告诉用户；
 *  · `{ "engines": [...] }`（本仓 `/api/tts/config` 的形态）。
 *
 * 不猜字段值、不补默认：缺 `name`/`url` 直接报错（服务端也是同样的判据）。
 */
export function parseTtsEngineJson(
  text: string,
): { ok: true; engine: Partial<TtsEngineConfig>; note: string } | { ok: false; error: string } {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '粘贴内容为空' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
  }

  let item: unknown = v;
  let note = '';
  if (Array.isArray(v)) {
    item = v[0];
    if (v.length > 1) note = `检测到 ${v.length} 条，只填入了第 1 条`;
  } else if (isObject(v) && Array.isArray(v.engines)) {
    item = (v.engines as unknown[])[0];
    const n = (v.engines as unknown[]).length;
    if (n > 1) note = `检测到 ${n} 条，只填入了第 1 条`;
  }
  if (!isObject(item)) return { ok: false, error: '没有找到引擎对象（应为一条 HttpTTS JSON）' };

  const name = String(item.name ?? '').trim();
  const url = String(item.url ?? '').trim();
  if (!name) return { ok: false, error: '缺少 name' };
  if (!url) return { ok: false, error: '缺少 url' };

  const out: Record<string, unknown> = { name, url, enabled: item.enabled === true };
  for (const key of STRING_FIELDS) {
    if (key === 'name' || key === 'url') continue;
    const val = item[key];
    if (typeof val === 'string' && val.trim()) out[key] = val;
  }
  // Legado `HttpTTS` 的 method 不是字段（GET/POST 由 url 尾选项决定）；本仓扩展字段照收
  if (isObject(item.headers)) {
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(item.headers)) {
      if (val != null) headers[k] = String(val);
    }
    if (Object.keys(headers).length) out.headers = headers;
  }
  const timeout = Number(item.timeoutMs);
  if (Number.isFinite(timeout) && timeout > 0) out.timeoutMs = Math.round(timeout);
  // `#873` 对齐上游 HttpTTS：段间静音 / Cookie 罐 / 登录表单（对象或数组都转成 JSON 串）
  const pause = Number(item.pauseDuration);
  if (Number.isFinite(pause) && pause > 0) out.pauseDuration = Math.round(pause);
  if (item.enabledCookieJar === true) out.enabledCookieJar = true;
  if (isObject(item.loginUi) || Array.isArray(item.loginUi)) {
    out.loginUi = JSON.stringify(item.loginUi);
  }

  // `#821` 副音色槽：canonical `secondary`，兼容别名 `voice2`；字段与主槽同名
  const voice2Raw = item.secondary ?? item.voice2;
  if (voice2Raw != null) {
    if (!isObject(voice2Raw)) {
      return { ok: false, error: '副音色（secondary）必须是对象' };
    }
    const slot: Record<string, unknown> = {};
    for (const key of VOICE2_STRING_FIELDS) {
      const val = voice2Raw[key];
      if (typeof val === 'string' && val.trim()) slot[key] = val;
    }
    if (isObject(voice2Raw.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, val] of Object.entries(voice2Raw.headers)) {
        if (val != null) headers[k] = String(val);
      }
      if (Object.keys(headers).length) slot.headers = headers;
    }
    const slotTimeout = Number(voice2Raw.timeoutMs);
    if (Number.isFinite(slotTimeout) && slotTimeout > 0) slot.timeoutMs = Math.round(slotTimeout);
    if (Object.keys(slot).length) out.secondary = slot;
  }
  return { ok: true, engine: out as Partial<TtsEngineConfig>, note };
}
