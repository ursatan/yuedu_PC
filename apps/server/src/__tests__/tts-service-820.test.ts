/**
 * `#820` TTS 合成服务端到端（本地假引擎，真 `HttpClient`）。
 *
 * 为什么要起一个本地 HTTP 服务：合成链路的重头是「配置 → 请求 → 字节 → MIME」，
 * 拿外部 TTS 站点测不可重复（限流/拦 UA/改接口）。本地服务能把每条失败路径都造出来。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHttpClient, type HttpClient } from '@yuedu/core';

import { createTtsService } from '../tts-service';
import { createTtsStore } from '../tts-store';

/** 一段能被嗅探成 `audio/mpeg` 的假音频（ID3 + 少量字节） */
const FAKE_MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x11, 0x22]);

interface Seen {
  method?: string;
  url?: string;
  body?: string;
  headers?: http.IncomingHttpHeaders;
}

async function withEngine(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ base: string; server: http.Server; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, server, seen };
}

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-tts-svc-'));
  return path.join(dir, 'tts-engines.json');
}

test('默认关：全局未开 ⇒ TTS_DISABLED（即使引擎配好且开着）', async () => {
  const { server, base } = await withEngine((_q, r) => { r.writeHead(200, { 'content-type': 'audio/mpeg' }); r.end(FAKE_MP3); });
  try {
    const store = createTtsStore(tmpStore());
    const e = store.upsertEngine({ name: 'e', url: `${base}/tts?t={{speakText}}`, enabled: true });
    assert.equal(e.ok, true);
    const svc = createTtsService({ store, http: createHttpClient() });
    const out = await svc.speak({ text: '你好' });
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.status, 503);
      assert.equal(out.code, 'TTS_DISABLED');
    }
  } finally {
    server.close();
  }
});

test('引擎关 / 没选引擎 / 引擎不存在 都给出明确失败码', async () => {
  const store = createTtsStore(tmpStore());
  const e = store.upsertEngine({ name: 'e', url: 'https://example.invalid/tts', enabled: true });
  assert.equal(e.ok, true);
  if (!e.ok) return;
  const svc = createTtsService({ store, http: createHttpClient() });

  assert.equal(store.setSettings({ enabled: true }).ok, true);
  const notSelected = await svc.speak({ text: 'x' });
  assert.equal(notSelected.ok, false);
  if (!notSelected.ok) {
    assert.equal(notSelected.status, 404);
    assert.equal(notSelected.code, 'TTS_ENGINE_NOT_FOUND');
  }

  // 默认引擎选了但引擎自身关着
  assert.equal(store.setSettings({ defaultEngineId: e.engine.id }).ok, true);
  const off = store.upsertEngine({ name: 'e', url: 'https://example.invalid/tts', enabled: false });
  assert.equal(off.ok, true);
  const disabled = await svc.speak({ text: 'x' });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) {
    assert.equal(disabled.status, 503);
    assert.equal(disabled.code, 'TTS_ENGINE_DISABLED');
  }

  const missing = await svc.speak({ engineId: 'tts-nope', text: 'x' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'TTS_ENGINE_NOT_FOUND');
});

test('成功路径：模板插值 + 语速 + 音频字节/MIME 回传', async () => {
  const { server, base, seen } = await withEngine((_q, r) => {
    r.writeHead(200, { 'content-type': 'application/octet-stream' });
    r.end(FAKE_MP3);
  });
  try {
    const store = createTtsStore(tmpStore());
    const e = store.upsertEngine({
      name: '本地引擎',
      url: `${base}/tts?text={{speakText}}&speed={{speakSpeed}}`,
      enabled: true,
      header: 'X-K: v',
    });
    assert.equal(e.ok, true);
    if (!e.ok) return;
    assert.equal(store.setSettings({ enabled: true, defaultEngineId: e.engine.id }).ok, true);

    const svc = createTtsService({ store, http: createHttpClient() });
    const out = await svc.speak({ text: '你好', speed: 1.5 });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.bytes, FAKE_MP3.length);
    assert.equal(out.contentType, 'audio/mpeg', 'octet-stream + 魔术字节 ⇒ 判成 MP3');
    assert.deepEqual(out.audio, FAKE_MP3);
    assert.equal(out.engineName, '本地引擎');

    const req = seen[0]!;
    assert.equal(req.method, 'GET');
    assert.match(String(req.url), /text=%E4%BD%A0%E5%A5%BD/);
    assert.match(String(req.url), /speed=15/, 'speakSpeed 对齐上游：倍率 1.5 ⇒ 整数 15');
    assert.equal(req.headers?.['x-k'], 'v');
  } finally {
    server.close();
  }
});

