/**
 * `#439` 字符集判定/解码（`net/charset.ts` 唯一实现）—— 用户实测的真实语料。
 *
 * 缺陷（2026-10-13，千白羽小说站 `www.xiaoxiaoshuo8.com`）：该站是 **GBK**，且
 * `Content-Type` **不带 charset**（charset 只在 `<meta http-equiv>` 里声明）。
 * `/api/proxy` 取原始字节后，`#435` 的 HTML 修补写成 `buf.toString('utf8')`
 * ⇒ 每个汉字变 U+FFFD `�`，再回写 + `#437` 声明 `charset=utf-8` ⇒ 整页 `����`。
 * 修：先按「显式 → 头 → meta → utf-8」解对，再编码 UTF-8 回传。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectResponseCharset, decodeBytes, decodeText } from '../net/charset';

/** 真实站点首页 `<title>` 的 GBK 字节（用 latin1 反推，避免引入 iconv 依赖） */
const GBK_BYTES = Buffer.from('Ç§°×ÓðµÄÐ¡ËµÕ¾', 'latin1');
const EXPECT = '千白羽的小说站';
const GBK_HEAD = '<meta http-equiv="Content-Type" content="text/html; charset=gbk" />';

test('#439 头无 charset + meta 声明 gbk ⇒ 嗅探出 gbk 并解对（真实站点形态）', () => {
  const buf = Buffer.concat([Buffer.from('<html><head>' + GBK_HEAD, 'latin1'), GBK_BYTES]);
  assert.equal(detectResponseCharset(buf, 'text/html'), 'gbk', 'Content-Type 无 charset ⇒ 必须看 meta');
  assert.equal(decodeText(buf, 'text/html').slice(-EXPECT.length), EXPECT);
});

test('#439 对偶：旧写法（按 UTF-8 解 GBK 字节）必然产出替换字符 —— 锁住这条缺陷', () => {
  const bad = decodeBytes(GBK_BYTES, 'utf-8');
  assert.ok(bad.includes('\uFFFD'), `按 UTF-8 解 GBK 必须出现 U+FFFD，实得 ${JSON.stringify(bad)}`);
});

test('#439 Content-Type 的 charset 优先于 meta', () => {
  const buf = Buffer.from('<html><head>' + GBK_HEAD + '</head><body>hi</body></html>', 'latin1');
  assert.equal(detectResponseCharset(buf, 'text/html; charset=utf-8'), 'utf-8');
});

test('#439 显式 charset（&cs= / 源规则 `,{"charset":"gbk"}`）优先级最高', () => {
  assert.equal(detectResponseCharset(GBK_BYTES, 'text/html; charset=utf-8', 'gbk'), 'gbk');
  assert.equal(decodeText(GBK_BYTES, '', 'gbk'), EXPECT);
});

test('#439 无任何线索 ⇒ utf-8 兜底；未知标签不抛（退回 utf-8）', () => {
  const plain = Buffer.from('hello', 'utf8');
  assert.equal(detectResponseCharset(plain, 'text/plain'), 'utf-8');
  assert.equal(decodeBytes(plain, 'no-such-charset-xyz'), 'hello');
});
