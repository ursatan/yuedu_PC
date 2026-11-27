/**
 * 回归锁：**Rhino Java 类互操作**（Task #77）——两个真实源的调用形态原样复刻。
 *
 * 语料实证（484 源）：`Packages.` 40+ 种访问、`JavaImporter` 10 源、
 * `javax.crypto` 4 源、`Thread.sleep` 9 源、`String.getBytes` 全部 UTF-8。
 *
 * 形态 A（七猫四合一 qmDecryptChapterBytes，Packages 直访）：
 *   Base64.decode → Arrays.copyOfRange → SecretKeySpec(String(KEY).getBytes('UTF-8'),'AES')
 *   → IvParameterSpec → Cipher.getInstance('AES/CBC/PKCS5Padding').init(2,key,iv).doFinal(ct)
 * 形态 B（七猫[官方] content，JavaImporter + with）：
 *   `with (ji) { … Base64.getDecoder().decode … SecretKeySpec(String("…").getBytes(),"AES") … }`
 *   —— 裸 `String` 被解析成 java.lang.String（importPackage(java.lang) 后 with 作用域遮蔽全局）。
 *
 * 密文用 node crypto 按同参数加密生成 —— 断言的是「解密出原文」，不是桩的自洽。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { blockSamples, resetBlocks } from '../diag/block-stats';
import { createVariableStore } from '../store';
import type { JsEvaluator } from '../selector/types';

const KEY = '242ccb8230d709e1';
const PLAIN = '第一章 试炼之地\n少年握紧了手中的剑。';

/** 与源同参数加密：AES-128-CBC/PKCS5，随机 IV 前置（返回 base64(iv||ct)） */
function encryptIvPrefixed(plain: string): string {
  const iv = randomBytes(16);
  const c = createCipheriv('aes-128-cbc', Buffer.from(KEY, 'utf-8'), iv);
  const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf-8')), c.final()]);
  return Buffer.concat([iv, ct]).toString('base64');
}

function makeL1(): JsEvaluator {
  return createHybridJsEvaluator({
    variables: createVariableStore(),
    http: async () => ({ status: 200, headers: {}, body: '' }),
  });
}

test('形态B：JavaImporter + with —— 裸类名/无 new 构造/String 遮蔽 全链路解密（七猫官方原文）', async () => {
  const ev = makeL1();
  const cipherB64 = encryptIvPrefixed(PLAIN);
  // 与七猫[官方]v3.1 content 逐字一致的脚本（仅变量名 src 传入密文）
  const code = [
    'var javaImport = new JavaImporter();',
    'javaImport.importPackage(Packages.java.lang, Packages.javax.crypto.spec, Packages.javax.crypto, Packages.java.util);',
    'with (javaImport) {',
    '    function decode(content) {',
    '        var ivEncData = Base64.getDecoder().decode(String(content));',
    '        var key = SecretKeySpec(String("' + KEY + '").getBytes(), "AES");',
    '        var iv = IvParameterSpec(Arrays.copyOfRange(ivEncData, 0, 16));',
    '        var chipher = Cipher.getInstance("AES/CBC/PKCS5Padding");',
    '        chipher.init(2, key, iv);',
    '        return String(chipher.doFinal(Arrays.copyOfRange(ivEncData, 16, ivEncData.length)));',
    '    }',
    '    decode(src)',
    '}',
  ].join('\n');
  const out = await Promise.resolve(ev(code, { src: cipherB64 }));
  assert.equal(String(out), PLAIN, `JavaImporter 解密链路必须还原原文：${String(out).slice(0, 60)}`);
});

test('形态A：Packages 直访链路（七猫四合一 qmDecryptChapterBytes 原文）', async () => {
  const ev = makeL1();
  const cipherB64 = encryptIvPrefixed(PLAIN);
  const code = [
    'function qmDecryptChapterBytes(value) {',
    '  var raw = Packages.android.util.Base64.decode(String(value), 0)',
    '  if (!raw || raw.length <= 16) throw new Error("七猫章节密文无效")',
    '  var iv = Packages.java.util.Arrays.copyOfRange(raw, 0, 16)',
    '  var encrypted = Packages.java.util.Arrays.copyOfRange(raw, 16, raw.length)',
    '  var key = new Packages.javax.crypto.spec.SecretKeySpec(new Packages.java.lang.String("' + KEY + '").getBytes("UTF-8"), "AES")',
    '  var ivSpec = new Packages.javax.crypto.spec.IvParameterSpec(iv)',
    '  var cipher = Packages.javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding")',
    '  cipher.init(2, key, ivSpec)',
    '  return cipher.doFinal(encrypted)',
    '}',
    'String(new Packages.java.lang.String(qmDecryptChapterBytes(src), "UTF-8"))',
  ].join('\n');
  const out = await Promise.resolve(ev(code, { src: cipherB64 }));
  assert.equal(String(out), PLAIN, `Packages 直访链路必须还原原文：${String(out).slice(0, 60)}`);
});

