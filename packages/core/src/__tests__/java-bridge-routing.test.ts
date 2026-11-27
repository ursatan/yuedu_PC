/**
 * `#158` 回归锁：**L1 / worker 的路由判定**（`needsJavaBridgeL1`）。
 *
 * 背景：判定的旧实现是 `JAVA_BRIDGE_RE.test(lib + code)`，只要文本里出现 `Packages.` 就把
 * **整源**锁进 L1。而 worker 侧**后来补上了** `Packages.java.lang.Thread`（`worker-pool.ts:916`），
 * 于是 Linpx / 独阅读网 / 兽人小说站 / 晋江 / 清风小说网 / 书文小说 这 **6 源**被一条
 * **已经过期的理由**长期锁在 L1（代价：`java.ajax` 走 `execFileSync('curl')` 阻塞事件循环，
 * 且本机 spawn 不可用时恒返回空 —— 见 `#159`）。
 *
 * 白名单的判据是「**worker 覆盖 L1 的全部成员且语义相同**」，所以这里**同时**要钉住
 * 「哪些必须放行」与「哪些**不许**放行」——只测前者会把成员集不一致的命名空间也放进去，
 * 结果是那些源从「L1 能跑」变成 worker 里的**静默空串**（更糟）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsJavaBridgeL1 } from '../selector/java-bridge';
import { JAVA_BRIDGE_RE } from '../selector/java-bridge';

test('① 只用到 Packages.java.lang.Thread / System ⇒ **不进 L1**（走 worker）', () => {
  // Linpx 的 jsLib 里就是这一行（正是它把整源锁进 L1 的）
  assert.equal(needsJavaBridgeL1('function sleep(seconds) {\n    return Packages.java.lang.Thread.sleep(1000*seconds)\n}'), false);
  assert.equal(needsJavaBridgeL1('Packages.java.lang.System.currentTimeMillis()'), false);
  assert.equal(needsJavaBridgeL1('var t = Packages.java.lang.System.nanoTime();'), false);
});

/**
 * `#500` 名单随 worker 覆盖面前进而更新（判据始终是「worker 覆盖且语义一致才放行」）：
 *  · javax.crypto / Arrays.copyOfRange / Base64（含 getUrlEncoder）—— worker 已补齐 ⇒ **放行**；
 *  · String / Integer / UUID / ArrayList —— 仍未逐项对齐 ⇒ **仍留 L1**（防静默失效）。
 */
test('② 未对齐的 Packages.* 仍留 L1；已对齐的放行（#500）', () => {
  const mustStayL1: Array<[label: string, code: string]> = [
    // #526：JavaImporter 本身已能在 worker 跑，但「构造参数不是 Packages.* 字面量」判不准 ⇒ 仍留 L1
    ['JavaImporter（导入判不准）', 'var imp = new JavaImporter(javax.crypto)'],
    // #538：okhttp3 桥两侧已实现 ⇒ **从留 L1 移到放行**（见下方 mayGoWorker）
  ];
  for (const [label, code] of mustStayL1) {
    assert.equal(needsJavaBridgeL1(code), true, `${label} 必须留 L1`);
  }
  // 已对齐 ⇒ 放去 worker（#501 P0-1a-2 后这批从 27 源降到 7 源）
  const mayGoWorker: Array<[label: string, code: string]> = [
    ['String', 'new Packages.java.lang.String(bytes, "UTF-8")'],
    ['Integer.valueOf', 'Packages.java.lang.Integer.valueOf("1")'],
    ['UUID', 'Packages.java.util.UUID.randomUUID()'],
    ['MessageDigest', 'Packages.java.security.MessageDigest.getInstance("MD5")'],
    ['BigInteger', 'Packages.java.math.BigInteger.valueOf(1)'],
    ['io.BufferedReader', 'new Packages.java.io.BufferedReader(r)'],
    ['zip.GZIPInputStream', 'new Packages.java.util.zip.GZIPInputStream(is)'],
    ['SecureRandom', 'new Packages.java.security.SecureRandom()'],
    ['StringBuilder', 'new Packages.java.lang.StringBuilder()'],
    ['URL', 'new Packages.java.net.URL("http://x")'],
    ['Charset', 'Packages.java.nio.charset.Charset.forName("UTF-8")'],
    ['javax.crypto', 'Packages.javax.crypto.Cipher.getInstance("AES")'],
    ['Arrays.copyOfRange', 'Packages.java.util.Arrays.copyOfRange(b, 0, 4)'],
    ['Base64.getUrlEncoder', 'Packages.java.util.Base64.getUrlEncoder().encodeToString(b)'],
    ['hutool md5', 'Packages.cn.hutool.crypto.digest.DigestUtil.md5Hex(v)'],
    ['kazusa', 'new Packages.io.legato.kazusa.utils.TimeoutCancellationException()'],
    // #538：okhttp3 桥（收口 #473 剩余 3 源）
    ['okhttp3 前缀', 'var j = new JavaImporter(); j.importPackage(Packages.okhttp3);'],
    ['okhttp3 字面量', 'Packages.okhttp3.HttpUrl.parse(u).topPrivateDomain()'],
  ];
  for (const [label, code] of mayGoWorker) {
    assert.equal(needsJavaBridgeL1(code), false, `${label} 应放去 worker`);
  }
});


