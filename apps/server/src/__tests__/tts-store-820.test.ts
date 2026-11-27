/**
 * `#820` TTS 引擎配置存储（`data/tts-engines.json`）单测。
 *
 * 锁三件事：
 *  1. 文件不存在 ⇒ **默认关**（没有预置可用状态）；
 *  2. Key 落独立文件（不进用户快照 ⇒ 不进备份 ZIP）；
 *  3. 坏文件/坏条目读时容错，不会让整个 TTS 功能起不来。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTtsStore } from '../tts-store';

function tmpFile(name = 'tts-engines.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-tts-'));
  return path.join(dir, name);
}

test('文件不存在 ⇒ 默认关（无引擎、无默认引擎）', () => {
  const store = createTtsStore(tmpFile());
  const cfg = store.read();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.defaultEngineId, '');
  assert.deepEqual(cfg.engines, []);
});

test('upsert：缺省关、显式开、落盘可读回、稳定 id', () => {
  const file = tmpFile();
  const store = createTtsStore(file);
  const a = store.upsertEngine({ name: 'a', url: 'https://a.test/tts?t={{speakText}}' });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.engine.enabled, false, '新引擎默认关');
  assert.ok(a.engine.updatedAt && a.engine.updatedAt > 0);

  const b = store.upsertEngine({ name: 'b', url: 'https://b.test/', enabled: true, header: 'Authorization: Bearer k' });
  assert.equal(b.ok, true);
  if (!b.ok) return;

  // 新进程（新 store）读回：开关与 Key 都在
  const again = createTtsStore(file).read();
  assert.equal(again.engines.length, 2);
  assert.equal(again.enabled, false);
  assert.equal(again.engines.find((e) => e.id === b.engine.id)?.header, 'Authorization: Bearer k');

  // 同名同 url 再导入 ⇒ 更新同一条，不新增
  const again2 = store.upsertEngine({ name: 'b', url: 'https://b.test/', enabled: false });
  assert.equal(again2.ok, true);
  if (!again2.ok) return;
  assert.equal(again2.engine.id, b.engine.id);
  assert.equal(store.read().engines.length, 2);
});

test('setSettings：全局开关 + 默认引擎（不存在的默认引擎被拒）', () => {
  const store = createTtsStore(tmpFile());
  const e = store.upsertEngine({ name: 'a', url: 'https://a.test/', enabled: true });
  assert.equal(e.ok, true);
  if (!e.ok) return;
  const bad = store.setSettings({ defaultEngineId: 'tts-nope', enabled: true });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error, 'DEFAULT_ENGINE_NOT_FOUND');
  const ok = store.setSettings({ defaultEngineId: e.engine.id, enabled: true });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.config.enabled, true);
  assert.equal(store.read().defaultEngineId, e.engine.id);
});

test('removeEngine：删后默认引擎一并清空；不存在返回 false', () => {
  const store = createTtsStore(tmpFile());
  const e = store.upsertEngine({ name: 'a', url: 'https://a.test/', enabled: true });
  assert.equal(e.ok, true);
  if (!e.ok) return;
  assert.equal(store.setSettings({ defaultEngineId: e.engine.id }).ok, true);
  assert.equal(store.removeEngine('tts-nope'), false);
  assert.equal(store.removeEngine(e.engine.id), true);
  const cfg = store.read();
  assert.equal(cfg.engines.length, 0);
  assert.equal(cfg.defaultEngineId, '');
});

test('坏文件 / 坏条目：读时容错（不静默改文件）', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json', 'utf-8');
  assert.deepEqual(createTtsStore(file).read().engines, []);

  const file2 = tmpFile('tts2.json');
  fs.writeFileSync(file2, JSON.stringify({
    enabled: 'true',
    engines: [{ name: '', url: 'https://bad.test/' }, { name: 'ok', url: 'https://ok.test/' }],
  }), 'utf-8');
  const cfg = createTtsStore(file2).read();
  assert.equal(cfg.enabled, false, '"true" 不算开');
  assert.equal(cfg.engines.length, 1);
});

test('Key 不进备份：备份构建只读用户快照，不读 tts-engines.json', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/backup-build.ts'), 'utf-8');
  assert.equal(src.includes('tts-engines.json'), false, '备份链路不得引用 TTS 引擎文件（Key 不外发）');
});
