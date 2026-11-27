/**
 * `#873` 朗读引擎修复回归锁（纯 Node，不碰 DOM）。
 *
 * 钉三件事：
 *  · 删除引擎是**本地配置操作**：DELETE 不能带 JSON content-type（否则 Fastify 400，
 *    再被前端误翻译成「连不上引擎地址」）；
 *  · Fastify 的框架错误体（`statusCode/code/message`）不能被当成 TTS 网络错误；
 *  · 设置面 → 朗读后端的变化指纹：换引擎/换音色槽/改配置/改开关都必须变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeTtsError,
  parseTtsEngineJson,
  removeTtsEngine,
  ttsBackendSignature,
  TtsApiError,
} from '../src/utils/tts';

test('#873 删引擎：DELETE 不带 content-type（Fastify 不接受空 JSON body）', async () => {
  const orig = globalThis.fetch;
  let seen: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init };
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await removeTtsEngine('tts-abc');
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(seen);
  const s = seen as { url: string; init?: RequestInit };
  assert.equal(s.init?.method, 'DELETE');
  assert.match(s.url, /\/api\/tts\/engines\?id=tts-abc/);
  const headers = new Headers(s.init?.headers);
  assert.equal(headers.has('content-type'), false, 'DELETE 没有 body，不能声明 application/json');
});

test('#873 Fastify 错误体（空 JSON body 400）→ 明确 HTTP 错误，而不是「连不上引擎地址」', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      statusCode: 400,
      code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
      error: 'Bad Request',
      message: "Body cannot be empty when content-type is set to 'application/json'",
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  let err: unknown = null;
  try {
    await removeTtsEngine('tts-abc');
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(err instanceof TtsApiError);
  const e = err as TtsApiError;
  assert.equal(e.code, 'TTS_HTTP_STATUS');
  assert.match(describeTtsError(e.code, e.message, e.detail), /对方服务器返回错误（HTTP 400）/);
});

test('#873 后端指纹：换引擎 / 改配置 / 切音色槽 / 改开关都要变', () => {
  const cfg = { enabled: true, dualVoice: true, activeVoice: 'primary' as const, defaultEngineId: 'a' };
  const a = { name: 'A', enabled: true, updatedAt: 111 };
  const base = ttsBackendSignature(cfg, a);

  assert.equal(ttsBackendSignature({ ...cfg }, a), base, '没变就不重启朗读');
  assert.notEqual(ttsBackendSignature({ ...cfg, defaultEngineId: 'b' }, a), base, '换默认引擎');
  assert.notEqual(ttsBackendSignature({ ...cfg, activeVoice: 'secondary' }, a), base, '切副音色槽');
  assert.notEqual(ttsBackendSignature(cfg, { ...a, updatedAt: 222 }), base, '同引擎改配置');
  assert.notEqual(ttsBackendSignature({ ...cfg, enabled: false }, a), base, '关掉在线朗读');
  assert.notEqual(ttsBackendSignature({ ...cfg, dualVoice: false }, a), base, '关双音色');
});

test('#873 粘贴 Legado HttpTTS：新字段都能带进来', () => {
  const r = parseTtsEngineJson(JSON.stringify({
    name: '全字段',
    url: 'https://x.example/tts',
    pauseDuration: 1200,
    concurrentRate: '1/500',
    loginUrl: 'https://x.example/login',
    loginUi: [{ name: '账号', type: 'text' }],
    loginCheckJs: 'return ""',
    enabledCookieJar: true,
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.engine.pauseDuration, 1200);
  assert.equal(r.engine.concurrentRate, '1/500');
  assert.equal(r.engine.loginUrl, 'https://x.example/login');
  assert.equal(r.engine.loginUi, '[{"name":"账号","type":"text"}]', '对象/数组形式的 loginUi 要转成 JSON 串');
  assert.equal(r.engine.loginCheckJs, 'return ""');
  assert.equal(r.engine.enabledCookieJar, true);
});
