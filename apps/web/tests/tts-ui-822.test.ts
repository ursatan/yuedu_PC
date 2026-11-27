/**
 * `#822` B2 HTTP TTS Web 接线的纯逻辑回归锁（不碰 fetch / DOM / Audio）。
 *
 * 钉三件事：
 *  · 失败码 → 人话（用户明确要求不能只弹「失败」）；
 *  · Legado `HttpTTS` JSON 粘贴的三种外壳与必填校验；
 *  · 阅读页分段用的偏移与原文一致（否则高亮/续读会整体漂移，而且**静默**）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeTtsError, parseTtsEngineJson, segmentForReadAloud } from '../src/utils/tts';

test('#822 已知失败码都有一句人话（超时 / 限流 / 非音频）', () => {
  assert.match(describeTtsError('TTS_HTTP_TIMEOUT'), /超时/);
  assert.match(describeTtsError('TTS_CONTENT_TYPE', '', 'text/html; <html>'), /不是音频/);
  assert.match(
    describeTtsError('TTS_CONTENT_TYPE', '', 'HTTP 529 rate limit exceeded'),
    /限流/,
    '限流特征优先于笼统的「不是音频」',
  );
  assert.match(describeTtsError('TTS_HTTP_STATUS', '', 'HTTP 500'), /500/);
  assert.match(describeTtsError('TTS_TOTALLY_UNKNOWN', '服务端原话'), /服务端原话/);
});

test('#822 粘贴 Legado HttpTTS：数组只取第一条并提示', () => {
  const r = parseTtsEngineJson(JSON.stringify([
    { name: '甲', url: 'https://a.example/tts?text={{speakText}}', header: 'UA: x', enabled: true, timeoutMs: 3000 },
    { name: '乙', url: 'https://b.example/tts' },
  ]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.engine.name, '甲');
  assert.equal(r.engine.enabled, true);
  assert.equal(r.engine.header, 'UA: x');
  assert.equal(r.engine.timeoutMs, 3000);
  assert.match(r.note, /只填入了第 1 条/);
});

test('#822 粘贴 Legado HttpTTS：`engines` 外壳与单对象都认', () => {
  const shell = parseTtsEngineJson(JSON.stringify({
    enabled: true,
    engines: [{ name: '在线', url: 'https://x.example/tts' }],
  }));
  assert.equal(shell.ok, true);
  if (shell.ok) assert.equal(shell.engine.name, '在线');

  const single = parseTtsEngineJson(JSON.stringify({ name: '单条', url: 'https://y.example/tts' }));
  assert.equal(single.ok, true);
  if (single.ok) {
    assert.equal(single.engine.enabled, false, 'enabled 缺省必须是 false（默认关）');
  }
});

test('#822 粘贴非法 JSON / 缺必填项都给明确原因', () => {
  assert.match((parseTtsEngineJson('not json') as { error: string }).error, /不是合法 JSON/);
  assert.match((parseTtsEngineJson('{"url":"https://x"}') as { error: string }).error, /缺少 name/);
  assert.match((parseTtsEngineJson('{"name":"x"}') as { error: string }).error, /缺少 url/);
});

test('#822 阅读页分段：offset 指回原串，拼起来不丢正文', () => {
  const text = '第一句。第二句！' + '长'.repeat(300) + '。末尾。';
  const segs = segmentForReadAloud(text);
  assert.ok(segs.length >= 2, '超长句必须被切开，不能一次塞进一个请求');
  for (const s of segs) {
    assert.equal(s.text, text.slice(s.start, s.end), 'text 必须与 start/end 对应的原串一致');
  }
  const joined = segs.map((s) => s.text).join('');
  assert.equal(joined.replace(/\s/g, ''), text.replace(/\s/g, ''), '分段不能吞掉正文');
});

test('#822 空文本分段回空数组（由 store 回落客户端分句）', () => {
  assert.deepEqual(segmentForReadAloud('  \n 。'), []);
});
