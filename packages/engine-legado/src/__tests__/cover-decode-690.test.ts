/**
 * `#690` 封面解密：**黄果短剧那类标准 Java 流写法**必须在引擎里跑通。
 *
 * ## 缺陷现象
 * 橙果/黄果/荔枝（同一套短剧 CMS）的封面都做了 AES-128-CBC 打乱，源用 `coverDecodeJs` 解：
 * ```
 * var baos = new Packages.java.io.ByteArrayOutputStream();
 * var buf  = new Packages.java.lang.String('000…0').getBytes();
 * var n    = result.read(buf);
 * while (n > 0) { baos.write(buf, 0, n); n = result.read(buf); }
 * var enc = baos.toByteArray();
 * ```
 * 本仓两个垫片都只实现了**单参**重载：
 * · `InputStream.read(buf)` → 返回**读到的字节数**（Java 语义），旧实现落到无参分支返回 `b[cursor++]`
 *   ⇒ 拿到的是**首字节**（0…255）「当作长度」，`write(buf,0,n)` 只搬 n 个字节，且 `buf` 从未被填；
 * · `ByteArrayOutputStream.write(b, off, len)` → 旧实现忽略参数，把整个 `buf` 拼进去。
 * 两者叠加 ⇒ 拼出来的「密文」是垃圾 ⇒ 解密魔数不对 ⇒ 规则返回**原始字节** ⇒ 封面裂图。
 *
 * ⚠️ 这个失败**完全静默**：规则本身不抛错，`decodeImage` 拿到的是「合法的字节数组」，
 * 与「站点图片本来就没打乱」不可分辨 —— 所以必须用断言锁住字节级结果。
 *
 * 测试用的是**源里的规则原文**（不是改写版），并把密文按同一 key/iv 现场加密：
 * 一旦有人把 `read(buf)` 改回无参语义、或让 `write` 忽略 `off/len`，这里立刻红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv } from 'node:crypto';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://pic.test';

function makeCtx(): EngineContext {
  return {
    reqId: 'cover-690',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html></html>', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

/** 黄果短剧 / 橙果短剧共用的 key/iv（源规则里的字面量） */
const KEY = 'f5d965df75336270';
const IV = '97b60394abc2fbe1';

/** 源里 `coverDecodeJs` 的原文（只把 UA 之类无关部分保留原样，逻辑一字未改） */
const HG_COVER_DECODE = `(function(){
try{
var baos=new Packages.java.io.ByteArrayOutputStream();
var buf=new Packages.java.lang.String('00000000000000000000000000000000').getBytes();
var n=result.read(buf);
while(n>0){baos.write(buf,0,n);n=result.read(buf)}
var enc=baos.toByteArray();
if(!enc||enc.length<32)return enc;
var b0=(enc[0]+256)%256,b1=(enc[1]+256)%256,b2=(enc[2]+256)%256;
if((b0===255&&b1===216)||(b0===137&&b1===80&&b2===78)||(b0===71&&b1===73&&b2===70)||(b0===82&&b1===73&&b2===70))return enc;
if(enc.length%16!==0)return enc;
var Cipher=Packages.javax.crypto.Cipher;
var SKS=Packages.javax.crypto.spec.SecretKeySpec;
var IVS=Packages.javax.crypto.spec.IvParameterSpec;
var c=Cipher.getInstance('AES/CBC/NoPadding');
c.init(Cipher.DECRYPT_MODE,new SKS(new Packages.java.lang.String('${KEY}').getBytes('UTF-8'),'AES'),new IVS(new Packages.java.lang.String('${IV}').getBytes('UTF-8')));
var dec=c.doFinal(enc);
if(!dec||dec.length<32)return enc;
var eoi=-1;
for(var i=dec.length-2;i>0;i--){
  if((dec[i]+256)%256===255&&(dec[i+1]+256)%256===217){eoi=i;break}
}
if(eoi>0&&eoi+2<dec.length)return Packages.java.util.Arrays.copyOf(dec,eoi+2);
return dec;
}catch(e){return null}
})()`;

function aesEncrypt(plain: Buffer, key: string, iv: string, pad = false): Buffer {
  const c = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf-8'), Buffer.from(iv, 'utf-8'));
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(plain), c.final()]);
}

function makeRule(coverDecodeJs: string) {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '封面解密源',
    bookSourceType: 4,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: 'div.pages@html' },
    coverDecodeJs,
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

async function decodeCover(rule: ReturnType<typeof makeRule>, bytes: Buffer): Promise<Uint8Array | null> {
  return new LegadoEngine().decodeImage(
    rule as never,
    { url: `${BASE}/cover/1.jpg`, bytes: new Uint8Array(bytes), isCover: true },
    makeCtx(),
  );
}

/** 假的 JPEG（16 字节对齐，NoPadding 用） */
const PLAIN = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(60, 0x07),
]);

test('封面解密①: 黄果写法（read(buf) 循环 + write(buf,off,len)）解出原始字节', async () => {
  const encrypted = aesEncrypt(PLAIN, KEY, IV);
  assert.notEqual(String([...encrypted.slice(0, 4)]), String([...PLAIN.slice(0, 4)]), '密文魔数应与明文不同（前置条件）');
  const out = await decodeCover(makeRule(HG_COVER_DECODE), encrypted);
  assert.ok(out, '应返回字节（返回 null 说明脚本抛错 → 回原图 → 裂图）');
  assert.equal(
    Buffer.from(out).toString('hex'),
    PLAIN.toString('hex'),
    '解密后必须与原始字节完全一致（read(buf) 必须返回读到的字节数、并真的填满 buf）',
  );
});

test('封面解密②: 尾部有 EOI 之后的垃圾 ⇒ 截到 EOI 为止（Arrays.copyOf 生效）', async () => {
  // 明文 = JPEG 头 + 数据 + EOI + 8 字节对齐垃圾（密文仍需 16 字节对齐）
  const withEoi = Buffer.concat([PLAIN, Buffer.from([0xff, 0xd9]), Buffer.alloc(14, 0x00)]);
  assert.equal(withEoi.length % 16, 0, '测试素材需 16 字节对齐');
  const out = await decodeCover(makeRule(HG_COVER_DECODE), aesEncrypt(withEoi, KEY, IV));
  assert.ok(out);
  const hex = Buffer.from(out).toString('hex');
  assert.ok(hex.endsWith('ffd9'), `应截到 EOI（实际尾部 ${hex.slice(-16)}）`);
  assert.equal(out.length, PLAIN.length + 2, 'EOI 之后的多余字节必须被切掉');
});

test('封面解密③: 明文图（未打乱）原样返回，不能被「解密」成垃圾', async () => {
  // 魔数已是 JPEG ⇒ 规则第一段守卫直接返回 enc
  const out = await decodeCover(makeRule(HG_COVER_DECODE), PLAIN);
  assert.ok(out);
  assert.equal(Buffer.from(out).toString('hex'), PLAIN.toString('hex'));
});

test('封面解密④: 非 16 倍数的密文 ⇒ 原样返回（不抛错、不判死）', async () => {
  const odd = Buffer.concat([Buffer.from([0x11, 0x22, 0x33]), Buffer.alloc(13, 0x05)]);
  const out = await decodeCover(makeRule(HG_COVER_DECODE), odd);
  assert.ok(out);
  assert.equal(Buffer.from(out).toString('hex'), odd.toString('hex'));
});
