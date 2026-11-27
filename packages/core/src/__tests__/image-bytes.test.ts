/**
 * 回归锁（用户 2026-10-01 Add）：图片二次解密的 `result` 必须带 **InputStream 语义**。
 *
 * ## 缺陷现象
 * 🥝猕猴桃漫画（及逐字相同的「漫蛙」）`coverDecodeJs` 首行是 `const view = result.readAllBytes();`
 * 本仓此前只给 `Uint8Array` ⇒ `TypeError: result.readAllBytes is not a function`
 * ⇒ `decodeImage` 返回 `null` ⇒ 服务端**回传未解密的乱码字节** ⇒ 浏览器 `@error`
 * ⇒ 发现页 49 张卡片全部显示默认封面（用户截图）。
 *
 * ## 为什么是「整类」而不是单源
 * 上游 `OkHttpStreamFetcher.kt:129-146` 对同一个 `ImageUtils.decode` 传**两种类型**：
 * 封面传 `byteStream()`（InputStream）、正文图传 `bytes()`（ByteArray）。
 * 源脚本是按「拿到什么就用什么」写的 ⇒ 两种形态都必须能跑。
 *
 * ## 本测试锁三件事
 * ① `readAllBytes()` 能用，且返回**副本**（Java 语义：读掉流并返回副本，不是返回自身）。
 * ② 下标 / `length` / `slice()` **不受影响**（ByteArray 那一路不能因此坏掉）。
 * ③ 挂的方法**非枚举** —— 否则 `isCloneable` 判失败，含图片字节的脚本被静默推回 L1
 *    （与 `json-map-binding.test.ts` 锁的是同一条纪律）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv } from 'node:crypto';
import {
  asImageStreamResult,
  // `D2` 标准参数 `decode{}`
  parseImageDecodeSpec,
  decodeImageKeyBytes,
  splitImageCipherBytes,
  decryptImageWithSpec,
} from '../selector/image-bytes';

const BYTES = Uint8Array.from([0x8c, 0xfb, 0xe9, 0xe5, 0x47, 0xc5, 0xcb, 0x56]);

test('图片解密①: readAllBytes() 返回全部字节（副本，不是自身）', () => {
  const r = asImageStreamResult(BYTES);
  const view = (r as unknown as { readAllBytes: () => Uint8Array }).readAllBytes();
  assert.deepEqual([...view], [...BYTES], '内容一致');
  assert.notEqual(view, r, '必须返回副本：源脚本拿 view 切片/原地改都不得影响 result');
});

test('图片解密②: 下标写法（ByteArray 语义）照旧可用', () => {
  const r = asImageStreamResult(BYTES);
  assert.equal(r[0], 0x8c, 'result[0] 仍是首字节');
  assert.equal(r.length, BYTES.length);
  assert.deepEqual([...r.slice(0, 2)], [0x8c, 0xfb], 'slice 正常');
});

test('图片解密③: 挂的方法必须非枚举（不得新增可枚举面）', () => {
  const r = asImageStreamResult(BYTES) as unknown as Record<string, unknown>;
  for (const m of ['readAllBytes', 'available', 'readBytes', 'close', 'read', 'skip', 'readNBytes']) {
    assert.equal(typeof r[m], 'function', `${m} 存在`);
    assert.ok(!Object.keys(r).includes(m), `${m} 不可枚举（Object.keys 不得出现）`);
    assert.ok(!Object.values(r).includes(r[m]), `${m} 不可枚举（Object.values 不得出现）`);
  }
  /**
   * ⚠️ `Object.keys` 里出现 `'0'..'7'` 是 **TypedArray 自带的索引**（不是我们挂的），
   * 改动前就如此。`#759` 起 `isCloneable` 认 TypedArray（结构化克隆支持它）⇒ 图片解密
   * 可以进 worker；但克隆**会丢非枚举方法**，所以 worker 侧必须用同一份
   * `IMAGE_BYTES_SOURCE` 重建（见 `image-decode-worker-759.test.ts`）。
   * 非枚举仍是「不引入新的可枚举属性 / 不让克隆体多出对象键」这一条底线。
   */
  assert.deepEqual(Object.keys(r), [...BYTES.keys()].map(String), '只多出 TypedArray 自己的索引');
});

