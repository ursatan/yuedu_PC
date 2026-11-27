/**
 * `#820` **引擎配置 → 一次真实 HTTP 请求**（`@js:` 求值 + `{{}}` 插值 + `,{…}` 尾选项）。
 *
 * 顺序对齐 Legado（`AnalyzeUrl.kt`）：`analyzeJs`（`@js:` / `<js>`）**先**跑，然后才做
 * `{{}}` 插值（`replaceKeyPageJs`）。`{{}}` 里可用的绑定就是上游那组
 * `speakText / speakSpeed / speakVolume`（另给 `baseUrl / result` 便于脚本拼接）。
 *
 * ⚠️ `@js:` 的执行由宿主注入（`TtsJsEvaluator`），core 这边**只消费结果** —— 沙箱边界
 * 不写在 core 里，否则 Web 端将来 import 这份代码会被 Node 内置模块拖住。
 */
import type { TtsEngineConfig, TtsErrorCode, TtsJsEvaluator } from './types';
import { TTS_LIMITS } from './types';
import { hasTtsTemplate, isTtsJsRule, parseTtsHeader } from './config';
import { applyUrlRuleJs, optionToRequest, splitUrlOptions } from '../net/url-prep';

/**
 * 语速范围。
 *
 * ★ **对齐上游**：Legado 绑给脚本的 `speakSpeed` 是**整数**，取值
 * `AppConfig.ttsSpeechRate + 5`（滑条 0~45 ⇒ 5~50，默认 10）。
 * 本仓内部用倍率（`speechRateOf = (rate + 5) / 10` ⇒ 0.5~5.0），
 * 所以在绑定前乘 10 取整 —— 否则 Baidu 那类
 * `{{String((speakSpeed + 5) / 10 + 4)}}` 的引擎规则会算出完全错误的速度。
 */
export const TTS_SPEED_MIN = 0.5;
export const TTS_SPEED_MAX = 5.0;
export const TTS_SPEED_DEFAULT = 1.0;

export interface TtsHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  headers: Record<string, string>;
}

export type TtsBuildResult =
  | { ok: true; request: TtsHttpRequest; speed: number }
  | {
    ok: false;
    code: Extract<TtsErrorCode, 'TTS_TEXT_EMPTY' | 'TTS_TEXT_TOO_LONG' | 'TTS_JS_TIMEOUT' | 'TTS_JS_ERROR' | 'TTS_URL_INVALID'>;
    message: string;
  };

/** 语速归一（0.5 ~ 2.0，缺省 1.0） */
export function clampTtsSpeed(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return TTS_SPEED_DEFAULT;
  return Math.max(TTS_SPEED_MIN, Math.min(TTS_SPEED_MAX, n));
}

/** `{{}}` 插值：表达式交给宿主沙箱（`speakText.trim()` 这类写法与上游一致） */
function renderTemplate(
  raw: string,
  bindings: Record<string, unknown>,
  evalJs: TtsJsEvaluator,
): { ok: true; value: string } | { ok: false; code: 'TTS_JS_TIMEOUT' | 'TTS_JS_ERROR'; message: string } {
  if (!hasTtsTemplate(raw)) return { ok: true, value: raw };
  // 逐个表达式求值并拼回（不用 `replace` 回调：回调里出错只能吞掉，拿不到失败码）
  const re = /\{\{([\s\S]*?)\}\}/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out += raw.slice(last, m.index);
    const code = String(m[1] ?? '').trim();
    if (code) {
      const r = evalJs(code, bindings);
      if (!r.ok) return { ok: false, code: r.code, message: r.message };
      out += r.value;
    }
    last = m.index + m[0].length;
  }
  out += raw.slice(last);
  return { ok: true, value: out };
}

/**
 * 构造请求。
 *
 * `engine.url` 支持三种形态（可叠加）：纯 URL / `@js:` / 含 `{{}}`。
 * 生成后必须是 **http(s) 绝对地址** —— 否则明确报 `TTS_URL_INVALID`，不把半截串交给 fetch
 * （fetch 会抛 `Failed to parse URL`，日志里看不出是配置错）。
 */
