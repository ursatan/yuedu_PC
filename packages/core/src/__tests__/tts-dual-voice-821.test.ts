/**
 * `#821` 双音色内核回归。
 *
 * 用户拍板的语义：
 *  · 一条引擎两个槽：主槽 = 顶层字段（Legado `HttpTTS` 同名），副槽 = `secondary`（字段同名）；
 *  · **默认关**（`dualVoice` 缺省 false）；关掉时请求与 `#822` 单音色**逐字节一致**；
 *  · **副槽没配** ⇒ 走副槽时自动回退主槽（`fellBack=true`），不报错、不静音；
 *  · 切换持久化：`activeVoice` 关掉双音色后仍保留，下次开启回到上次选择。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTtsRequest,
  hasTtsSecondaryVoice,
  normalizeTtsConfigFile,
  normalizeTtsEngine,
  normalizeTtsSettings,
  resolveTtsVoice,
  type TtsJsEvaluator,
} from '../tts';

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

test('#821 副槽归一：同名子字段 + 未填 url 继承主槽 + name 单独不算配置', () => {
  const r = normalizeTtsEngine({
    name: '双音色引擎',
    url: 'https://a.test/tts?text={{speakText}}',
    header: 'Authorization: Bearer k',
    timeoutMs: 8000,
    secondary: {
      name: '对话',
      url: 'https://b.test/tts?text={{speakText}}&voice=2',
      header: 'X-Voice: 2',
      timeoutMs: 5000,
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.engine.secondary?.name, '对话');
  assert.equal(r.engine.secondary?.url, 'https://b.test/tts?text={{speakText}}&voice=2');
  assert.equal(r.engine.secondary?.timeoutMs, 5000);
  assert.equal(hasTtsSecondaryVoice(r.engine), true);

  // 只填 name/remark ⇒ 视为「没配副音色」（避免界面出现一个和主槽一模一样的假副槽）
  const labelOnly = normalizeTtsEngine({
    name: '只配了标签',
    url: 'https://a.test/',
    secondary: { name: '旁白', remark: '只是备注' },
  });
  assert.equal(labelOnly.ok, true);
  if (labelOnly.ok) {
    assert.equal(labelOnly.engine.secondary, undefined);
    assert.equal(hasTtsSecondaryVoice(labelOnly.engine), false);
  }

  // url 留空 + 只改 header ⇒ 合法：合成时继承主槽地址
  const inherit = normalizeTtsEngine({
    name: '继承地址',
    url: 'https://a.test/',
    secondary: { header: 'X-Voice: 2' },
  });
  assert.equal(inherit.ok, true);
  if (inherit.ok) {
    assert.equal(inherit.engine.secondary?.url, undefined);
    assert.equal(hasTtsSecondaryVoice(inherit.engine), true);
  }
});

test('#821 副槽配置错误逐项报出（不静默丢）', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ secondary: 'x' }, 'VOICE2_INVALID'],
    [{ secondary: { url: '/relative/tts' } }, 'VOICE2_URL_INVALID'],
    [{ secondary: { contentType: 'text/html' } }, 'VOICE2_CONTENT_TYPE_INVALID'],
    [{ secondary: { method: 'PUT' } }, 'VOICE2_METHOD_INVALID'],
    [{ secondary: { header: 'not a header line' } }, 'VOICE2_HEADER_INVALID'],
    [{ secondary: { timeoutMs: 99999 } }, 'VOICE2_TIMEOUT_INVALID'],
  ];
  for (const [patch, code] of cases) {
    const r = normalizeTtsEngine({ name: 'a', url: 'https://a.test/', ...patch });
    assert.equal(r.ok, false, `${code} 应被拒`);
    if (!r.ok) assert.equal(r.error, code);
  }
});

test('#821 选槽：单音色与原来逐字节一致；副槽缺失回退主槽', async () => {
  const primary = normalizeTtsEngine({
    name: '引擎',
    url: 'https://a.test/tts?text={{speakText}}&speed={{speakSpeed}}',
    header: 'X-Common: 1',
    timeoutMs: 9000,
    secondary: { url: 'https://b.test/tts?text={{speakText}}&voice=2' },
  });
  assert.equal(primary.ok, true);
  if (!primary.ok) return;

  // ① 单音色：即使配了副槽也必须走主槽，且请求对象原样
  const single = resolveTtsVoice(primary.engine, { dualVoice: false, activeVoice: 'secondary' });
  assert.equal(single.slot, 'primary');
  assert.equal(single.fellBack, false);
  assert.equal(single.engine, primary.engine, '必须返回同一个对象（不改请求）');
  const reqSingle = await buildTtsRequest(single.engine, '你好', { speed: 1.2, evalJs });
  assert.equal(reqSingle.ok, true);
  if (reqSingle.ok) {
    assert.equal(reqSingle.request.url, 'https://a.test/tts?text=%E4%BD%A0%E5%A5%BD&speed=1.2');
    assert.equal(reqSingle.request.headers['X-Common'], '1');
  }

  // ② 双音色 + 主槽：仍走主槽，请求与单音色一致
  const dualPrimary = resolveTtsVoice(primary.engine, { dualVoice: true, activeVoice: 'primary' });
  assert.equal(dualPrimary.slot, 'primary');
  assert.equal(dualPrimary.fellBack, false);
  const reqDualPrimary = await buildTtsRequest(dualPrimary.engine, '你好', { speed: 1.2, evalJs });
  assert.equal(reqDualPrimary.ok, true);
  if (reqDualPrimary.ok && reqSingle.ok) {
    assert.deepEqual(reqDualPrimary.request, reqSingle.request, '主槽请求必须与单音色完全一致');
  }

  // ③ 双音色 + 副槽：用副槽 url，并继承主槽未填的 header/timeout
  const dualSecondary = resolveTtsVoice(primary.engine, { dualVoice: true, activeVoice: 'secondary' });
  assert.equal(dualSecondary.slot, 'secondary');
  assert.equal(dualSecondary.fellBack, false);
  assert.equal(dualSecondary.engine.url, 'https://b.test/tts?text={{speakText}}&voice=2');
  assert.equal(dualSecondary.engine.header, 'X-Common: 1', '副槽没填 header ⇒ 继承主槽');
  assert.equal(dualSecondary.engine.timeoutMs, 9000, '副槽没填 timeout ⇒ 继承主槽');
  assert.equal(dualSecondary.engine.name, '引擎', '引擎名不能被槽位名覆盖');
  assert.equal(dualSecondary.engine.id, primary.engine.id);
  const reqDualSecondary = await buildTtsRequest(dualSecondary.engine, '你好', { speed: 1.2, evalJs });
  assert.equal(reqDualSecondary.ok, true);
  if (reqDualSecondary.ok) {
    assert.match(reqDualSecondary.request.url, /https:\/\/b\.test\//);
  }
});

test('#821 副槽缺失：任何走副槽的路径都回退主槽（不报错）', () => {
  const noSecondary = normalizeTtsEngine({
    name: '只有主槽',
    url: 'https://a.test/',
  });
  assert.equal(noSecondary.ok, true);
  if (!noSecondary.ok) return;
  const r = resolveTtsVoice(noSecondary.engine, { dualVoice: true, activeVoice: 'secondary' });
  assert.equal(r.slot, 'primary');
  assert.equal(r.fellBack, true, '回退必须被标记，界面可以提示');
  assert.equal(r.engine, noSecondary.engine);
  assert.equal(hasTtsSecondaryVoice(noSecondary.engine), false);
});

test('#821 配置落盘：双音色默认关、槽位默认主、脏槽位回主', () => {
  const empty = normalizeTtsConfigFile(null);
  assert.equal(empty.dualVoice, false);
  assert.equal(empty.activeVoice, 'primary');

  const dirty = normalizeTtsConfigFile({
    enabled: true,
    dualVoice: 'true', // 只认严格 true
    activeVoice: 'sideways',
    engines: [{ name: 'a', url: 'https://a.test/', secondary: { url: 'https://b.test/' } }],
  });
  assert.equal(dirty.enabled, true);
  assert.equal(dirty.dualVoice, false);
  assert.equal(dirty.activeVoice, 'primary');
  assert.equal(dirty.engines[0]?.secondary?.url, 'https://b.test/');
});

test('#821 设置面：开关/槽位可单独更新；关掉双音色保留上次槽位', () => {
  const cur = normalizeTtsConfigFile({
    engines: [{ name: 'a', url: 'https://a.test/', secondary: { url: 'https://b.test/' } }],
  });
  const on = normalizeTtsSettings({ dualVoice: true, activeVoice: 'secondary' }, cur);
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.config.dualVoice, true);
  assert.equal(on.config.activeVoice, 'secondary');
  assert.equal(on.config.enabled, false, '双音色开关不影响总开关（三层门禁不变）');

  // 关掉双音色：只改开关，槽位必须保留（下次打开回到上次选择）
  const off = normalizeTtsSettings({ dualVoice: false }, on.config);
  assert.equal(off.ok, true);
  if (!off.ok) return;
  assert.equal(off.config.dualVoice, false);
  assert.equal(off.config.activeVoice, 'secondary');

  const bad = normalizeTtsSettings({ activeVoice: 'main' }, cur);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error, 'VOICE_SLOT_INVALID');
});
