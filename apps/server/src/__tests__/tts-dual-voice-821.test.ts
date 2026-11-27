/**
 * `#821` 双音色服务端回归：存储持久化 + 选槽 + 副槽缺失回退 + 路由响应头。
 *
 * 用本地 HTTP 服务模拟两个音色槽：`/primary` 与 `/secondary` 返回**不同字节**，
 * 这样「到底走了哪个槽」不靠日志猜，直接看响应体。
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

/** 主槽：ID3 开头 ⇒ 嗅探成 audio/mpeg */
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01]);
/** 副槽：OggS 开头 ⇒ 嗅探成 audio/ogg（与主槽字节不同，肉眼可区分） */
const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);

type Seen = { url: string; headers: http.IncomingHttpHeaders };

async function withTwoVoices(): Promise<{ base: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const url = String(req.url ?? '');
    seen.push({ url, headers: req.headers });
    if (url.includes('/secondary')) {
      res.writeHead(200, { 'content-type': 'audio/ogg' });
      res.end(OGG);
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(MP3);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-tts-dual-'));
  return path.join(dir, 'tts-engines.json');
}

test('#821 双音色：主/副槽分别出声；副槽缺失回退主槽；重启后保持选择', async () => {
  const { base, seen, close } = await withTwoVoices();
  try {
    const file = tmpStore();
    const store = createTtsStore(file);
    const up = store.upsertEngine({
      name: '双音色引擎',
      url: `${base}/primary?t={{speakText}}`,
      header: 'X-Common: v',
      enabled: true,
      secondary: {
        name: '对话',
        url: `${base}/secondary?t={{speakText}}`,
        enabled: true, // 槽位没有 enabled 概念；多余字段应被忽略
      },
    });
    assert.equal(up.ok, true);
    if (!up.ok) return;
    assert.equal(store.setSettings({ enabled: true, defaultEngineId: up.engine.id }).ok, true);

    const svc = createTtsService({ store, http: createHttpClient() });

    // ① 单音色（默认关）：即使 activeVoice 被设成 secondary 也只走主槽
    assert.equal(store.setSettings({ activeVoice: 'secondary' }).ok, true);
    const single = await svc.speak({ text: '主' });
    assert.equal(single.ok, true);
    if (!single.ok) return;
    assert.equal(single.voiceSlot, 'primary');
    assert.equal(single.fellBack, false);
    assert.equal(single.bytes, MP3.length);
    assert.equal(single.contentType, 'audio/mpeg');
    assert.match(seen.at(-1)?.url ?? '', /\/primary/);
    assert.equal(seen.at(-1)?.headers['x-common'], 'v');

    // ② 双音色 + 副槽：走副槽的 URL / 字节 / MIME
    assert.equal(store.setSettings({ dualVoice: true, activeVoice: 'secondary' }).ok, true);
    const secondary = await svc.speak({ text: '副' });
    assert.equal(secondary.ok, true);
    if (!secondary.ok) return;
    assert.equal(secondary.voiceSlot, 'secondary');
    assert.equal(secondary.fellBack, false);
    assert.equal(secondary.bytes, OGG.length);
    assert.equal(secondary.contentType, 'audio/ogg');
    assert.match(seen.at(-1)?.url ?? '', /\/secondary/);
    assert.equal(secondary.engineName, '双音色引擎', '引擎名不被槽位名覆盖');

    // ③ 副槽缺失：回退主槽，明确标记 fellBack
    const dropped = store.upsertEngine({
      id: up.engine.id,
      name: '双音色引擎',
      url: `${base}/primary?t={{speakText}}`,
      header: 'X-Common: v',
      enabled: true,
    });
    assert.equal(dropped.ok, true);
    const fallback = await svc.speak({ text: '回退' });
    assert.equal(fallback.ok, true);
    if (!fallback.ok) return;
    assert.equal(fallback.voiceSlot, 'primary');
    assert.equal(fallback.fellBack, true);
    assert.equal(fallback.bytes, MP3.length);
    assert.match(seen.at(-1)?.url ?? '', /\/primary/);

    // ④ 持久化：把副槽写回 + 双音色/槽位写盘，重新打开 store 必须还是上次选择
    const restored = store.upsertEngine({
      id: up.engine.id,
      name: '双音色引擎',
      url: `${base}/primary?t={{speakText}}`,
      header: 'X-Common: v',
      enabled: true,
      secondary: { name: '对话', url: `${base}/secondary?t={{speakText}}` },
    });
    assert.equal(restored.ok, true);
    assert.equal(store.setSettings({ dualVoice: true, activeVoice: 'secondary' }).ok, true);

    const reopened = createTtsStore(file);
    const cfg = reopened.read();
    assert.equal(cfg.dualVoice, true);
    assert.equal(cfg.activeVoice, 'secondary');
    assert.equal(cfg.engines[0]?.secondary?.url, `${base}/secondary?t={{speakText}}`);
  } finally {
    close();
  }
});

test('#821 路由：config 暴露双音色字段；speak 带实际槽位/回退响应头', async () => {
  const { base, close } = await withTwoVoices();
  const app = Fastify();
  try {
    const store = createTtsStore(tmpStore());
    const service = createTtsService({ store, http: createHttpClient() });
    registerTtsRoutes(app, { store, service });
    await app.ready();

    const put = await app.inject({
      method: 'PUT',
      url: '/api/tts/engines',
      payload: {
        name: '路由双音色',
        url: `${base}/primary?t={{speakText}}`,
        enabled: true,
        secondary: { name: '对话', url: `${base}/secondary?t={{speakText}}` },
      },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().hasSecondary, true);
    const id = put.json().engine.id as string;

    const cfg0 = (await app.inject({ method: 'GET', url: '/api/tts/config' })).json();
    assert.equal(cfg0.dualVoice, false, '双音色默认关');
    assert.equal(cfg0.activeVoice, 'primary');
    assert.equal(cfg0.engines[0].hasSecondary, true);

    const badSlot = await app.inject({
      method: 'PUT',
      url: '/api/tts/config',
      payload: { activeVoice: 'main' },
    });
    assert.equal(badSlot.statusCode, 400);
    assert.equal(badSlot.json().error.code, 'VOICE_SLOT_INVALID');

    const on = await app.inject({
      method: 'PUT',
      url: '/api/tts/config',
      payload: { enabled: true, defaultEngineId: id, dualVoice: true, activeVoice: 'secondary' },
    });
    assert.equal(on.statusCode, 200);
    assert.equal(on.json().config.dualVoice, true);
    assert.equal(on.json().config.activeVoice, 'secondary');

    const speak = await app.inject({ method: 'POST', url: '/api/tts/speak', payload: { text: '副' } });
    assert.equal(speak.statusCode, 200);
    assert.equal(speak.headers['x-tts-voice-slot'], 'secondary');
    assert.equal(speak.headers['x-tts-fellback'], '0');
    assert.equal(speak.headers['content-type'], 'audio/ogg');
    assert.equal(speak.rawPayload.length, OGG.length);

    // 关掉双音色：只改开关，槽位保留；下一次 speak 回主槽
    const off = await app.inject({
      method: 'PUT',
      url: '/api/tts/config',
      payload: { dualVoice: false },
    });
    assert.equal(off.json().config.activeVoice, 'secondary', '关掉双音色不动上次槽位');
    const single = await app.inject({ method: 'POST', url: '/api/tts/speak', payload: { text: '主' } });
    assert.equal(single.headers['x-tts-voice-slot'], 'primary');
    assert.equal(single.rawPayload.length, MP3.length);
  } finally {
    await app.close();
    close();
  }
});
