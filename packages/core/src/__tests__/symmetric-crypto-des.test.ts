/**
 * 回归锁：**DES / DESede 对称加密支持**（2026-09-22，用户实测 ①宜搜小说正文空）。
 *
 * 症状：正文规则里 `java.aesBase64DecodeToString(d, "EaSoUcNt", "DES/CBC/PKCS5Padding", "EaSoUcNt")`，
 * 站点返回的密文是 **hex**，而我们的 `createSymmetricCrypto` 只支持 AES（key 必须 16/24/32）→ 抛错被吞成空串
 * → 正文恒空。语料里 DES/DESede 由 **7 个源**使用（宜搜小说 / 晋江文学 / 书山聚合 / 移动阅读 …）。
 *
 * 权威依据：Legado 走 hutool 的通用 `createSymmetricCrypto(transformation, key, iv)`
 * （`JsEncodeUtils.kt:188-192`），**DES/DESede 都能用**。
 *
 * 实现要点：node(OpenSSL 3) **默认禁用单 DES**（legacy provider，报 `digital envelope routines::unsupported`），
 * 且 openssl CLI 同样拒绝。解法无需新依赖：`DES(K) ≡ 3DES(K,K,K)`（EDE 等密钥退化），
 * 而 `des-ede3-*` 在默认 provider 里可用。
 *
 * 本文件的参照向量由 **openssl CLI 独立生成**（不是自己加密自己解）：
 * ```
 * $ printf 'hello world 1234' | openssl enc -des-ede3-cbc \
 *     -K 4561536f55634e744561536f55634e744561536f55634e74 -iv 4561536f55634e74 -nopad | base64
 * FDqFEc7WrsLeZXKslXj8lg==
 * ```
 * （`-K` 是 `EaSoUcNt` 的 UTF-8 字节重复三次 = 3DES 的等密钥退化形态 ⇒ 等价于单 DES。）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

const ev = createJsEvaluator({ variables: createVariableStore() });
const run = (code: string): unknown => ev(code, {});

test('DES 与独立参照（openssl 3DES 等密钥）逐字节一致 —— 证明真的是单 DES 而不是退化/走错算法', () => {
  const out = run(
    'java.createSymmetricCrypto("DES/CBC/NoPadding", "EaSoUcNt", "EaSoUcNt").encryptBase64("hello world 1234")',
  );
  assert.equal(out, 'FDqFEc7WrsLeZXKslXj8lg==', '密文必须与 openssl 的 3DES(K,K,K) 一致');
});

test('DES 解密：base64 与 **hex** 两种密文形态都能解（宜搜正文传的是 hex）', () => {
  const b64 = 'FDqFEc7WrsLeZXKslXj8lg==';
  const hex = '143a8511ced6aec2de6572ac9578fc96';
  // NoPadding：向量就是 openssl `-nopad` 生成的 1 个整块 → 两种形态都必须解出同一明文
  assert.equal(run(`java.createSymmetricCrypto("DES/CBC/NoPadding","EaSoUcNt","EaSoUcNt").decryptStr("${b64}")`), 'hello world 1234');
  assert.equal(
    run(`java.createSymmetricCrypto("DES/CBC/NoPadding","EaSoUcNt","EaSoUcNt").decryptStr("${hex}")`),
    'hello world 1234',
    'hex 密文必须被识别（decodeAutoCipher：全 hex 按 hex，否则 base64）',
  );
  // 便捷封装 `aesBase64DecodeToString`（Legado JsEncodeUtils.kt:188-192）同样走 decryptStr：
  // 用它自产的 PKCS5 密文（hex 形态）验证「hex 通道」，算法本身由上面那条独立向量保证。
  assert.equal(
    run(
      'var c=java.createSymmetricCrypto("DES/CBC/PKCS5Padding","EaSoUcNt","EaSoUcNt"); ' +
        'java.aesBase64DecodeToString(c.encryptHex("中文正文"), "EaSoUcNt", "DES/CBC/PKCS5Padding", "EaSoUcNt")',
    ),
    '中文正文',
  );
});

test('DES 往返（含中文与 PKCS5Padding）', () => {
  assert.equal(
    run('var c=java.createSymmetricCrypto("DES/CBC/PKCS5Padding","EaSoUcNt","EaSoUcNt"); c.decryptStr(c.encryptBase64("中文正文段落"))'),
    '中文正文段落',
  );
});

test('DESede：24 字节 key → des-ede3；16 字节 key → des-ede；均可用（IV 必须 8 字节——DES 族块长为 8）', () => {
  assert.equal(
    run('var c=java.createSymmetricCrypto("DESede/CBC/PKCS5Padding","0123456789abcdef01234567","01234567"); c.decryptStr(c.encryptBase64("3des-text"))'),
    '3des-text',
  );
  assert.equal(
    run('var c=java.createSymmetricCrypto("DESede/CBC/PKCS5Padding","0123456789abcdef","01234567"); c.decryptStr(c.encryptBase64("edes-text"))'),
    'edes-text',
  );
});

test('DES key 长度错误时必须显式报错（不静默空串）', () => {
  // 注意 `'shortkey'` 恰好 8 字节（合法 DES key），这里用 5 字节的 `'short'`
  assert.throws(() => run('java.createSymmetricCrypto("DES/CBC/PKCS5Padding","short")'), /DES key 长度须 8 字节/);
  assert.throws(() => run('java.createSymmetricCrypto("DESede/CBC/PKCS5Padding","0123456789")'), /DESede key 长度须 16\/24 字节/);
});

test('AES 路径不受影响（回归）', () => {
  assert.equal(
    run('var c=java.createSymmetricCrypto("AES/ECB/PKCS5Padding","0123456789abcdef"); c.decryptStr(c.encryptBase64("AES still ok"))'),
    'AES still ok',
  );
});
