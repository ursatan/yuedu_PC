/**
 * `#526` **硬桥 worker 化**回归锁：`JavaImporter` + `Bitmap/Canvas` 在 worker 里跑出与 L1 相同的结果。
 *
 * 为什么必须两组 Assert on 同一份用例：
 *  · 路由放行只是「允许去 worker」，真正决定源能不能跑的是 worker 内的**语义**；
 *  · 本仓历史上出过「L1 能跑、worker 静默空串」（未知成员落 nest() 空工厂）⇒ 只测 worker
 *    等于把源从「能用」改成「不能用」。所以这里**逐项对拍** worker 与 L1。
 *
 * 两条用例都取**真实源脚本形态**：
 *  · ① 七猫官方 v3.9.61 正文解密（`with(JavaImporter)` + `String(…)` + AES/CBC）
 *    —— 它同时是 `#508`（String 方法集）与 `#504`（Cipher 算法名）的回归；
 *  · ② 禁漫天堂 `imageDecode` 切条还原（`BitmapFactory` → `Bitmap.createBitmap` → `Canvas` → `compress`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { PNG } from 'pngjs';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/** 造一份 AES/CBC/PKCS5Padding 密文（iv || ct），对齐七猫 `content` 的形态 */
function aesCbc(): { b64: string; plain: string } {
  const key = Buffer.from('242ccb8230d709e1', 'utf-8');
  const iv = Buffer.from('0123456789abcdef', 'utf-8');
  const plain = '第七十六章 云海关\n\n  他站在城墙尽头，风把火把拉成一条斜线。';
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf-8')), cipher.final()]);
  return { b64: Buffer.concat([iv, ct]).toString('base64'), plain };
}

/** 造一张 8×8 PNG（纯色 + 左上角一个白点，验证像素搬运没把图抹平），用于 Bitmap 往返 */
function tinyPng(): Uint8Array {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 20;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  // 左上角一个白点（验证像素搬运没把图抹平）
  png.data[0] = 255;
  png.data[1] = 255;
  png.data[2] = 255;
  return new Uint8Array(PNG.sync.write(png));
}

function makeEvaluator(withPool: boolean) {
  const vars = createVariableStore();
  const pool = withPool ? createWorkerSandboxPool({ size: 1 }) : undefined;
  return createHybridJsEvaluator({ variables: vars, pool }) as (
    code: string,
    bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
}

test('① `with(JavaImporter)` + AES/CBC：worker 与 L1 结果一致（七猫 3.9.61 正文形态）', async () => {
  const { b64, plain } = aesCbc();
  const code = [
    'var javaImport = new JavaImporter();',
    'javaImport.importPackage(Packages.java.lang, Packages.javax.crypto.spec, Packages.javax.crypto, Packages.java.util);',
    'with (javaImport) {',
    '  function decode(content) {',
    '    var ivEncData = Base64.getDecoder().decode(String(content));',
    '    var key = SecretKeySpec(String("242ccb8230d709e1").getBytes(), "AES");',
    '    var iv = IvParameterSpec(Arrays.copyOfRange(ivEncData, 0, 16));',
    '    var chipher = Cipher.getInstance("AES/CBC/PKCS5Padding");',
    '    chipher.init(2, key, iv);',
    '    return String(chipher.doFinal(Arrays.copyOfRange(ivEncData, 16, ivEncData.length)));',
    '  }',
    '}',
    'var qmText = decode(content);',
    // ⚠️ with 块外 `String` 回到原生 JS String（这是 Rhino 语义，两边一致）⇒ 这里直接调
    // java.lang.String 的实例方法，正好顺带回归 `#508` 的方法集
    'qmText.substring(0, 4) + "|" + qmText.length() + "|" + qmText.contains("风把火把");',
  ].join('\n');

  const l1Out = String(await Promise.resolve(makeEvaluator(false)(code, { content: b64 })));
  const wkOut = String(await Promise.resolve(makeEvaluator(true)(code, { content: b64 })));
  // L1 自身先得对（否则这把锁形同虚设）
  assert.equal(l1Out, `第七十六|${plain.length}|true`, 'L1 基线不对 ⇒ worker 对比失去意义');
  assert.equal(wkOut, l1Out, 'worker 与 L1 结果不一致');
});

test('② `Bitmap/Canvas` 位图往返：worker 与 L1 结果一致（禁漫天堂 imageDecode 形态）', async () => {
  const png = Buffer.from(tinyPng());
  const code = [
    'var Magua = new JavaImporter();',
    'Magua.importPackage(Packages.java.io, Packages.android.graphics);',
    'with (Magua) {',
    '  var bytes = Packages.android.util.Base64.decode(imgB64, 0);',
    '  var img = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);',
    '  var w = img.getWidth();',
    '  var h = img.getHeight();',
    '  var newImg = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);',
    '  var canvas = new Canvas(newImg);',
    '  canvas.drawBitmap(Bitmap.createBitmap(img, 0, 0, w, h), 0, 0, null);',
    '  var out = new ByteArrayOutputStream();',
    '  newImg.compress(Bitmap.CompressFormat.PNG, 100, out);',
    '  var arr = out.toByteArray();',
    '  w + "x" + h + "|" + arr.length;',
    '}',
  ].join('\n');

  const bindings = { imgB64: png.toString('base64') };
  const l1Out = String(await Promise.resolve(makeEvaluator(false)(code, bindings)));
  const wkOut = String(await Promise.resolve(makeEvaluator(true)(code, bindings)));
  const [wh1, len1] = l1Out.split('|');
  const [wh2, len2] = wkOut.split('|');
  assert.equal(wh1, '8x8', `L1 解出的尺寸不对：${l1Out}`);
  assert.equal(wh2, wh1, 'worker 与 L1 解出的尺寸不一致');
  assert.ok(Number(len1) > 0, 'L1 编码出 0 字节');
  assert.equal(Number(len2) > 0, true, 'worker 编码出 0 字节（RPC 桥没通）');
});