test('图片解密④: 幂等 + 其余流方法语义正确', () => {
  const r = asImageStreamResult(BYTES);
  const again = asImageStreamResult(r);
  assert.equal(again, r, '重复调用返回同一个对象（不重复挂方法）');
  const s = r as unknown as {
    available: () => number;
    readBytes: (n: number) => Uint8Array;
    close: () => void;
  };
  assert.equal(s.available(), BYTES.length, '内存字节 available = 全长');
  assert.deepEqual([...s.readBytes(2)], [0x8c, 0xfb], 'readBytes(n) 取前 n 字节');
  assert.equal(s.close(), undefined, 'close() 空实现不抛');
});

test('图片解密⑤: 不改动调用方传入的那个数组（真源只应改 result 指向的对象）', () => {
  const src = Uint8Array.from([1, 2, 3]);
  const r = asImageStreamResult(src);
  assert.equal(r, src, '就是同一个数组（避免多一次拷贝）');
  (r as unknown as { readAllBytes: () => Uint8Array }).readAllBytes();
  assert.deepEqual([...src], [1, 2, 3], '调用流方法不会改动原字节');
});

/**
 * `#452`（用户口径：「图片解密的规则方面，我们要兼容 legado 写法」）：
 * 语料里常见的封面/正文解密源按**字节游标**读流：
 * `var b=[]; for(var x=result.read(); x!==-1; x=result.read()) b.push(x&255);`
 * —— 缺 `read()/skip()/readNBytes()` 直接 TypeError（症状与「站点本来没加密」无法分辨）。
 */
test('图片解密⑥: InputStream 游标方法 read/skip/readNBytes（Legado「按字节读」写法）', () => {
  const r = asImageStreamResult(Uint8Array.from([1, 2, 3, 4, 5])) as unknown as {
    read: () => number;
    skip: (n: number) => number;
    readNBytes: (n: number) => Uint8Array;
    readAllBytes: () => Uint8Array;
  };
  assert.equal(r.read(), 1, 'read() 返回当前字节并前进游标');
  assert.equal(r.read(), 2);
  assert.equal(r.skip(1), 1, 'skip(n) 返回实际跳过数');
  assert.deepEqual([...r.readNBytes(2)], [4, 5], 'readNBytes(n) 连续取 n 字节');
  assert.equal(r.read(), -1, '读到尾返回 -1（Java InputStream 语义）');
  assert.equal(r.skip(10), 0, '已在末尾时 skip 返回 0');
  assert.deepEqual([...r.readNBytes(2)], [], '末尾 readNBytes 返回空数组');
  assert.deepEqual([...r.readAllBytes()], [1, 2, 3, 4, 5], '游标读到尾后 readAllBytes() 仍返回全长副本（独立，不共享位置）');
});

/* ──────────────────────────────────────────────────────────────────────────────
 * `D2` **标准参数 `decode{}`**
 *
 * 语料里的解密脚本大多只是「自己拼 key/iv + AES-CBC」。标准参数把可声明部分抽成
 * `{js, ivPrefixBytes, keyEncoding}`：`js` 只返回 key，IV 取图片前缀，其余交给
 * 服务端 `node:crypto` —— 好处是 **key 留在服务端，不下发前端**。
 *
 * 这里锁：规范化解析（字符串/对象/JSON 三态）、IV 切片、key 编码、AES-CBC 解密字节。
 * ────────────────────────────────────────────────────────────────────────────── */

/** 造「16 字节 IV 前缀 + AES-128-CBC/PKCS7 密文」样例，返回（图片字节, base64 key, 明文） */
function makeIvPrefixSample(): { image: Uint8Array; keyB64: string; plain: Buffer; iv: Buffer } {
  const iv = Buffer.from('abcdef0123456789'); // 16 字节
  const key = Buffer.from('0123456789abcdef'); // 16 字节 → AES-128
  const plain = Buffer.from('D2 标准参数解密：这是一段图片明文', 'utf8');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    image: new Uint8Array(Buffer.concat([iv, enc])),
    keyB64: key.toString('base64'),
    plain,
    iv,
  };
}