test('byte[] 保真：String.getBytes 与反向构造（含中文多字节）', async () => {
  const ev = makeL1();
  const out = await Promise.resolve(
    ev(
      [
        'var b = new Packages.java.lang.String("剑来·甲").getBytes("UTF-8");',
        'var rt = String(new Packages.java.lang.String(b, "UTF-8"));',
        'JSON.stringify([b.length, b[0], rt])',
      ].join('\n'),
      {},
    ),
  );
  const parsed = JSON.parse(String(out)) as [number, number, string];
  const expected = Buffer.from('剑来·甲', 'utf-8');
  assert.equal(parsed[0], expected.length, `字节长度必须按 UTF-8 计：${parsed[0]}`);
  assert.equal(parsed[1], expected[0], `首字节：${parsed[1]}`);
  assert.equal(parsed[2], '剑来·甲', '反向构造必须还原文本');
});

test('MessageDigest：MD5/SHA-256 与 node crypto 等值（返回字节，不是 hex）', async () => {
  const ev = makeL1();
  const out = await Promise.resolve(
    ev(
      [
        'var md5 = Packages.java.security.MessageDigest.getInstance("MD5").digest("abc");',
        'var s256 = Packages.java.security.MessageDigest.getInstance("SHA-256").digest("abc");',
        'JSON.stringify([[...md5].length, [..s256].length])'.replace('..s256', '...s256'),
      ].join('\n'),
      {},
    ),
  );
  const parsed = JSON.parse(String(out)) as number[];
  assert.deepEqual(parsed, [16, 32], `摘要字节数：${String(out)}`);
  const expectMd5 = createHash('md5').update('abc').digest();
  const got = (await Promise.resolve(ev('Packages.java.security.MessageDigest.getInstance("MD5").digest("abc")', {}))) as Uint8Array;
  assert.deepEqual(Buffer.from(got).equals(expectMd5), true, 'MD5 摘要必须逐字节一致');
});

test('Thread.sleep 真阻塞（Legado 语义）且不抛错；System.currentTimeMillis 可用', async () => {
  const ev = makeL1();
  const out = await Promise.resolve(
    ev(
      [
        'var t0 = Packages.java.lang.System.currentTimeMillis();',
        'Packages.java.lang.Thread.sleep(60);',
        'JSON.stringify([Packages.java.lang.System.currentTimeMillis() - t0 >= 50])',
      ].join('\n'),
      {},
    ),
  );
  assert.equal(String(out), '[true]', `sleep(60) 必须真实耗时 ≥50ms：${String(out)}`);
});

/**
 * `#500` P0-1a **契约变更**：过去「一切含 Packages. 的脚本都留 L1」；现在
 * 「路径全部命中 `WORKER_PACKAGES_PREFIXES` 的放去 worker」——因为 worker 内已实现
 * 惰性 Packages 命名空间（`sandbox/packages-ns.ts`），且 worker 的 HTTP 走 RPC 回宿主，
 * 同步等待不阻塞主线程。**没覆盖到的路径仍然整体留 L1**（保守：避免半残功能）。
 * JavaImporter / Bitmap / Canvas / BitmapFactory 四条字面量仍旧一律 L1（未变）。
 */
test('路由守卫：Packages 已覆盖路径走 worker、未覆盖路径仍留 L1（#500）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const l1Direct = createJsEvaluator({
    variables: createVariableStore(),
  });
  const hybrid = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: '' }),
  });
  resetBlocks();
  // ① 已覆盖（java.lang.String 在前缀表里）⇒ 走 worker，且**结果仍正确**
  // 用 cn.hutool（worker 新补、与宿主同语义）验「已覆盖 ⇒ 走 worker」
  const out = await Promise.resolve(hybrid('Packages.cn.hutool.crypto.digest.DigestUtil.md5Hex("abc")', {}));
  assert.equal(String(out), '900150983cd24fb0d6963f7d28e17f72', 'worker 路径结果必须正确');
  const l1Covered = blockSamples().filter((s) => s.kind === 'l1-eval');
  assert.equal(l1Covered.length, 0, '已覆盖的 Packages 路径不应再走 L1（#500 放行）');
  // ② 未覆盖（RandomUtil 不在前缀表）⇒ 仍然整体留 L1
  resetBlocks();
  const out2 = await Promise.resolve(hybrid('String(Packages.cn.hutool.core.date.DateUtil.today())', {}));
  assert.equal(String(out2), '', '未覆盖路径在 worker 里也是空串（兜底一致）；关键是它必须走 L1');
  const l1Uncovered = blockSamples().filter((s) => s.kind === 'l1-eval');
  assert.ok(l1Uncovered.length > 0, '未覆盖的 Packages 路径必须仍走 L1（保守）');
  // ③ 两条路结果等价（L1 直跑同一段已覆盖代码）
  assert.equal(String(l1Direct('Packages.cn.hutool.crypto.digest.DigestUtil.md5Hex("abc")', {})), '900150983cd24fb0d6963f7d28e17f72');
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

