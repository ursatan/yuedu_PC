/**
 * `#821` 设置页粘贴解析：一条 Legado `HttpTTS` JSON 里带副音色槽时也能整条粘进来。
 *
 * canonical 字段是 `secondary`（字段与主槽同名）；同时兼容别名 `voice2`。
 * 单音色 JSON（没有 secondary）必须维持原行为 —— 不凭空造副槽。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTtsEngineJson } from '../src/utils/tts';

test('#821 粘贴 secondary：字段与主槽同名，整条落地', () => {
  const r = parseTtsEngineJson(JSON.stringify({
    name: '双音色',
    url: 'https://a.test/tts?text={{speakText}}',
    contentType: 'audio/mpeg',
    header: 'X-Common: 1',
    secondary: {
      name: '对话',
      url: 'https://b.test/tts?text={{speakText}}&voice=2',
      contentType: 'audio/ogg',
      method: 'POST',
      body: '{"text":"{{speakText}}"}',
      header: 'X-Voice: 2',
      jsLib: 'var x = 1;',
      timeoutMs: 5000,
      remark: '第二音色',
      headers: { 'X-Extra': '1' },
    },
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.engine.secondary?.name, '对话');
  assert.equal(r.engine.secondary?.url, 'https://b.test/tts?text={{speakText}}&voice=2');
  assert.equal(r.engine.secondary?.contentType, 'audio/ogg');
  assert.equal(r.engine.secondary?.method, 'POST');
  assert.equal(r.engine.secondary?.body, '{"text":"{{speakText}}"}');
  assert.equal(r.engine.secondary?.header, 'X-Voice: 2');
  assert.equal(r.engine.secondary?.jsLib, 'var x = 1;');
  assert.equal(r.engine.secondary?.timeoutMs, 5000);
  assert.equal(r.engine.secondary?.headers?.['X-Extra'], '1');
});

test('#821 粘贴 voice2 别名（兼容旧草稿）', () => {
  const r = parseTtsEngineJson(JSON.stringify({
    name: '别名',
    url: 'https://a.test/',
    voice2: { url: 'https://b.test/', name: '副' },
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.engine.secondary?.url, 'https://b.test/');
});

test('#821 单音色 JSON 粘贴后仍然没有副槽（回归）', () => {
  const r = parseTtsEngineJson(JSON.stringify({
    name: '单音色',
    url: 'https://a.test/tts?text={{speakText}}',
    contentType: 'audio/mpeg',
    header: 'Authorization: Bearer k',
    jsLib: '',
    loginUrl: '',
    concurrentRate: '',
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.engine.secondary, undefined);
  assert.equal(r.engine.name, '单音色');
  assert.equal(r.engine.contentType, 'audio/mpeg');
});

test('#821 secondary 不是对象 ⇒ 明确报错，不静默吞', () => {
  const r = parseTtsEngineJson(JSON.stringify({
    name: '坏配置',
    url: 'https://a.test/',
    secondary: 'https://b.test/',
  }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /副音色/);
});
