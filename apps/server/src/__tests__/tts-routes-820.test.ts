/**
 * `#820` TTS 路由面（Fastify `inject`，不监听端口）。
 *
 * 锁「默认关」的对外表现：首次 `GET /api/tts/config` 一定是 `enabled:false / engines:[]`；
 * 打开 → 选引擎 → `POST /api/tts/speak` 拿到音频字节，正是 UI 那轮要接的完整链路。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

import { createHttpClient } from '@yuedu/core';

import { registerTtsRoutes } from '../tts-routes';
import { createTtsService } from '../tts-service';
import { createTtsStore } from '../tts-store';

const FAKE_MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01]);

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-tts-route-'));
  return path.join(dir, 'tts-engines.json');
}

test('路由：默认关 → 配置 → 合成 → 分段 → 删除', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(FAKE_MP3);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const store = createTtsStore(tmpStore());
  const service = createTtsService({ store, http: createHttpClient() });
  const app = Fastify();
  registerTtsRoutes(app, { store, service });
  await app.ready();
  try {
    const first = await app.inject({ method: 'GET', url: '/api/tts/config' });
    assert.equal(first.statusCode, 200);
    const cfg0 = first.json();
    assert.equal(cfg0.enabled, false);
    assert.deepEqual(cfg0.engines, []);

    const bad = await app.inject({ method: 'PUT', url: '/api/tts/engines', payload: { name: '', url: 'x' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'NAME_REQUIRED');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/tts/engines',
      payload: { name: '本地', url: `${base}/tts?t={{speakText}}` },
    });
    assert.equal(put.statusCode, 200);
    const engine = put.json().engine as { id: string; enabled: boolean };
    assert.equal(engine.enabled, false, '新引擎默认关');
    assert.equal(put.json().jsRule, false);

    // 引擎还没开 ⇒ speak 拒绝
    const open = await app.inject({
      method: 'PUT',
      url: '/api/tts/config',
      payload: { enabled: true, defaultEngineId: engine.id },
    });
    assert.equal(open.statusCode, 200);
    const stillOff = await app.inject({ method: 'POST', url: '/api/tts/speak', payload: { text: '你好' } });
    assert.equal(stillOff.statusCode, 503);
    assert.equal(stillOff.json().error.code, 'TTS_ENGINE_DISABLED');

    const enable = await app.inject({
      method: 'PUT',
      url: '/api/tts/engines',
      payload: { id: engine.id, name: '本地', url: `${base}/tts?t={{speakText}}`, enabled: true },
    });
    assert.equal(enable.statusCode, 200);

    const speak = await app.inject({ method: 'POST', url: '/api/tts/speak', payload: { text: '你好' } });
    assert.equal(speak.statusCode, 200);
    assert.equal(speak.headers['content-type'], 'audio/mpeg');
    assert.equal(speak.headers['cache-control'], 'no-store');
    assert.equal(speak.rawPayload.length, FAKE_MP3.length);

    const seg = await app.inject({
      method: 'POST',
      url: '/api/tts/segment',
      payload: { text: '第一句。第二句！' },
    });
    assert.equal(seg.statusCode, 200);
    const segJson = seg.json() as { count: number; segments: Array<{ text: string }> };
    assert.ok(segJson.count >= 1);
    assert.equal(segJson.segments.map((s) => s.text).join('').includes('第一句'), true);

    const del = await app.inject({ method: 'DELETE', url: `/api/tts/engines?id=${encodeURIComponent(engine.id)}` });
    assert.equal(del.statusCode, 200);
    const cfg1 = (await app.inject({ method: 'GET', url: '/api/tts/config' })).json();
    assert.deepEqual(cfg1.engines, []);
    assert.equal(cfg1.defaultEngineId, '', '删引擎时默认一并清空');
    const delAgain = await app.inject({ method: 'DELETE', url: `/api/tts/engines?id=${encodeURIComponent(engine.id)}` });
    assert.equal(delAgain.statusCode, 404);
  } finally {
    await app.close();
    server.close();
  }
});

test('路由：@js 引擎在配置列表带 jsRule=true（供 UI 默认折叠）', async () => {
  const store = createTtsStore(tmpStore());
  const app = Fastify();
  registerTtsRoutes(app, { store, service: createTtsService({ store, http: createHttpClient() }) });
  await app.ready();
  try {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/tts/engines',
      payload: { name: 'js', url: "@js:'https://a.test/t?x='+speakText" },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().jsRule, true);
  } finally {
    await app.close();
  }
});
