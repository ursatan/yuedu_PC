/**
 * `#540` **能力补齐**回归锁（2026-10-20 全语料重探 733 源后的落地）：
 *  ① aes/des 旧 API 家族（上游 JsEncodeUtils.kt deprecated 组）——11 源在用，
 *     阅文的 `tripleDESEncodeBase64Str` 是 `#538` okhttp3 闭链一环；
 *  ② `createAsymmetricCrypto`（RSA）——3 源在用（爱丽丝私钥解 / 乐读公钥解）；
 *  ③ `htmlFormat`——6 源在用（红牛/U酷 抠 JSON · pixiv 系清简介）。
 *
 * 全部 L1 与 worker 双路径对拍（只测一边 = 把源从「能用」改成「不能用」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createCipheriv, privateEncrypt, publicEncrypt, constants, type KeyObject } from 'node:crypto';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

function evaluators() {
  const pool = createWorkerSandboxPool({ size: 1 });
  return {
    l1: createHybridJsEvaluator({ variables: createVariableStore() }) as (code: string, b: Record<string, unknown>) => unknown,
    wk: createHybridJsEvaluator({ variables: createVariableStore(), pool }) as (code: string, b: Record<string, unknown>) => unknown,
  };
}

test('① tripleDESEncodeBase64Str / aesEncodeToBase64String：与 Node 逐字节一致且双路径同值', async () => {
  const { l1, wk } = evaluators();
  const code = [
    'var a = java.tripleDESEncodeBase64Str(sign, "0123456789abcdefghijklmn", "CBC", "PKCS5Padding", "12345678");',
    'var b = java.aesEncodeToBase64String(payload, "0123456789abcdef", "AES/CBC/PKCS5Padding", "1234567890abcdef");',
    'var c = java.aesDecodeArgsBase64Str(b, "MDEyMzQ1Njc4OWFiY2RlZg==", "CBC", "PKCS5Padding", "MTIzNDU2Nzg5MGFiY2RlZg==");',
    'a + "|" + b + "|" + c;',
  ].join('\n');
  const bindings = { sign: 'Rv1rPTnczce|123||||||abc', payload: '{"id":"1","page":2}' };
  const l1Out = String(await Promise.resolve(l1(code, bindings)));
  const wkOut = String(await Promise.resolve(wk(code, bindings)));
  const [a1, b1, c1] = l1Out.split('|');
  const [a2, b2, c2] = wkOut.split('|');
  // 期望值 = Node 直算（不依赖被测实现）；⚠️ update 后必须 final() 才会吐出尾块
  const cA = createCipheriv('des-ede3-cbc', Buffer.from('0123456789abcdefghijklmn'), Buffer.from('12345678'));
  const expA = Buffer.concat([cA.update(Buffer.from('Rv1rPTnczce|123||||||abc', 'utf8')), cA.final()]).toString('base64');
  const cB = createCipheriv('aes-128-cbc', Buffer.from('0123456789abcdef'), Buffer.from('1234567890abcdef'));
  const expB = Buffer.concat([cB.update(Buffer.from('{"id":"1","page":2}', 'utf8')), cB.final()]).toString('base64');
  assert.equal(a1, expA, `tripleDESEncodeBase64Str 与 Node 不一致：${a1}`);
  assert.equal(b1, expB, `aesEncodeToBase64String 与 Node 不一致：${b1}`);
  assert.equal(c1, '{"id":"1","page":2}', `ArgsBase64 变体回环失败：${c1}`);
  assert.equal(a2, a1, 'worker 与 L1 的 tripleDES 不一致');
  assert.equal(b2, b1, 'worker 与 L1 的 aesEncode 不一致');
  assert.equal(c2, c1, 'worker 与 L1 的 ArgsBase64 不一致');
});

test('② createAsymmetricCrypto：私钥解 / 公钥解 / PKCS1 自动包装，双路径同值', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privPkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const privPkcs1 = privateKey.export({ type: 'pkcs1', format: 'der' }) as Buffer;
  const pubSpki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const plain = 'hello-rsa-段评对齐';
  // 期望密文：Node 默认 OAEP，而实现（与上游 hutool）是 PKCS1 ⇒ 必须显式指定
  const rsaPubEnc = publicEncrypt as unknown as (k: unknown, b: Buffer, o?: { padding: number }) => Buffer;
  const rsaPrivEnc = privateEncrypt as unknown as (k: unknown, b: Buffer, o?: { padding: number }) => Buffer;
  const encByPub = rsaPubEnc(publicKey as KeyObject, Buffer.from(plain, 'utf8'), { padding: constants.RSA_PKCS1_PADDING });
  const encByPriv = rsaPrivEnc(privateKey as KeyObject, Buffer.from(plain, 'utf8'), { padding: constants.RSA_PKCS1_PADDING });

  const { l1, wk } = evaluators();
  const code = [
    'var out = [];',
    'var r1 = java.createAsymmetricCrypto("RSA/ECB/PKCS1Padding");',
    'r1.setPrivateKey(java.base64DecodeToByteArray(priv8));',
    'out.push(r1.decryptStr(java.base64DecodeToByteArray(ctPub), false));',
    'var r2 = java.createAsymmetricCrypto("RSA/ECB/PKCS1Padding");',
    'r2.setPrivateKey(java.base64DecodeToByteArray(priv1));', // PKCS1 形态 ⇒ 走自动包装
    'out.push(r2.decryptStr(java.base64DecodeToByteArray(ctPub), false));',
    'var r3 = java.createAsymmetricCrypto("RSA");',
    'r3.setPublicKey(java.base64DecodeToByteArray(pub));', // 默认 usePublicKey=true（乐读形态）
    'out.push(r3.decryptStr(java.base64DecodeToByteArray(ctPriv)));',
    'out.join("|");',
  ].join('\n');
  const bindings = {
    priv8: privPkcs8.toString('base64'),
    priv1: privPkcs1.toString('base64'),
    pub: pubSpki.toString('base64'),
    ctPub: Buffer.from(encByPub).toString('base64'),
    ctPriv: Buffer.from(encByPriv).toString('base64'),
  };
  const l1Out = String(await Promise.resolve(l1(code, bindings)));
  const wkOut = String(await Promise.resolve(wk(code, bindings)));
  assert.equal(l1Out, `${plain}|${plain}|${plain}`, `L1 非对称解密不对：${l1Out}`);
  assert.equal(wkOut, l1Out, 'worker 与 L1 的非对称解密不一致');
});

test('③ htmlFormat：去脚本/样式、留文字与 img，双路径同值（convert 通道）', async () => {
  const { l1, wk } = evaluators();
  const code = [
    'var h = "<div>\\u7b2c\\u4e00\\u6bb5<scr" + "ipt>evil()</scr" + "ipt><style>x{}</style>"',
    '  + "<img src=\\"a.png\\"><p>\\u7b2c\\u4e8c\\u6bb5</p></div>";',
    'var o = java.htmlFormat(h);',
    'o.indexOf("\\u7b2c\\u4e00\\u6bb5") >= 0 && o.indexOf("evil") < 0 && o.indexOf("<img src=\\"a.png\\">") >= 0 && o.indexOf("\\u7b2c\\u4e8c\\u6bb5") >= 0',
    '  ? "OK:" + o.length : "BAD:" + o;',
  ].join('\n');
  const l1Out = String(await Promise.resolve(l1(code, {})));
  const wkOut = String(await Promise.resolve(wk(code, {})));
  assert.ok(l1Out.startsWith('OK:'), `L1 htmlFormat 不对：${l1Out.slice(0, 120)}`);
  assert.ok(wkOut.startsWith('OK:'), `worker htmlFormat 不对（convert 通道）：${wkOut.slice(0, 120)}`);
  assert.equal(wkOut, l1Out, 'worker 与 L1 的 htmlFormat 不一致');
});
