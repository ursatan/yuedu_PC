/**
 * `#820` **TTS 合成服务**（HTTP 引擎调用 + 失败/超时归一；不含路由/UI）。
 *
 * 一次合成的完整链路：
 * ```
 * 全局开关 → 选引擎 → 引擎开关 → core.buildTtsRequest（@js:/{{}}）
 *   → 宿主 HttpClient（超时/体积护栏）→ 音频类型判定 → Buffer
 * ```
 * 每一环失败都给**稳定的 `code` + HTTP status**（前端将来据 code 出文案，不靠字符串猜）。
 *
 * 隐私/安全边界：
 *  · 正文会**发往用户配置的第三方地址** —— 这是 HTTP TTS 的固有语义，默认关就是为了不做无意识的出站；
 *  · `@js:` 的网络访问被沙箱封死（`tts-js.ts`），真正出站只有这里的**一次** HTTP，便于审计与限流。
 */
import { Buffer } from 'node:buffer';

import {
  TTS_LIMITS,
  buildTtsRequest,
  describeNetworkError,
  parseTtsConcurrentRate,
  resolveTtsAudioType,
  resolveTtsVoice,
  sniffAudioContentType,
  type HttpClient,
  type HttpResponse,
  type TtsEngineConfig,
  type TtsErrorCode,
  type TtsVoiceSlot,
} from '@yuedu/core';

import { createTtsJsEvaluator, evalTtsJs } from './tts-js';
import { createTtsCookieJar, mergeCookieHeader, setCookieHeader } from './tts-cookies';
import type { TtsStore } from './tts-store';

export interface TtsAudioResult {
  ok: true;
  audio: Buffer;
  contentType: string;
  bytes: number;
  engineId: string;
  engineName: string;
  /** `#821` 实际用的音色槽（副槽缺失时会回退 primary） */
  voiceSlot: TtsVoiceSlot;
  /** `#821` 请求了副槽但没配 ⇒ 已回退主槽（界面可提示） */
  fellBack: boolean;
}

export interface TtsFailure {
  ok: false;
  /** HTTP 状态码（路由直接用它回包） */
  status: number;
  code: TtsErrorCode;
  message: string;
  /** 诊断用（上游状态/响应片段；**不含**请求 URL/头，避免把 Key 带进日志/界面） */
  detail?: string;
}

export type TtsSpeakOutcome = TtsAudioResult | TtsFailure;

export interface TtsSpeakInput {
  /** 省略 ⇒ 用 `defaultEngineId`（用户选中的那个） */
  engineId?: unknown;
  text: unknown;
  speed?: unknown;
}

function fail(status: number, code: TtsErrorCode, message: string, detail?: string): TtsFailure {
  return { ok: false, status, code, message, ...(detail ? { detail } : {}) };
}

function headerValue(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return '';
}

