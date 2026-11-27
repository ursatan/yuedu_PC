/**
 * `#208` 源分享口令：encode/decode 纯函数单测。
 *
 * 上游语义逐条对照 `SourceSharePassphrase.kt`（2026-10-05 读源码提取）。
 * ★ 防空转约定：每个「拒绝」用例旁边都有能通过的对照（同函数、同格式、换参数），
 *   证明链路本来是通的，不是断言写错导致恒真/恒假。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SOURCE_SHARE_PREFIX,
  SOURCE_SHARE_CUSTOM_WORD,
  canEncodeSourceShareUrl,
  encodeSourceSharePassphrase,
  decodeSourceSharePassphrase,
  SOURCE_SHARE_TYPES,
  sourceShareExpiresAt,
  SOURCE_SHARE_MAX_EXPIRY_DAYS,
} from '../source-share-passphrase';

const T0 = 1_790_000_000_000; // 固定「当前时间」，避免用例依赖真实时钟

test('#208 encode → decode 往返：url/类型/过期/尾词逐字段还原', () => {
  const url = 'https://shuyuan.mgz6.com/shuyuan/abc123.json';
  const pass = encodeSourceSharePassphrase(url, 'sy', 30, T0);
  assert.ok(pass.startsWith(SOURCE_SHARE_PREFIX), '口令以上游前缀开头');
  assert.ok(pass.endsWith(`¥${SOURCE_SHARE_CUSTOM_WORD}^`), '尾段 = ¥Legado^');

  const r = decodeSourceSharePassphrase(pass, T0 + 1000);
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.value.url, url, '混淆必须可逆还原原 url');
  assert.equal(r.value.type, 'sy');
  // 过期 = T0 + 30 天（毫秒）；decode 侧从 7 位 token ×1e6 还原，秒级精度
  assert.equal(r.value.expiresAt, Math.floor((T0 + 30 * 86400_000) / 1_000_000) * 1_000_000);
  assert.equal(r.value.customWord, 'Legado');
});

test('#208 混淆映射逐组可逆：. / % json com cn net 数字 全走一遍', () => {
  // 故意覆盖 17 组映射里能同时出现在合法 url 的部分
  const url = 'https://a.b.com:8080/x%20y/z.json?n=40560#frag.zip';
  const pass = encodeSourceSharePassphrase(url, 'sy', 0, T0);
  const r = decodeSourceSharePassphrase(pass, T0);
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.value.url, url, '含 查询/转义/片段 的 url 也要原样还原');
  assert.equal(r.value.expiresAt, 0, 'expiryDays=0 ⇒ 永久（token = "0"）');
});

test('#208 手工替身口令可解（证明 decode 认全部替身，与上游产物互认的根据）', () => {
  // 不依赖上游随机序列：手工把 url 每段换成映射表中的替身（每组任选其一），
  // decode 必须能反查 —— 这就是「上游生成的口令本端能解」的等价证明。
  const pass = `${SOURCE_SHARE_PREFIX}#L:shuyuan电mgz6电🛜1杠shuyuan杠abc电串！sy©0¥Legado^`;
  const r = decodeSourceSharePassphrase(pass, T0);
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.value.url, 'https://shuyuan.mgz6.com/shuyuan/abc.json');
});

test('#208 过期判定：过期 ⇒ expired；未过期与永久不受影响', () => {
  const pass1 = encodeSourceSharePassphrase('https://a.com/1.json', 'sy', 1, T0);
  assert.equal(decodeSourceSharePassphrase(pass1, T0 + 2 * 86400_000).kind, 'expired', '1 天后 ⇒ 过期');
  assert.equal(decodeSourceSharePassphrase(pass1, T0).kind, 'success', '有效期内 ⇒ 正常');

  const pass0 = encodeSourceSharePassphrase('https://a.com/1.json', 'sy', 0, T0);
  assert.equal(decodeSourceSharePassphrase(pass0, T0 + 365 * 86400_000).kind, 'success', '永久 ⇒ 永不过期');

  const pass30 = encodeSourceSharePassphrase('https://a.com/1.json', 'sy', 30, T0);
  assert.equal(decodeSourceSharePassphrase(pass30, T0 + 29 * 86400_000).kind, 'success', '第 29 天 ⇒ 仍在有效期');
});

test('#208 非口令输入：not-found / invalid（旁边各有 success 对照防断言恒真）', () => {
  assert.equal(decodeSourceSharePassphrase('普通剪贴板文本').kind, 'not-found');
  // 对照：真口令在同函数下是 success
  const pass = encodeSourceSharePassphrase('https://a.com/1.json', 'sy', 0, T0);
  assert.equal(decodeSourceSharePassphrase(pass).kind, 'success');

  // 前缀在但结构残缺 ⇒ invalid（缺切分符）
  assert.equal(decodeSourceSharePassphrase(`${SOURCE_SHARE_PREFIX}没有结构`).kind, 'invalid');
  // 未知类型码 ⇒ invalid（对照：sy 可过）
  assert.equal(
    decodeSourceSharePassphrase(`${SOURCE_SHARE_PREFIX}#L:a.com！zz©0¥Legado^`).kind,
    'invalid',
  );
  // url 不合法（无 host）⇒ invalid（对照：有 host 可过）
  assert.equal(
    decodeSourceSharePassphrase(`${SOURCE_SHARE_PREFIX}#L:！sy©0¥Legado^`).kind,
    'invalid',
  );
  // 过期戳位数不合法（2 位）⇒ invalid
  assert.equal(
    decodeSourceSharePassphrase(`${SOURCE_SHARE_PREFIX}#L:a电com！sy©12¥Legado^`).kind,
    'invalid',
  );
});

test('#208 canEncode：保留字符与非 http(s) 拒绝（各有可编码对照）', () => {
  assert.equal(canEncodeSourceShareUrl('https://a.com/x！y.json'), false, '含切分符 ！ ⇒ 拒');
  assert.equal(canEncodeSourceShareUrl('ftp://a.com/x.json'), false, '非 http(s) ⇒ 拒');
  assert.equal(canEncodeSourceShareUrl('https://a.com'), true, '无路径但 host 在 ⇒ 允许（上游只查 host）');
  assert.equal(canEncodeSourceShareUrl('https://a.com/x.json'), true, '对照：普通 url 可编码');
});

test('#208 类型代码表与上游一字不差（7 种）', () => {
  assert.deepEqual(Object.values(SOURCE_SHARE_TYPES).sort(), ['dy', 'jh', 'ld', 'ml', 'rw', 'sy', 'zd']);
});

test('#208 同 url 同时刻 ⇒ 同口令（种子=时间，可复现）；不同时刻口令不同但都可解', () => {
  const url = 'https://a.com/b.json';
  const p1 = encodeSourceSharePassphrase(url, 'sy', 7, T0);
  const p2 = encodeSourceSharePassphrase(url, 'sy', 7, T0);
  assert.equal(p1, p2, '同种子可复现');
  const p3 = encodeSourceSharePassphrase(url, 'sy', 7, T0 + 1);
  assert.notEqual(p1, p3, '不同种子 ⇒ 替身选择可不同');
  for (const p of [p1, p3]) {
    assert.equal(decodeSourceSharePassphrase(p, T0).kind, 'success', '替身怎么选都要能解');
  }
});

test('#208 过期戳历史长度兼容：10 位（秒）与 13 位（毫秒）token', () => {
  // 10 位 = 毫秒/1000（秒级历史格式）
  const secs = String(Math.floor((T0 + 86400_000) / 1000)); // 10 位
  const r10 = decodeSourceSharePassphrase(`${SOURCE_SHARE_PREFIX}#L:a电com！sy©${secs}¥Legado^`, T0);
  assert.equal(r10.kind, 'success');
  // 13 位 = 毫秒原值
  const ms = String(T0 + 86400_000);
  const r13 = decodeSourceSharePassphrase(`${SOURCE_SHARE_PREFIX}#L:a电com！sy©${ms}¥Legado^`, T0);
  assert.equal(r13.kind, 'success');
  // 对照：7 位也过（encode 主路径产物）
  const p7 = encodeSourceSharePassphrase('https://a.com/1.json', 'sy', 1, T0);
  assert.equal(decodeSourceSharePassphrase(p7, T0).kind, 'success');
});

test('#208 sourceShareExpiresAt：与口令内实际携带的时间**逐毫秒一致**（不各算一遍）', () => {
  // 0 = 永久
  assert.equal(sourceShareExpiresAt(0, T0), 0);
  // 与 encode 里写进 token 的值同源：decode 还原出来必须等于它（精度 1e6）
  for (const days of [1, 7, 30, 365]) {
    const at = sourceShareExpiresAt(days, T0);
    const pass = encodeSourceSharePassphrase('https://a.com/1.json', 'sy', days, T0);
    const r = decodeSourceSharePassphrase(pass, T0);
    assert.equal(r.kind, 'success');
    if (r.kind !== 'success') continue;
    assert.equal(r.value.expiresAt, at, `${days} 天：界面显示的时间必须与口令里的一致`);
  }
  // 超上限按上限收（对齐 encode 的 clamp）
  assert.equal(
    sourceShareExpiresAt(SOURCE_SHARE_MAX_EXPIRY_DAYS + 999, T0),
    sourceShareExpiresAt(SOURCE_SHARE_MAX_EXPIRY_DAYS, T0),
  );
  // 负数按 0（永久）
  assert.equal(sourceShareExpiresAt(-5, T0), 0);
});