export async function buildTtsRequest(
  engine: TtsEngineConfig,
  text: string,
  opts: { speed?: unknown; evalJs: TtsJsEvaluator },
): Promise<TtsBuildResult> {
  const speakText = String(text ?? '');
  if (!speakText.trim()) return { ok: false, code: 'TTS_TEXT_EMPTY', message: '没有可朗读的文字' };
  if (speakText.length > TTS_LIMITS.text) {
    return {
      ok: false,
      code: 'TTS_TEXT_TOO_LONG',
      message: `单段文字超过 ${TTS_LIMITS.text} 字（请先分段）`,
    };
  }
  const speed = clampTtsSpeed(opts.speed);
  const bindings: Record<string, unknown> = {
    speakText,
    // 上游绑定值是整数 5~50（见文件头 TTS_SPEED_* 注释）
    speakSpeed: Math.round(speed * 10),
    // 上游 `AnalyzeUrl` 也绑 `speakVolume`；本仓暂无音量参数，固定 1
    speakVolume: 1,
    baseUrl: '',
    result: '',
    // 给脚本用的源桩（`jsLib` 里偶尔会读 `source.getKey()` / `source.name`）；不发网络、不读文件
    source: {
      key: engine.id,
      getKey: () => engine.id,
      name: engine.name,
      url: engine.url,
      contentType: engine.contentType ?? '',
      concurrentRate: engine.concurrentRate ?? '',
      getHeaderMap: () => ({ ...parseTtsHeader(engine.header), ...(engine.headers ?? {}) }),
      get: () => '',
      getVariable: () => '',
    },
  };

  let raw = engine.url;
  if (isTtsJsRule(raw)) {
    try {
      raw = await applyUrlRuleJs(raw, (code, current) => {
        const r = opts.evalJs(code, { ...bindings, result: current });
        if (!r.ok) throw Object.assign(new Error(r.message), { ttsCode: r.code });
        return r.value;
      });
    } catch (e) {
      const code = (e as { ttsCode?: 'TTS_JS_TIMEOUT' | 'TTS_JS_ERROR' }).ttsCode;
      return {
        ok: false,
        code: code === 'TTS_JS_TIMEOUT' ? 'TTS_JS_TIMEOUT' : 'TTS_JS_ERROR',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const rendered = renderTemplate(raw, bindings, opts.evalJs);
  if (!rendered.ok) return { ok: false, code: rendered.code, message: rendered.message };

  // 兜底 body 也要插值（`engine.body` 是独立字段，不在 `engine.url` 的串里）
  let body = engine.body;
  if (body) {
    const rb = renderTemplate(body, bindings, opts.evalJs);
    if (!rb.ok) return { ok: false, code: rb.code, message: rb.message };
    body = rb.value;
  }

  const split = splitUrlOptions(rendered.value);
  if (isTtsJsRule(split.url)) {
    // `@js:` 之后仍然残留脚本标记 ⇒ 上游写法是「前缀 + @result 拼接」，这里求值后应已消失；
    // 留着只可能是脚本自己返回了带 @js: 的串（循环配置），明确拒绝而不是发出去。
    return { ok: false, code: 'TTS_URL_INVALID', message: '@js: 求值结果里仍含脚本标记' };
  }

  const headerObj: Record<string, unknown> = {
    ...parseTtsHeader(engine.header),
    ...(engine.headers ?? {}),
  };
  const req = optionToRequest(split.option, {
    method: engine.method ?? 'GET',
    body,
    headers: headerObj,
  });

  let parsed: URL;
  try {
    parsed = new URL(split.url);
  } catch {
    return { ok: false, code: 'TTS_URL_INVALID', message: `请求地址不是绝对 URL：${split.url.slice(0, 120)}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'TTS_URL_INVALID', message: `只支持 http(s)：${parsed.protocol}` };
  }

  return {
    ok: true,
    speed,
    request: {
      url: parsed.toString(),
      method: req.method === 'POST' ? 'POST' : 'GET',
      ...(req.body ? { body: req.body } : {}),
      headers: req.headers,
    },
  };
}
