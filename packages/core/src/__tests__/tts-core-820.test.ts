/**
 * `#820` B2 第一批：TTS 内核（配置归一 / 分段 / 请求构造 / 音频类型）单测。
 *
 * 覆盖「用户拍板的两个语义」：
 *  · **默认关**：没显式 `true` 一律关（含 `"true"` / `1` 这种「看起来像开」的脏数据）；
 *  · **`@js:` 允许但默认折叠**：配置能存能跑，判定函数（`isTtsJsRule`）供 UI 折叠。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTtsRequest,
  clampTtsSpeed,
  deriveTtsEngineId,
  isTtsJsRule,
  normalizeTtsConfigFile,
  normalizeTtsEngine,
  normalizeTtsSettings,
  parseTtsConcurrentRate,
  parseTtsHeader,
  resolveTtsAudioType,
  segmentTtsText,
  sniffAudioContentType,
  type TtsJsEvaluator,
} from '../tts';

/** 测试用求值器：用 `new Function` 模拟沙箱（只给绑定，不给 java/require） */
const evalJs: TtsJsEvaluator = (code, bindings) => {
  try {
    const keys = Object.keys(bindings);
    const fn = new Function(...keys, `return (${code});`);
    const v = fn(...keys.map((k) => bindings[k]));
    return { ok: true, value: v == null ? '' : String(v) };
  } catch (e) {
    return { ok: false, code: 'TTS_JS_ERROR', message: e instanceof Error ? e.message : String(e) };
  }
};

test('normalizeTtsEngine：默认关 + 稳定 id + Legado 同名字段', () => {
  const r = normalizeTtsEngine({
    name: ' 本地 TTS ',
    url: 'https://api.test/tts?text={{speakText}}',
    header: 'Authorization: Bearer k\nX-Trace: 1',
    jsLib: 'function f(){return 1}',
    loginUrl: 'https://api.test/login',
    concurrentRate: '1/1500',
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.engine.name, '本地 TTS');
  assert.equal(r.engine.enabled, false, '没写 enabled ⇒ 必须关');
  assert.equal(r.engine.id, deriveTtsEngineId('本地 TTS', 'https://api.test/tts?text={{speakText}}'));
  assert.equal(parseTtsHeader(r.engine.header)['Authorization'], 'Bearer k');
  assert.equal(r.engine.concurrentRate, '1/1500');
  assert.equal(r.engine.loginUrl, 'https://api.test/login');

  const on = normalizeTtsEngine({ name: 'a', url: 'https://a.test/', enabled: true });
  assert.equal(on.ok && on.engine.enabled, true, '显式 true ⇒ 开');
  const dirty = normalizeTtsEngine({ name: 'a', url: 'https://a.test/', enabled: 'true' });
  assert.equal(dirty.ok && dirty.engine.enabled, false, '字符串 "true" 不算开');
});

test('normalizeTtsEngine：配置错误逐项报出（不静默补默认）', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ url: 'https://a.test/' }, 'NAME_REQUIRED'],
    [{ name: 'a' }, 'URL_REQUIRED'],
    [{ name: 'a', url: '/relative/tts' }, 'URL_INVALID'],
    [{ name: 'a', url: 'ftp://a.test/' }, 'URL_INVALID'],
    [{ name: 'a', url: 'https://a.test/', contentType: 'text/html' }, 'CONTENT_TYPE_INVALID'],
    [{ name: 'a', url: 'https://a.test/', method: 'PUT' }, 'METHOD_INVALID'],
    [{ name: 'a', url: 'https://a.test/', header: 'not a header line' }, 'HEADER_INVALID'],
    [{ name: 'a', url: 'https://a.test/', timeoutMs: 99999 }, 'TIMEOUT_INVALID'],
    [{ name: 'a', url: 'https://a.test/', id: '带 空格' }, 'ID_INVALID'],
  ];
  for (const [input, code] of cases) {
    const r = normalizeTtsEngine(input);
    assert.equal(r.ok, false, `${code} 应被拒`);
    if (!r.ok) assert.equal(r.error, code);
  }
  // 对照：`@js:` 形态是允许的（但 UI 默认折叠）
  const js = normalizeTtsEngine({ name: 'j', url: "@js:'https://a.test/t?x='+speakText" });
  assert.equal(js.ok, true);
  assert.equal(js.ok && isTtsJsRule(js.engine.url), true);
});

test('normalizeTtsConfigFile：读时容错 + 默认关 + 默认引擎自愈', () => {
  const cfg = normalizeTtsConfigFile({
    enabled: 'true',
    defaultEngineId: 'tts-missing',
    engines: [
      { name: 'ok', url: 'https://a.test/', enabled: true },
      { name: '', url: 'https://bad.test/' },
      { name: 'ok2', url: 'https://a.test/' },
    ],
  });
  assert.equal(cfg.enabled, false, '整体开关只认严格 true');
  assert.equal(cfg.engines.length, 2, '坏条目丢弃，其余合法条目保留');
  // 两条合法但 name+url 相同的引擎：id 相同 ⇒ 去重
  const dup = normalizeTtsConfigFile({
    engines: [{ name: '合成', url: 'https://a.test/' }, { name: '合成', url: 'https://a.test/' }],
  });
  assert.equal(dup.engines.length, 1);
  // 默认引擎指向不存在的条目 ⇒ 置空
  assert.equal(cfg.defaultEngineId, '');
});