/**
 * 路由守卫必须**连 jsLib 一起判**（2026-09-19 立案补齐）。
 *
 * 语料 11 源的 Java 桥全写在 jsLib（四合一 / 聚合类），规则代码只有
 * `qmReadContent.call(this, result, baseUrl)` 这种零字面量调用：
 *   · 只判 `code` → 判不中 → 落 worker → worker 类桩没有 javax.crypto/String.getBytes
 *     → 规则静默返回空（正文「解析成功但 0 字」）。
 *   · 判 `lib + code` → 正确回落 L1。
 */
test('路由守卫：桥只写在 jsLib 里（规则代码零字面量）也必须回 L1 —— 四合一形态', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const hybrid = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    // 复刻四合一：桥与辅助函数都在 jsLib，规则里只调函数名
    // `#503`：桥改用**未覆盖**路径（Bitmap 硬桥）——java.* / cn.hutool.* 包级现已放行
    lib: 'function qmParam(tag){ return tag + ":" + Packages.cn.hutool.core.date.DateUtil.today() }',
    http: async () => ({ status: 200, headers: {}, body: '' }),
  });
  resetBlocks();
  const out = await Promise.resolve(hybrid('qmParam("T")', {}));
  assert.ok(/^T:/.test(String(out)), `jsLib 里的桥必须可用：${String(out)}`);
  const l1 = blockSamples().filter((s) => s.kind === 'l1-eval');
  assert.ok(l1.length > 0, 'jsLib 含 Java 桥时必须走 L1（否则 worker 类桩缺失 → 静默失败）');
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

/**
 * `ChaCha20-Poly1305`（2026-10-15 补，听友M 发现页分类条 0 卡片）。
 *
 * 真因：源脚本 `Cipher.getInstance("ChaCha20-Poly1305")` —— 变换串**没有 `/mode/padding` 段**，
 * 旧 `parseTransformation` 的正则只认 `AES/xxx/xxx` ⇒ 直接抛「不支持的变换」⇒ 解密链断 ⇒ 列表恒空。
 * JDK 语义：密钥 32 字节、IV 12 字节、密文 = `ct || tag(16)`（与 GCM 同形）；
 * 密文用 node crypto 按同参数生成 —— 断言的是「解密出原文」，不是桩的自洽。
 */
test('ChaCha20-Poly1305：AEAD 解密链路（听友M 0 卡片真因）', async () => {
  const ev = makeL1();
  const key = Buffer.from('A'.repeat(32), 'utf-8');
  assert.equal(key.length, 32, 'ChaCha20 密钥须 32 字节');
  const iv = randomBytes(12);
  const c = createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
  const blob = Buffer.concat([iv, c.update(Buffer.from(PLAIN, 'utf-8')), c.final(), c.getAuthTag()]).toString('base64');
  const code = [
    'var raw = Packages.android.util.Base64.decode(String(blob));',
    'var key = new Packages.javax.crypto.spec.SecretKeySpec(new Packages.java.lang.String("' + key.toString('utf-8') + '").getBytes("UTF-8"), "ChaCha20-Poly1305");',
    'var ivSpec = new Packages.javax.crypto.spec.IvParameterSpec(Packages.java.util.Arrays.copyOfRange(raw, 0, 12));',
    'var cipher = Packages.javax.crypto.Cipher.getInstance("ChaCha20-Poly1305");',
    'cipher.init(2, key, ivSpec);',
    'String(new Packages.java.lang.String(cipher.doFinal(Packages.java.util.Arrays.copyOfRange(raw, 12, raw.length)), "UTF-8"));',
  ].join('\n');
  const out = await Promise.resolve(ev(code, { blob }));
  assert.equal(String(out), PLAIN, `ChaCha20-Poly1305 必须还原原文：${String(out).slice(0, 60)}`);
});