test('成功路径：POST body + @js 形态', async () => {
  const { server, base, seen } = await withEngine((_q, r) => {
    r.writeHead(200, { 'content-type': 'audio/ogg' });
    r.end(Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00]));
  });
  try {
    const store = createTtsStore(tmpStore());
    const e = store.upsertEngine({
      name: 'js 引擎',
      url: `@js:'${base}/tts?lang=zh'`,
      method: 'POST',
      body: '{"text":"{{speakText}}"}',
      enabled: true,
    });
    assert.equal(e.ok, true);
    if (!e.ok) return;
    assert.equal(store.setSettings({ enabled: true, defaultEngineId: e.engine.id }).ok, true);
    const svc = createTtsService({ store, http: createHttpClient() });
    const out = await svc.speak({ text: '你好' });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.contentType, 'audio/ogg');
    const req = seen[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/tts?lang=zh');
    assert.equal(req.body, '{"text":"你好"}');
  } finally {
    server.close();
  }
});

test('失败路径：HTTP 500 / 200 返 JSON / 空体 / 超时', async () => {
  // 用不同路径分流，避免反复起停服务
  const { server, base } = await withEngine((q, r) => {
    const url = String(q.url ?? '');
    if (url.includes('e500')) {
      r.writeHead(500, { 'content-type': 'text/plain' });
      r.end('boom');
      return;
    }
    if (url.includes('ejson')) {
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end('{"code":401,"msg":"bad key"}');
      return;
    }
    if (url.includes('eempty')) {
      r.writeHead(200, { 'content-type': 'audio/mpeg' });
      r.end();
      return;
    }
    if (url.includes('eslow')) {
      setTimeout(() => { r.writeHead(200, { 'content-type': 'audio/mpeg' }); r.end(FAKE_MP3); }, 1500);
      return;
    }
    r.writeHead(200, { 'content-type': 'audio/mpeg' });
    r.end(FAKE_MP3);
  });
  try {
    const store = createTtsStore(tmpStore());
    assert.equal(store.setSettings({ enabled: true }).ok, true);
    const mk = (p: string, extra: Record<string, unknown> = {}) => {
      const r = store.upsertEngine({ name: p, url: `${base}/${p}`, enabled: true, ...extra });
      assert.equal(r.ok, true);
      return r.ok ? r.engine.id : '';
    };
    const id500 = mk('e500');
    const idJson = mk('ejson');
    const idEmpty = mk('eempty');
    const idSlow = mk('eslow', { timeoutMs: 1000 });

    const svc = createTtsService({ store, http: createHttpClient() });
    const c500 = await svc.speak({ engineId: id500, text: 'x' });
    assert.equal(c500.ok, false);
    if (!c500.ok) {
      assert.equal(c500.status, 502);
      assert.equal(c500.code, 'TTS_HTTP_STATUS');
      assert.match(String(c500.detail), /HTTP 500: boom/);
    }
    const cJson = await svc.speak({ engineId: idJson, text: 'x' });
    assert.equal(cJson.ok, false);
    if (!cJson.ok) {
      assert.equal(cJson.code, 'TTS_CONTENT_TYPE');
      assert.match(String(cJson.detail), /bad key/);
    }
    const cEmpty = await svc.speak({ engineId: idEmpty, text: 'x' });
    assert.equal(cEmpty.ok, false);
    if (!cEmpty.ok) assert.equal(cEmpty.code, 'TTS_EMPTY_AUDIO');
    const cSlow = await svc.speak({ engineId: idSlow, text: 'x' });
    assert.equal(cSlow.ok, false);
    if (!cSlow.ok) {
      assert.equal(cSlow.status, 504);
      assert.equal(cSlow.code, 'TTS_HTTP_TIMEOUT');
    }
  } finally {
    server.close();
  }
});

test('失败路径：空文本 / 超长文本 / @js 死循环（沙箱超时）', async () => {
  const store = createTtsStore(tmpStore());
  assert.equal(store.setSettings({ enabled: true }).ok, true);
  const e = store.upsertEngine({ name: 'a', url: 'https://example.invalid/tts?t={{speakText}}', enabled: true });
  assert.equal(e.ok, true);
  if (!e.ok) return;
  const js = store.upsertEngine({ name: 'loop', url: '@js:while(true){}', enabled: true });
  assert.equal(js.ok, true);
  if (!js.ok) return;

  const svc = createTtsService({ store, http: createHttpClient() });
  const empty = await svc.speak({ engineId: e.engine.id, text: ' ' });
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.status, 400);
    assert.equal(empty.code, 'TTS_TEXT_EMPTY');
  }
  const long = await svc.speak({ engineId: e.engine.id, text: '字'.repeat(5001) });
  assert.equal(long.ok, false);
  if (!long.ok) {
    assert.equal(long.status, 413);
    assert.equal(long.code, 'TTS_TEXT_TOO_LONG');
  }
  const loop = await svc.speak({ engineId: js.engine.id, text: 'x' });
  assert.equal(loop.ok, false);
  if (!loop.ok) {
    assert.equal(loop.status, 400);
    assert.equal(loop.code, 'TTS_JS_TIMEOUT');
  }
});

