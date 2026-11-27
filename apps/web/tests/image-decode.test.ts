import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  charcodeJoinToText,
  extractKeyCandidates,
  imageMagic,
  detectAesCbcKeyIv,
  buildCoverDecodeJs,
} from '../src/utils/image-decode';

/** 造一段「像 JPEG」的明文（≥12 字节，且首三字节是 ff d8 ff） */
function fakeJpeg(len = 48): Uint8Array {
  const b = new Uint8Array(len);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  for (let i = 4; i < len; i += 1) b[i] = (i * 7) & 0xff;
  return b;
}

async function encryptCbc(key: string, iv: string, plain: Uint8Array): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'AES-CBC' }, false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new TextEncoder().encode(iv) }, ck, plain));
}

test('charcodeJoinToText 还原 91 吃瓜实测表值', () => {
  assert.equal(
    charcodeJoinToText('102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48'),
    'f5d965df75336270',
  );
  assert.equal(
    charcodeJoinToText('57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49'),
    '97b60394abc2fbe1',
  );
  // 非法段 → 空串，不抛
  assert.equal(charcodeJoinToText('97_x_98'), 'ab');
});

test('extractKeyCandidates：charcode-join 优先、去重、跳过纯数字字面量', () => {
  const js = [
    "const t=['Base64','join','57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49'];",
    "CryptoJS.AES.decrypt(x, k, { iv: iv, mode: 'CBC' });",
    "var a='102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48';",
    "var v='20261012c';",           // 9 字节 → 不收
    "var n='1234567890123456';",     // 纯数字 → 不收
    "var w='Jui7X#cdleN^3eZb';",     // 16 可见 ASCII → 收
  ].join('\n');
  const cands = extractKeyCandidates(js);
  const values = cands.map((c) => c.value);
  assert.deepEqual(values.slice(0, 2), ['97b60394abc2fbe1', 'f5d965df75336270']);
  assert.ok(values.includes('Jui7X#cdleN^3eZb'));
  assert.ok(!values.includes('20261012c'));
  assert.ok(!values.includes('1234567890123456'));
  assert.equal(cands[0]!.kind, 'charcode-join');
});

test('imageMagic 识别常见图片格式', () => {
  assert.equal(imageMagic(fakeJpeg()), 'jpeg');
  assert.equal(imageMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0])), 'png');
  assert.equal(imageMagic(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])), 'gif');
  assert.equal(imageMagic(new Uint8Array(12)), null);
});

test('detectAesCbcKeyIv：对真实 AES-CBC 密文解出 key/iv', async () => {
  const key = 'f5d965df75336270';
  const iv = '97b60394abc2fbe1';
  const cipher = await encryptCbc(key, iv, fakeJpeg());
  const cands = extractKeyCandidates(`'102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48'\n'57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49'`);
  const hit = await detectAesCbcKeyIv(cipher, cands);
  assert.ok(hit, '应解出');
  assert.equal(hit.key, key);
  assert.equal(hit.iv, iv);
  assert.equal(hit.magic, 'jpeg');
  assert.equal(hit.plain[0], 0xff);
});

test('detectAesCbcKeyIv：key/iv 顺序反了也能命中（候选 × 候选 全试）', async () => {
  const key = 'f5d965df75336270';
  const iv = '97b60394abc2fbe1';
  const cipher = await encryptCbc(key, iv, fakeJpeg());
  // 候选顺序故意颠倒
  const cands = extractKeyCandidates(`'57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49'\n'102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48'`);
  const hit = await detectAesCbcKeyIv(cipher, cands);
  assert.equal(hit?.key, key);
  assert.equal(hit?.iv, iv);
});

test('detectAesCbcKeyIv：密文长度非 16 倍数 ⇒ null', async () => {
  const cands = extractKeyCandidates(`'102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48'`);
  assert.equal(await detectAesCbcKeyIv(new Uint8Array(20), cands), null);
});

test('buildCoverDecodeJs 产出可粘贴规则（与实测写法一致）', () => {
  assert.equal(
    buildCoverDecodeJs('f5d965df75336270', '97b60394abc2fbe1'),
    "java.createSymmetricCrypto('AES/CBC/PKCS5Padding','f5d965df75336270','97b60394abc2fbe1').decrypt(result.readAllBytes())",
  );
  // 含单引号/反斜杠的 key 仍要被正确转义
  assert.equal(
    buildCoverDecodeJs("a'b", 'c\\d'),
    "java.createSymmetricCrypto('AES/CBC/PKCS5Padding','a\\'b','c\\\\d').decrypt(result.readAllBytes())",
  );
});