test('③ `#526` 硬桥：worker 已实现 ⇒ 放行；判不准/未实现 ⇒ 留 L1', () => {
  // 七猫 3.9.61 正文的真实形态（importPackage 全是 worker 有全套实现的命名空间）
  assert.equal(
    needsJavaBridgeL1(
      'var ji = new JavaImporter();\n' +
        'ji.importPackage(Packages.java.lang, Packages.javax.crypto.spec, Packages.javax.crypto, Packages.java.util);\n' +
        'with (ji) { var k = SecretKeySpec(String("x").getBytes(), "AES"); }',
    ),
    false,
  );
  // 禁漫天堂 imageDecode 的真实形态（android.graphics 由 rpc('bitmap') 回宿主实现）
  assert.equal(
    needsJavaBridgeL1(
      'var Magua = new JavaImporter();\n' +
        'Magua.importPackage(Packages.java.io, Packages.android.graphics);\n' +
        'with(Magua){ var img = BitmapFactory.decodeByteArray(result, 0, result.length); }',
    ),
    false,
  );
  // 裸 Bitmap / Canvas（不走 with）现在也能进 worker
  assert.equal(needsJavaBridgeL1('BitmapFactory.decodeByteArray(b, 0, b.length)'), false);
  assert.equal(needsJavaBridgeL1('new Canvas(100, 100)'), false);
  // 但 worker 未实现的命名空间仍然留 L1
  assert.equal(needsJavaBridgeL1('var j = new JavaImporter(); j.importPackage(Packages.java.util.concurrent);'), true);
  assert.equal(needsJavaBridgeL1('var j = new JavaImporter(); j.importPackage(Packages.java.security.spec);'), true);
  // #538：okhttp3 桥两侧实现 ⇒ 放行（收口 #473 剩余 3 源）
  assert.equal(needsJavaBridgeL1('var j = new JavaImporter(); j.importPackage(Packages.okhttp3);'), false);
});

test('③b `#526` 反向安全网：java.util 只放行 worker 真实现了的那部分', () => {
  // 用了 Collections ⇒ 留 L1（worker 的 java.util 没有它，静默 ReferenceError 更糟）
  assert.equal(needsJavaBridgeL1('var j = new JavaImporter(Packages.java.util); with(j){ Collections.emptyList() }'), true);
  assert.equal(needsJavaBridgeL1('var j = new JavaImporter(Packages.java.util); with(j){ Base64.getEncoder() }'), false);
});

test('③c `#526` 回退开关：YUEDU_WORKER_HARDBRIDGE=0 退回旧行为', () => {
  const prev = process.env.YUEDU_WORKER_HARDBRIDGE;
  process.env.YUEDU_WORKER_HARDBRIDGE = '0';
  try {
    assert.equal(needsJavaBridgeL1('var j = new JavaImporter(Packages.java.lang);'), true);
    assert.equal(needsJavaBridgeL1('BitmapFactory.decodeByteArray(b, 0, b.length)'), true);
  } finally {
    if (prev === undefined) delete process.env.YUEDU_WORKER_HARDBRIDGE;
    else process.env.YUEDU_WORKER_HARDBRIDGE = prev;
  }
});

test('④ ★ 混合时必须留 L1（防空转：不能因为看见 Thread/System 就整体放行）', () => {
  // 硬桥里含未实现命名空间 ⇒ 即使其余全放行也必须留 L1
  assert.equal(
    needsJavaBridgeL1('Packages.java.lang.Thread.sleep(100)\nvar imp = new JavaImporter(Packages.java.util.concurrent)'),
    true,
  );
  assert.equal(needsJavaBridgeL1('Packages.java.lang.System.lineSeparator()\nvar x = new Packages.java.util.HashMap()'), false);
});

test('⑤ 完全不用 Java 桥 ⇒ 不进 L1（否则判定退化成「永远 L1」）', () => {
  assert.equal(needsJavaBridgeL1('var s = java.ajax(url); JSON.parse(s)'), false);
  assert.equal(needsJavaBridgeL1('result.match(/\\d+/)'), false);
  assert.equal(needsJavaBridgeL1(''), false);
});

test('⑥ 防空转：必须**同时**存在 true 与 false 两类结果', () => {
  const results = new Set([
    needsJavaBridgeL1('var j = new JavaImporter(Packages.java.util.concurrent);'),
    needsJavaBridgeL1('Packages.android.graphics.Bitmap.createBitmap(1, 1)'),
  ]);
  assert.equal(results.size, 2, '判定退化成常量了（要么全 L1、要么全 worker）');
});

test('⑦ 旧正则 `JAVA_BRIDGE_RE` 仍然把 Thread 判成「要 L1」—— 这正是本类要修掉的差异', () => {
  // 这条断言的作用是**锁住差异本身**：若哪天有人把判定改回直接用 JAVA_BRIDGE_RE，
  // 或者把 JAVA_BRIDGE_RE 也一起放宽（那会让 javax.crypto 这类失去保护），这里会立刻红。
  assert.equal(JAVA_BRIDGE_RE.test('Packages.java.lang.Thread.sleep(1000)'), true);
  assert.equal(needsJavaBridgeL1('Packages.java.lang.Thread.sleep(1000)'), false);
});
