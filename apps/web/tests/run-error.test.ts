/**
 * `#226`：`/api/run` 失败时，界面上必须说清**为什么**，而不只是一串分类标签。
 *
 * 起因（用户实测）：百草路（https://m.baicaolu.com）发现页一直显示 `NETWORK@request`，
 * 但浏览器能正常打开。真因是**站点证书链不完整**（只有叶子证书、没发中间证书）⇒
 * Node/OpenSSL 校验失败（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`），浏览器靠 AIA 补全所以能开。
 * 服务端**早就**把这个原因放在 `detail.input` 里了，前端 `runAction` 却只抛 `j.error` ⇒ 原因被丢掉。
 *
 * ★ 防空转：只断言「字符串变长」是不够的（随便拼点东西也能变长）。
 *   所以下面同时断言「标签在前、原因在后」与「非证书类不追加证书说明」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRunError } from '../src/api';

const CERT_BODY = {
  error: 'NETWORK@request',
  detail: { input: 'TLS 证书链无法验证（站点证书问题）' },
};

test('#226 ① 证书类：标签 + 人话原因 + 一句用户能懂的解释', () => {
  const s = describeRunError(CERT_BODY, 502);
  assert.ok(s.startsWith('NETWORK@request · '), `标签必须在最前（实际：${s}）`);
  assert.ok(s.includes('TLS 证书链无法验证（站点证书问题）'), '必须带上服务端给的原因');
  assert.ok(/浏览器会自动补全/.test(s), '证书类必须补一句「浏览器能开、引擎打不开」的解释');
  assert.ok(!/忽略证书/.test(s), '不要引导用户去关证书校验（安全妥协）');
});

test('#226 ② 非证书类：只补原因，**不**追加证书说明', () => {
  const s = describeRunError({ error: 'NETWORK@request', detail: { input: '域名解析失败' } }, 502);
  assert.equal(s, 'NETWORK@request · 域名解析失败');
});

test('#226 ③ 没有 detail.input 时保持原样（不能变成「xxx · undefined」）', () => {
  assert.equal(describeRunError({ error: 'RULE_PARSE@parse' }, 502), 'RULE_PARSE@parse');
  assert.equal(describeRunError(null, 502), '502');
});

test('#226 ④ 原因已经被标签包含时不去重（避免「A · A」）', () => {
  assert.equal(describeRunError({ error: '超时', detail: { input: '超时' } }, 502), '超时');
});
