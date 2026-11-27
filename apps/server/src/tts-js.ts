/**
 * `#820` **`@js:` 求值沙箱**（只给 TTS 用；服务端独占实现）。
 *
 * ## 沙箱边界（用户拍板的「允许但默认折叠」靠这段撑住）
 *  · 运行在 **`node:vm` 的新上下文**里：没有 `process` / `require` / `fetch` / `fs` / `Buffer`；
 *  · `codeGeneration.strings: false` —— 沙箱内**不能** `eval` / `new Function` / 动态拼代码
 *    （这是公认的 vm 逃逸主通道，关掉后「脚本把宿主 require 出来」这条路断掉）；
 *  · `java` 只给**纯函数**（base64 / md5 / sha / urlencode / hex），**没有 `java.ajax`** ——
 *    TTS 的 `@js:` 只要产出**一个 URL**，请求由宿主的 HTTP 层发（可审计、走同一套超时/体积护栏）；
 *  · 单次执行**硬超时**（默认 2s，`YUEDU_TTS_JS_TIMEOUT_MS` 可调）—— 死循环会被 vm 打断；
 *  · 输出截断到 16KB（防止脚本返回巨型串把内存/URL 撑爆）。
 *
 * ## 兼容 Legado
 *  · `jsLib`（引擎的前导脚本）与主脚本在**同一上下文**里顺序执行；
 *  · 取「最后一个表达式的值」（vm 的 completion value 语义，与上游 `eval` 一致）；
 *  · 顶层 `return` 也兼容（`@js:` 常见的 `return 'https://…'`），失败时包一层 IIFE 重试。
 *
 * ⚠️ 这一层是**服务端模块**：core 的 `buildTtsRequest` 只消费 `TtsJsEvaluator`，
 * 不 import `node:vm`（否则 Web 侧将来走 `@yuedu/core/tts` 会被 Node 内置模块拖住）。
 */
import vm from 'node:vm';
import { createHash } from 'node:crypto';

import { TTS_LIMITS, type TtsJsEvaluator, type TtsJsResult } from '@yuedu/core';

/** 默认单次执行上限（够跑签名/拼接，不够跑死循环） */
export const TTS_JS_DEFAULT_TIMEOUT_MS = 2000;
/** 输出截断（URL/body 的合理上限，防巨型串） */
const MAX_OUTPUT = 16 * 1024;

function timeoutFromEnv(): number {
  const n = Number(process.env.YUEDU_TTS_JS_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return TTS_JS_DEFAULT_TIMEOUT_MS;
  return Math.max(50, Math.min(10_000, Math.round(n)));
}

/** vm 的 completion value → 字符串（对象按 JSON，便于脚本返回 `{url, headers}` 时排查） */
function toText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    const s = JSON.stringify(v);
    return typeof s === 'string' ? s : String(v);
  } catch {
    return String(v);
  }
}

/** 受限 `java` 桩：**只有纯函数**，没有网络/文件/进程 */
function makeJavaStub(): Record<string, unknown> {
  const enc = (s: unknown) => Buffer.from(String(s ?? ''), 'utf-8');
  const vars: Record<string, string> = {};
  return {
    // 编码/摘要（引擎签名常用）
    base64: (s: unknown) => enc(s).toString('base64'),
    base64Encode: (s: unknown) => enc(s).toString('base64'),
    base64Decode: (s: unknown) => Buffer.from(String(s ?? ''), 'base64').toString('utf-8'),
    md5: (s: unknown) => createHash('md5').update(enc(s)).digest('hex'),
    md5Encode: (s: unknown) => createHash('md5').update(enc(s)).digest('hex'),
    sha1: (s: unknown) => createHash('sha1').update(enc(s)).digest('hex'),
    sha256: (s: unknown) => createHash('sha256').update(enc(s)).digest('hex'),
    encodeURI: (s: unknown) => encodeURIComponent(String(s ?? '')),
    hexEncodeToString: (s: unknown) => enc(s).toString('hex'),
    hexDecodeToString: (s: unknown) => Buffer.from(String(s ?? ''), 'hex').toString('utf-8'),
    // 变量表：**只在本次求值内**共享（不落盘、不跨请求，避免成为隐蔽状态）
    get: (k: unknown) => vars[String(k ?? '')] ?? '',
    put: (k: unknown, v: unknown) => { vars[String(k ?? '')] = String(v ?? ''); },
    log: () => {},
    toast: () => {},
    longToast: () => {},
  };
}

/** 建一个新上下文（每次求值全新，脚本之间不串状态） */
function makeContext(bindings: Record<string, unknown>): vm.Context {
  const sandbox: Record<string, unknown> = {
    ...bindings,
    java: makeJavaStub(),
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
  };
  return vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
}

function runInContext(code: string, ctx: vm.Context, timeoutMs: number): unknown {
  const script = new vm.Script(code, { filename: 'tts-engine.js' });
  return script.runInContext(ctx, { timeout: timeoutMs, displayErrors: true });
}

/** 一次求值（`jsLib` 与主脚本同上下文顺序执行） */
export function evalTtsJs(
  code: string,
  bindings: Record<string, unknown>,
  opts: { jsLib?: string; timeoutMs?: number } = {},
): TtsJsResult {
  const timeoutMs = Math.max(50, Math.min(10_000, Math.round(opts.timeoutMs ?? timeoutFromEnv())));
  const jsLib = String(opts.jsLib ?? '');
  if (jsLib.length > TTS_LIMITS.jsLib) {
    return { ok: false, code: 'TTS_JS_ERROR', message: `jsLib 超过 ${TTS_LIMITS.jsLib} 字` };
  }
  const full = jsLib ? `${jsLib}\n;\n${String(code ?? '')}` : String(code ?? '');
  try {
    const ctx = makeContext(bindings);
    // 第一次按「脚本」跑：取 completion value（`speakText.trim()` 这类裸表达式可用）
    try {
      return { ok: true, value: toText(runInContext(full, ctx, timeoutMs)).slice(0, MAX_OUTPUT) };
    } catch (e) {
      // 顶层 `return` 不是合法脚本 → 包 IIFE 重试（上游 `@js:` 常见写法）
      if (!(e instanceof SyntaxError)) throw e;
      const wrapped = `(function(){\n${full}\n})()`;
      return { ok: true, value: toText(runInContext(wrapped, ctx, timeoutMs)).slice(0, MAX_OUTPUT) };
    }
  } catch (e) {
    const err = e as { code?: string; message?: string; name?: string };
    if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      return { ok: false, code: 'TTS_JS_TIMEOUT', message: `脚本执行超过 ${timeoutMs}ms` };
    }
    const msg = String(err?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);
    return { ok: false, code: 'TTS_JS_ERROR', message: `脚本执行失败：${msg}` };
  }
}

/** 给 core 的 `buildTtsRequest` 用：把该引擎的 `jsLib` 绑进来 */
export function createTtsJsEvaluator(opts: { jsLib?: string; timeoutMs?: number } = {}): TtsJsEvaluator {
  return (code, bindings) => evalTtsJs(code, bindings, opts);
}
