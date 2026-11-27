/**
 * `#372` TLS 证书链 AIA 自动补全 —— 纯函数单测。
 *
 * AIA 补全的**完整链路**（tls.connect 拿链 → 下载中间证书 → 带 ca 重试）依赖真实
 * 站点与网络，不在单测覆盖范围（服务端冒烟覆盖）。这里只锁两件确定性的事：
 * ① 触发补全的错误码集合**必须包含**「链不完整」一族；
 * ② 触发补全的错误码集合**必须排除**过期/域名不匹配（补不了，照旧报错）——
 *    方向断言：如果有人日后把 CERT_HAS_EXPIRED 加进去，就是给过期证书「续命」，
 *    那是安全回归，必须在测试里炸出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_INCOMPLETE_TLS_CODES, derToPem, aiaIssuerUris, normDn } from '../net/tls-aia';

test('AIA 触发集：含「链不完整」一族（#372 用户报障的四类症状 + #377③ 百草露）', () => {
  for (const code of [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', // 51acgs 一族实测报的码
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_GET_ISSUER_CERT', // `#377③` 百草露实测报的码（补不全链 ⇒ 追到一半也是它）
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  ]) {
    assert.ok(CHAIN_INCOMPLETE_TLS_CODES.has(code), `${code} 应触发 AIA 补全`);
  }
});

test('AIA 触发集：排除过期/域名不匹配（补不了，保持原报错）', () => {
  assert.ok(!CHAIN_INCOMPLETE_TLS_CODES.has('CERT_HAS_EXPIRED'), '过期证书没有「补」的意义');
  assert.ok(!CHAIN_INCOMPLETE_TLS_CODES.has('ERR_TLS_CERT_ALTNAME_INVALID'), '域名不匹配补不了');
  assert.ok(!CHAIN_INCOMPLETE_TLS_CODES.has('ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED'));
});

test('derToPem：DER → PEM，base64 按 64 字符分行、头尾完整', () => {
  // 构造一段「DER 感」buffer（0x30 0x82 SEQUENCE 头 + 200 字节内容）
  const der = Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.alloc(200, 0xab)]);
  const pem = derToPem(der);
  const lines = pem.split('\n');
  assert.equal(lines[0], '-----BEGIN CERTIFICATE-----');
  assert.equal(lines[lines.length - 1], '-----END CERTIFICATE-----');
  // 内容行（去掉头尾与空行）每行 ≤64 字符，且全是 base64 字符
  const body = lines.slice(1, -1);
  for (const l of body) {
    assert.ok(l.length <= 64, `base64 行超长：${l.length}`);
    assert.match(l, /^[A-Za-z0-9+/]+={0,2}$/);
  }
  // 还原：拼接后必须等于原 DER 的 base64
  assert.equal(body.join(''), der.toString('base64'));
});

test('derToPem：短输入（不足一行）也不产生空行', () => {
  const pem = derToPem(Buffer.alloc(10, 0x01));
  const lines = pem.split('\n');
  assert.equal(lines.length, 3, '头 + 一行 base64 + 尾');
  assert.equal(lines[1], Buffer.alloc(10, 0x01).toString('base64'));
});

/* ── `#377③` 递归追链的判据（X509Certificate.infoAccess 是**字符串**，不是对象）── */

test('aiaIssuerUris：从 infoAccess 字符串抽 CA Issuers URI（#377③ 踩过的形态坑）', () => {
  // 真实形态（百草露 leaf）：字符串，不是 PeerCertificate 那种对象 map
  assert.deepEqual(aiaIssuerUris({ infoAccess: 'CA Issuers - URI:http://ye1.i.lencr.org/' }), [
    'http://ye1.i.lencr.org/',
  ]);
  // 多条（逗号分隔）+ 其它扩展混排
  assert.deepEqual(
    aiaIssuerUris({
      infoAccess: 'OCSP - URI:http://ocsp.example/, CA Issuers - URI:http://a.example/, CA Issuers - URI:https://b.example/x.crt',
    }),
    ['http://a.example/', 'https://b.example/x.crt'],
  );
  // 空/无扩展 ⇒ 空列表（调用方据此停链）
  assert.deepEqual(aiaIssuerUris({ infoAccess: '' }), []);
  assert.deepEqual(aiaIssuerUris({ infoAccess: null }), []);
  assert.deepEqual(aiaIssuerUris({}), []);
  // ⚠️ 若按对象键取（旧写法）会恒 undefined ⇒ 这里明确守住「必须是字符串解析」
  assert.deepEqual(aiaIssuerUris({ infoAccess: undefined as unknown as string }), []);
});

test('normDn：DN 归一化对「行序不同 / 空白不同」等价，对不同 DN 不等价', () => {
  assert.equal(normDn('C=US\nO=ISRG\nCN=Root YE'), normDn('CN=Root YE\nC=US\nO=ISRG'), '行序无关');
  assert.equal(normDn('C=US\nO=ISRG\nCN=Root YE'), normDn(' C=US \nO=ISRG\nCN=Root YE '), '首尾空白无关');
  assert.notEqual(normDn('CN=ISRG Root X2'), normDn('CN=ISRG Root X1'), '不同根必须区分');
});