test('normalizeTtsSettings：默认引擎必须存在', () => {
  const cur = normalizeTtsConfigFile({ engines: [{ name: 'a', url: 'https://a.test/' }] });
  const ok = normalizeTtsSettings({ enabled: true, defaultEngineId: cur.engines[0]!.id }, cur);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.config.enabled, true);
  const bad = normalizeTtsSettings({ defaultEngineId: 'tts-nope' }, cur);
  assert.equal(bad.ok, false);
});

test('segmentTtsText：偏移可切片 + 空白只在边界裁剪 + 纯标点不读', () => {
  const text = '第一句话。第二句话！\n\n……\n第三句很短。';
  const r = segmentTtsText(text, { maxChars: 240 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  for (const s of r.segments) {
    assert.equal(text.slice(s.start, s.end), s.text, '偏移必须能原样切片');
    assert.equal(s.text.trim(), s.text);
    assert.ok(s.text.length > 0);
    assert.ok(!/^(?:……|。)$/.test(s.text));
  }
  const joined = r.segments.map((s) => s.text).join('');
  assert.equal(joined.replace(/\s/g, ''), text.replace(/\s/g, ''), '不吞字符');
  assert.equal(r.segments[0]!.index, 0);
});

test('segmentTtsText：超长无标点串按上限硬切', () => {
  const text = '字'.repeat(300);
  const r = segmentTtsText(text, { maxChars: 100 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.segments.length >= 3);
  for (const s of r.segments) assert.ok(s.text.length <= 100, `单段超过上限：${s.text.length}`);
  assert.equal(r.segments.map((s) => s.text).join(''), text);
});

test('segmentTtsText：空文本 / 超长输入给出明确失败码', () => {
  const empty = segmentTtsText('  \n ');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, 'TTS_TEXT_EMPTY');
  const huge = segmentTtsText('字'.repeat(50000));
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.equal(huge.code, 'TTS_TEXT_TOO_LONG');
});

test('buildTtsRequest：{{}} 插值 + 语速钳制 + GET', async () => {
  const engine = normalizeTtsEngine({
    name: 'a',
    url: 'https://a.test/tts?text={{speakText.trim()}}&speed={{speakSpeed}}',
  });
  assert.equal(engine.ok, true);
  if (!engine.ok) return;
  const r = await buildTtsRequest(engine.engine, ' 你好 ', { speed: 9, evalJs });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.speed, 5, '语速上限 5.0（对齐上游 ttsSpeechRate 0~45）');
  assert.equal(r.request.method, 'GET');
  assert.match(r.request.url, /text=%E4%BD%A0%E5%A5%BD/);
  assert.match(r.request.url, /speed=50/, 'speakSpeed 绑定必须是上游口径的整数 5~50');
});

test('buildTtsRequest：@js: 形态 + result 绑定', async () => {
  const engine = normalizeTtsEngine({
    name: 'j',
    url: "@js:'https://a.test/t?x='+encodeURIComponent(speakText)+'&y=1'",
  });
  assert.equal(engine.ok, true);
  if (!engine.ok) return;
  const r = await buildTtsRequest(engine.engine, '你好', { evalJs });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.request.url, 'https://a.test/t?x=%E4%BD%A0%E5%A5%BD&y=1');
});

test('buildTtsRequest：POST + 选项尾巴覆盖 method/body/headers', async () => {
  const engine = normalizeTtsEngine({
    name: 'p',
    url: 'https://a.test/tts,{"method":"POST","body":"{\\"text\\":\\"{{speakText}}\\"}","headers":{"X-Opt":"1"}}',
    method: 'POST',
    headers: { 'X-Base': 'b' },
  });
  assert.equal(engine.ok, true);
  if (!engine.ok) return;
  const r = await buildTtsRequest(engine.engine, 'hi', { evalJs });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.request.method, 'POST');
  assert.equal(r.request.body, '{"text":"hi"}');
  assert.equal(r.request.headers['X-Opt'], '1');
  assert.equal(r.request.headers['X-Base'], 'b');
});