test('D2 ①: 16 字节 IV 前缀 + base64 key ⇒ 解出原始字节', () => {
  const { image, keyB64, plain } = makeIvPrefixSample();
  const spec = parseImageDecodeSpec({ js: 'ignored', ivPrefixBytes: 16, keyEncoding: 'base64' });
  assert.ok(spec);
  const out = decryptImageWithSpec(image, spec!, keyB64);
  assert.deepEqual(Buffer.from(out), plain);
});

test('D2 ②: 对象 / JSON 字符串 / 普通字符串三态规范化', () => {
  const fromObject = parseImageDecodeSpec({ js: 'key', ivPrefixBytes: 16, keyEncoding: 'hex' });
  assert.deepEqual(fromObject, { js: 'key', ivPrefixBytes: 16, keyEncoding: 'hex' });

  const fromJson = parseImageDecodeSpec('{"js":"key","ivPrefixBytes":16,"keyEncoding":"base64"}');
  assert.deepEqual(fromJson, { js: 'key', ivPrefixBytes: 16, keyEncoding: 'base64' });

  // 旧写法（普通脚本，含以 `{` 开头但 parse 不成对象的脚本）⇒ 原样当 js
  assert.deepEqual(parseImageDecodeSpec('result.readAllBytes()'), { js: 'result.readAllBytes()' });
  assert.deepEqual(parseImageDecodeSpec('{ let x = 1; result }'), { js: '{ let x = 1; result }' });
  assert.equal(parseImageDecodeSpec('null'), null);
  assert.equal(parseImageDecodeSpec(''), null);
  assert.equal(parseImageDecodeSpec({ js: '   ' }), null);
});

test('D2 ③: IV 切片 + key 编码（base64 / hex / utf8）', () => {
  const bytes = Uint8Array.from([...Array(16).fill(9), 1, 2, 3]);
  const { iv, ciphertext } = splitImageCipherBytes(bytes, 16);
  assert.equal(iv.length, 16);
  assert.deepEqual([...ciphertext], [1, 2, 3]);

  const raw = Uint8Array.from([1, 2, 3, 4]);
  assert.deepEqual([...decodeImageKeyBytes(raw)], [1, 2, 3, 4], '字节直接使用');
  assert.deepEqual([...decodeImageKeyBytes('01020304', 'hex')], [1, 2, 3, 4], 'hex');
  assert.deepEqual([...decodeImageKeyBytes('AQIDBA==', 'base64')], [1, 2, 3, 4], 'base64');
  assert.deepEqual([...decodeImageKeyBytes('abcd', 'utf8')], [0x61, 0x62, 0x63, 0x64], 'utf8 默认');
});

test('D2 ④: key 长度非法必须显式抛错（不得静默回传密文）', () => {
  const { image, plain } = makeIvPrefixSample();
  const spec = parseImageDecodeSpec({ js: 'k', ivPrefixBytes: 16, keyEncoding: 'base64' })!;
  assert.throws(() => decryptImageWithSpec(image, spec, Buffer.from('short').toString('base64')), /key 长度非法/);
  // 正常对照：同一份样例必须能解出，证明上一条不是「永远抛」
  const { keyB64 } = makeIvPrefixSample();
  assert.deepEqual(Buffer.from(decryptImageWithSpec(image, spec, keyB64)), plain);
});

test('D2 ⑤: 无 ivPrefixBytes 时不得走 AES 分支（旧脚本语义保持）', () => {
  const { image, keyB64 } = makeIvPrefixSample();
  const spec = parseImageDecodeSpec({ js: 'k', keyEncoding: 'base64' })!;
  assert.throws(() => decryptImageWithSpec(image, spec, keyB64), /ivPrefixBytes/);
});