test('#873 loginCheckJs：能识别「请先登录」页，也能放行', async () => {
  const { server, base } = await withEngine((q, r) => {
    r.writeHead(200, { 'content-type': 'audio/mpeg' });
    r.end(String(q.url).includes('login') ? '请先登录' : FAKE_MP3);
  });
  try {
    const store = createTtsStore(tmpStore());
    assert.equal(store.setSettings({ enabled: true }).ok, true);
    const mk = (p: string, extra: Record<string, unknown>) => {
      const r = store.upsertEngine({ name: p, url: `${base}/${p}`, enabled: true, ...extra });
      assert.equal(r.ok, true);
      return r.ok ? r.engine.id : '';
    };
    const idNeedLogin = mk('login', { loginCheckJs: "return response.body.indexOf('登录') >= 0 ? '需要登录' : ''" });
    const idPass = mk('pass', { loginCheckJs: 'return ""' });

    const svc = createTtsService({ store, http: createHttpClient() });
    const bad = await svc.speak({ engineId: idNeedLogin, text: 'x' });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.status, 502);
      assert.equal(bad.code, 'TTS_LOGIN_CHECK');
      assert.match(String(bad.message), /需要登录/);
    }
    const good = await svc.speak({ engineId: idPass, text: 'x' });
    assert.equal(good.ok, true);
  } finally {
    server.close();
  }
});

test('#873 enabledCookieJar：收 Set-Cookie、下次带上、重启后仍在', async () => {
  let calls = 0;
  const { server, base, seen } = await withEngine((_q, r) => {
    calls += 1;
    r.writeHead(200, {
      'content-type': 'audio/mpeg',
      ...(calls === 1 ? { 'set-cookie': 'sid=abc; Path=/; HttpOnly' } : {}),
    });
    r.end(FAKE_MP3);
  });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-tts-jar-'));
    const cookieFile = path.join(dir, 'tts-cookies.json');
    const store = createTtsStore(tmpStore());
    assert.equal(store.setSettings({ enabled: true }).ok, true);
    const e = store.upsertEngine({ name: 'jar', url: `${base}/jar`, enabled: true, enabledCookieJar: true });
    assert.equal(e.ok, true);
    if (!e.ok) return;
    assert.equal(store.setSettings({ defaultEngineId: e.engine.id }).ok, true);

    const svc1 = createTtsService({ store, http: createHttpClient(), cookieFile });
    assert.equal((await svc1.speak({ text: 'x' })).ok, true);
    assert.equal(seen[0]?.headers?.cookie, undefined, '第一次没有旧 Cookie');

    const svc2 = createTtsService({ store, http: createHttpClient(), cookieFile });
    assert.equal((await svc2.speak({ text: 'x' })).ok, true);
    assert.equal(seen[1]?.headers?.cookie, 'sid=abc', '第二次/重启后从罐里补上');

    svc2.forgetEngine(e.engine.id);
    const raw = fs.readFileSync(cookieFile, 'utf8');
    assert.equal(raw.includes('sid'), false, '删引擎要连带清掉它的 Cookie');
  } finally {
    server.close();
  }
});

test('#873 concurrentRate：同引擎两次请求之间有最小间隔', async () => {
  const { server, base } = await withEngine((_q, r) => {
    r.writeHead(200, { 'content-type': 'audio/mpeg' });
    r.end(FAKE_MP3);
  });
  try {
    const store = createTtsStore(tmpStore());
    assert.equal(store.setSettings({ enabled: true }).ok, true);
    const e = store.upsertEngine({ name: 'rate', url: `${base}/rate`, enabled: true, concurrentRate: '1/200' });
    assert.equal(e.ok, true);
    if (!e.ok) return;
    const svc = createTtsService({ store, http: createHttpClient() });
    const t0 = Date.now();
    assert.equal((await svc.speak({ engineId: e.engine.id, text: 'a' })).ok, true);
    assert.equal((await svc.speak({ engineId: e.engine.id, text: 'b' })).ok, true);
    assert.ok(Date.now() - t0 >= 150, '受 1/200 限速，两次请求不能贴在一起');
  } finally {
    server.close();
  }
});

test('#873 网络错误重试 1 次后成功', async () => {
  const store = createTtsStore(tmpStore());
  assert.equal(store.setSettings({ enabled: true }).ok, true);
  const e = store.upsertEngine({ name: 'retry', url: 'https://example.invalid/tts', enabled: true });
  assert.equal(e.ok, true);
  if (!e.ok) return;
  let attempts = 0;
  const fake: HttpClient = {
    request: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      return {
        status: 200,
        url: 'https://example.invalid/tts',
        headers: { 'content-type': 'audio/mpeg' },
        body: new Uint8Array(FAKE_MP3).buffer,
      };
    },
  };
  const svc = createTtsService({ store, http: fake });
  const out = await svc.speak({ engineId: e.engine.id, text: 'x' });
  assert.equal(out.ok, true);
  assert.equal(attempts, 2, '第一次网络错误后必须重试一次');
});