test('buildTtsRequest：文本为空 / 过长 / JS 失败 / URL 非绝对 都有明确失败码', async () => {
  const base = { name: 'a', url: 'https://a.test/tts?t={{speakText}}' };
  const ok = normalizeTtsEngine(base);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;

  const empty = await buildTtsRequest(ok.engine, ' ', { evalJs });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, 'TTS_TEXT_EMPTY');

  const tooLong = await buildTtsRequest(ok.engine, '字'.repeat(5001), { evalJs });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.code, 'TTS_TEXT_TOO_LONG');

  const boom: TtsJsEvaluator = () => ({ ok: false, code: 'TTS_JS_TIMEOUT', message: 'timeout' });
  const jsFail = await buildTtsRequest(ok.engine, 'hi', { evalJs: boom });
  assert.equal(jsFail.ok, false);
  if (!jsFail.ok) assert.equal(jsFail.code, 'TTS_JS_TIMEOUT');

  const rel = normalizeTtsEngine({ name: 'r', url: "@js:'/relative?t='+speakText" });
  assert.equal(rel.ok, true);
  if (!rel.ok) return;
  const bad = await buildTtsRequest(rel.engine, 'hi', { evalJs });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'TTS_URL_INVALID');
});

test('clampTtsSpeed：0.5~5.0，非法回落 1.0', () => {
  assert.equal(clampTtsSpeed(undefined), 1);
  assert.equal(clampTtsSpeed(0.2), 0.5);
  assert.equal(clampTtsSpeed(3), 3);
  assert.equal(clampTtsSpeed(9), 5);
  assert.equal(clampTtsSpeed('x'), 1);
});

test('#873 对齐上游：pauseDuration / loginUi / loginCheckJs / enabledCookieJar / concurrentRate', () => {
  const ok = normalizeTtsEngine({
    name: 'align',
    url: 'https://a.test/tts',
    pauseDuration: 1200,
    loginUi: '[{"name":"账号","type":"text"}]',
    loginCheckJs: 'return ""',
    enabledCookieJar: true,
    concurrentRate: '1/1500',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.engine.pauseDuration, 1200);
  assert.equal(ok.engine.loginUi, '[{"name":"账号","type":"text"}]');
  assert.equal(ok.engine.loginCheckJs, 'return ""');
  assert.equal(ok.engine.enabledCookieJar, true);
  assert.equal(ok.engine.concurrentRate, '1/1500');

  // 默认关：Cookie 罐/段间静音都不能凭「看起来像」被打开
  const def = normalizeTtsEngine({ name: 'plain', url: 'https://b.test/tts', enabled: 'true', enabledCookieJar: 'true' });
  assert.equal(def.ok, true);
  if (!def.ok) return;
  assert.equal(def.engine.enabled, false);
  assert.equal(def.engine.enabledCookieJar, undefined);
  assert.equal(def.engine.pauseDuration, undefined);

  const badPause = normalizeTtsEngine({ name: 'p', url: 'https://c.test/tts', pauseDuration: 20000 });
  assert.equal(badPause.ok, false);
  if (!badPause.ok) assert.equal(badPause.error, 'PAUSE_INVALID');

  const badUi = normalizeTtsEngine({ name: 'u', url: 'https://d.test/tts', loginUi: 'not json' });
  assert.equal(badUi.ok, false);
  if (!badUi.ok) assert.equal(badUi.error, 'LOGIN_UI_INVALID');

  const badRate = normalizeTtsEngine({ name: 'r', url: 'https://e.test/tts', concurrentRate: 'nope' });
  assert.equal(badRate.ok, false);
  if (!badRate.ok) assert.equal(badRate.error, 'CONCURRENT_RATE_INVALID');
});

test('#873 concurrentRate 解析：1/1500 与纯毫秒，非法给 null', () => {
  assert.equal(parseTtsConcurrentRate('1/1500'), 1500);
  assert.equal(parseTtsConcurrentRate('1500'), 1500);
  assert.equal(parseTtsConcurrentRate('0'), 0);
  assert.equal(parseTtsConcurrentRate(''), 0);
  assert.equal(parseTtsConcurrentRate('nope'), null);
});

test('audio：魔术字节优先，其次上游/配置', () => {
  assert.equal(sniffAudioContentType(new Uint8Array([0x49, 0x44, 0x33, 0x04])), 'audio/mpeg');
  assert.equal(sniffAudioContentType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), 'audio/wav');
  assert.equal(sniffAudioContentType(new Uint8Array([0x4f, 0x67, 0x67, 0x53])), 'audio/ogg');
  assert.equal(sniffAudioContentType(new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70])), 'audio/mp4');
  assert.equal(sniffAudioContentType(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c])), null);

  const r1 = resolveTtsAudioType({ bytes: new Uint8Array([0x49, 0x44, 0x33]), upstream: 'text/html' });
  assert.equal(r1.contentType, 'audio/mpeg', '字节是真音频时压过错误的头');
  const r2 = resolveTtsAudioType({ bytes: new Uint8Array([0x01, 0x02, 0x03, 0x04]), upstream: 'audio/ogg; charset=x' });
  assert.equal(r2.contentType, 'audio/ogg');
  const r3 = resolveTtsAudioType({ bytes: new Uint8Array([0x01, 0x02]), configured: 'audio/wav' });
  assert.equal(r3.contentType, 'audio/wav');
  assert.equal(r3.trusted, false, '回退到配置时标记为不可信');
});