/** 响应体前 160 字（诊断用：200 返 JSON/HTML 时能看出是「站点报错」） */
function bodyPreview(body: string | ArrayBuffer | Uint8Array): string {
  try {
    const text = typeof body === 'string'
      ? body
      : new TextDecoder('utf-8').decode(new Uint8Array(body).subarray(0, 300));
    return text.replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch {
    return '';
  }
}

/** build 阶段的失败码 → HTTP status（脚本错是**配置错**，不是上游 5xx） */
const BUILD_STATUS: Partial<Record<TtsErrorCode, number>> = {
  TTS_TEXT_EMPTY: 400,
  TTS_TEXT_TOO_LONG: 413,
  TTS_JS_ERROR: 400,
  TTS_JS_TIMEOUT: 400,
  TTS_URL_INVALID: 400,
};

export interface TtsService {
  speak(input: TtsSpeakInput): Promise<TtsSpeakOutcome>;
  /** 删引擎时清理该引擎的 Cookie 罐与节奏状态（避免同 id 重新导入继承旧登录态） */
  forgetEngine(engineId: string): void;
}

/** 合成用的 HTTP 客户端（服务端注入同一个加固实例；测试可注入假实现） */
export function createTtsService(deps: { store: TtsStore; http: HttpClient; cookieFile?: string }): TtsService {
  const jar = createTtsCookieJar(deps.cookieFile);
  /** `concurrentRate` 的引擎级节奏：该引擎下一次最早可发的时刻 */
  const nextAt = new Map<string, number>();

  return {
    forgetEngine(engineId) {
      jar.clear(engineId);
      nextAt.delete(engineId);
    },

    async speak(input) {
      const cfg = deps.store.read();
      if (!cfg.enabled) {
        return fail(503, 'TTS_DISABLED', 'HTTP TTS 未开启（默认关，需在设置里显式打开）');
      }

      const wantId = String(input.engineId ?? '').trim();
      const id = wantId || cfg.defaultEngineId;
      if (!id) return fail(404, 'TTS_ENGINE_NOT_FOUND', '还没有选择朗读引擎');
      const engine: TtsEngineConfig | null = deps.store.findEngine(id);
      if (!engine) return fail(404, 'TTS_ENGINE_NOT_FOUND', `引擎不存在：${id}`);
      if (!engine.enabled) {
        return fail(503, 'TTS_ENGINE_DISABLED', `引擎「${engine.name}」未启用（需显式打开）`);
      }

      // `#821` 选槽：单音色永远主槽（请求与 `#822` 逐字节一致）；副槽缺失自动回退
      const voice = resolveTtsVoice(engine, cfg);
      const active = voice.engine;

      const text = typeof input.text === 'string' ? input.text : '';
      const timeoutMs = active.timeoutMs ?? TTS_LIMITS.timeoutDefault;

      const built = await buildTtsRequest(active, text, {
        speed: input.speed,
        evalJs: createTtsJsEvaluator({ jsLib: active.jsLib }),
      });
      if (!built.ok) {
        const status = BUILD_STATUS[built.code] ?? 400;
        return fail(status, built.code, built.message);
      }

      // `#873` Legado `concurrentRate`：同一引擎两次出站的最小间隔（`1/1500` / `1500`；0=不限）
      const rateMs = parseTtsConcurrentRate(active.concurrentRate) ?? 0;
      if (rateMs > 0) {
        const now = Date.now();
        const earliest = nextAt.get(active.id) ?? 0;
        const wait = Math.min(Math.max(0, earliest - now), 3000);
        nextAt.set(active.id, Math.max(now, earliest) + rateMs);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }

      // `#873` Legado `enabledCookieJar`：显式开启才读写，按引擎隔离
      let headers: Record<string, string> = { ...built.request.headers };
      if (active.enabledCookieJar) {
        headers = setCookieHeader(headers, mergeCookieHeader(headerValue(headers, 'cookie'), jar.header(active.id)));
      }

      const opts = {
        method: built.request.method,
        headers,
        ...(built.request.body ? { body: built.request.body } : {}),
        timeout: timeoutMs,
        responseType: 'arraybuffer' as const,
        maxBodyBytes: TTS_LIMITS.audioBytes,
        priority: 'high' as const,
      };

      // `#873` 对齐上游重试：网络/超时**重试 1 次**；HTTP 4xx/5xx 不重试（别给站点报错页加倍压力）
      let res: HttpResponse | null = null;
      let lastErr: unknown = null;
      const t0 = Date.now();
      for (let attempt = 0; attempt < 2 && !res; attempt++) {
        try {
          res = await deps.http.request(built.request.url, opts);
        } catch (e) {
          lastErr = e;
        }
      }
      if (!res) {
        const elapsed = Date.now() - t0;
        const msg = describeNetworkError(lastErr, timeoutMs);
        const timeoutLike = /aborted|abort|超时|timeout/i.test(`${msg} ${(lastErr as Error)?.name ?? ''}`)
          || elapsed >= timeoutMs * 0.95;
        return timeoutLike
          ? fail(504, 'TTS_HTTP_TIMEOUT', `引擎请求超时（>${timeoutMs}ms）`, msg)
          : fail(502, 'TTS_HTTP_ERROR', '引擎请求失败', msg);
      }

      // 成败都回收登录态（有些引擎会在 401/403 上下发会话 Cookie）
      if (active.enabledCookieJar) jar.absorb(active.id, headerValue(res.headers, 'set-cookie'));

      if (res.status < 200 || res.status >= 300) {
        const preview = bodyPreview(res.body);
        return fail(
          502,
          'TTS_HTTP_STATUS',
          `引擎返回 HTTP ${res.status}`,
          preview ? `HTTP ${res.status}: ${preview}` : `HTTP ${res.status}`,
        );
      }

      const bytes = typeof res.body === 'string' ? null : new Uint8Array(res.body);
      const size = bytes ? bytes.byteLength : 0;
      if (!bytes || size === 0) {
        return fail(502, 'TTS_EMPTY_AUDIO', '引擎返回了空响应体');
      }

      /**
       * `#873` Legado `loginCheckJs`：响应后自检。
       *
       * 上游语义：拿响应对象回一个 Response（可触发重新登录/换响应）。
       * 本仓沙箱**不能发网络、不能造 Response**，所以收窄成可验证的两条：
       *  · 返回非空字符串 ⇒ 视为不合格，该串作为失败原因（识别「请先登录」页）；
       *  · 返回 `{code>=400}` 的 JSON 串 ⇒ 按 HTTP 码判失败。
       * 返回空 ⇒ 通过。
       */
      const checkJs = (active.loginCheckJs ?? '').trim();
      if (checkJs) {
        const text = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096));
        const chk = evalTtsJs(
          checkJs,
          {
            url: built.request.url,
            result: '',
            response: { code: res.status, status: res.status, headers: res.headers, body: text },
          },
          { jsLib: active.jsLib },
        );
        if (!chk.ok) {
          const code: TtsErrorCode = chk.code === 'TTS_JS_TIMEOUT' ? 'TTS_JS_TIMEOUT' : 'TTS_JS_ERROR';
          return fail(400, code, 'loginCheckJs 执行失败', chk.message);
        }
        const v = chk.value.trim();
        if (v && v !== 'null' && v !== 'undefined') {
          let parsed: { code?: unknown; status?: unknown } | null = null;
          try {
            parsed = JSON.parse(v) as { code?: unknown; status?: unknown };
          } catch {
            /* 纯文本返回值：直接当原因 */
          }
          if (parsed && typeof parsed === 'object') {
            const declared = Number(parsed.code ?? parsed.status ?? 0);
            // 上游语义：脚本回 2xx 的 Response ⇒ 通过；回 >=400 ⇒ 失败
            if (Number.isFinite(declared) && declared >= 400) {
              return fail(502, 'TTS_LOGIN_CHECK', `引擎响应未通过校验（HTTP ${declared}）`);
            }
          } else {
            return fail(502, 'TTS_LOGIN_CHECK', `引擎响应未通过校验：${v.slice(0, 120)}`);
          }
        }
      }

      // 上游明确是 text/json/html 且字节也没有音频特征 ⇒ 大概率是站点报错页，别把错误页当音频播
      const upstreamCT = headerValue(res.headers, 'content-type').split(';')[0]!.trim().toLowerCase();
      const sniffed = sniffAudioContentType(bytes);
      const upstreamLooksBinary = !upstreamCT
        || /^audio\//.test(upstreamCT)
        || upstreamCT === 'application/octet-stream'
        || upstreamCT === 'binary/octet-stream';
      if (!sniffed && !upstreamLooksBinary) {
        const preview = bodyPreview(bytes);
        return fail(
          502,
          'TTS_CONTENT_TYPE',
          `引擎返回的不是音频（content-type: ${upstreamCT}）`,
          preview ? `${upstreamCT}: ${preview}` : upstreamCT,
        );
      }

      const resolved = resolveTtsAudioType({
        bytes,
        upstream: upstreamCT,
        configured: active.contentType,
      });
      return {
        ok: true,
        audio: Buffer.from(bytes),
        contentType: resolved.contentType,
        bytes: size,
        engineId: engine.id,
        engineName: engine.name,
        voiceSlot: voice.slot,
        fellBack: voice.fellBack,
      };
    },
  };
}
