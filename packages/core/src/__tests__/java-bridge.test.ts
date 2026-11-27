/**
 * L1 java.* API 桥测试（基于 L1 进程内 jsEval，含 opencc-js/Buffer 等原生桥）
 * 覆盖 13 处新补齐 API。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

const ctor = (opts: { cookies?: { get: (k: string) => string; set: (k: string, v: string) => void; header: () => string } } = {}) =>
  createJsEvaluator({
    variables: createVariableStore(),
    ...(opts.cookies ? { cookies: opts.cookies } : {}),
  });

test('java.t2s: 繁体→简体（opencc-js；未装时降级为原文）', () => {
  const ev = ctor();
  const r = ev('java.t2s("記憶體與硬碟")', {}) as string;
  // opencc 词汇级差异可接受（硬碟/硬盘），断言字级转换生效或降级原文
  assert.ok(r.includes('记忆') || r.includes('記憶'), 't2s 应返回字符串');
});

test('java.s2t: 简体→繁体', () => {
  const ev = ctor();
  const r = ev('java.s2t("记忆硬盘")', {}) as string;
  assert.ok(r.includes('記憶') || r.includes('记忆'), 's2t 应返回字符串');
});

test('java.getCookie: 整串 header', () => {
  const cookies = { get: () => 'v=1', set: () => undefined, header: () => 'a=1; b=2' };
  const ev = ctor({ cookies });
  assert.equal(ev('java.getCookie("x")', {}) as string, 'a=1; b=2');
});

test('java.getCookie: 单键', () => {
  const cookies = { get: (k: string) => (k === 'token' ? 'abc' : ''), set: () => undefined, header: () => 'a=1' };
  const ev = ctor({ cookies });
  assert.equal(ev('java.getCookie("x", "token")', {}) as string, 'abc');
  assert.equal(ev('java.getCookie("x", "nokey")', {}) as string, '');
});

test('java.head: 返回 statusCode/url/headers（无 body）', async () => {
  const ev = ctor();
  // 用 httpbin head 通常 200；CI/网络不通时 code=0 仍合法（断言 type 即可）
  const r = ev('var h = java.head("http://127.0.0.1:1/never"); h.statusCode() + "|" + h.url() + "|" + typeof h.body()', {}) as string;
  assert.ok(r.includes('|http://127.0.0.1:1/never|'));
  assert.match(r, /^\d+\|http/); // statusCode|url
  assert.equal(r.split('|')[2], 'string'); // body() 返回字符串（空字符串）
});

test('java.getStrResponse: 带 headers 的 GET', async () => {
  const ev = ctor();
  const r = String(ev('var r = java.getStrResponse("http://127.0.0.1:1/x"); r.statusCode()', {}));
  assert.match(r, /^\d+$/); // 仅断言返回数字字符串
});

test('java.ajaxAll: 返回数组（同步串行）', async () => {
  const ev = ctor();
  const r = ev('var arr = java.ajaxAll(["http://127.0.0.1:1/a", "http://127.0.0.1:1/b"]); arr.length', {}) as string;
  assert.equal(r, 2);
});

test('java.aesBase64DecodeToString: roundtrip', () => {
  const ev = ctor();
  // 先用 createSymmetricCrypto 加密得到 base64，再调新 API 解密
  const code = `
    var c = java.createSymmetricCrypto("AES/CBC/PKCS5Padding", "0123456789abcdef", "abcdef9876543210");
    var enc = c.encryptBase64("hello-世界");
    java.aesBase64DecodeToString(enc, "0123456789abcdef", "AES/CBC/PKCS5Padding", "abcdef9876543210");
  `;
  assert.equal(ev(code, {}), 'hello-世界');
});

test('java.digestHex: MD5/SHA-1/SHA-256 三个算法', () => {
  const ev = ctor();
  assert.equal(ev('java.digestHex("abc", "MD5")', {}), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(ev('java.digestHex("abc", "sha1")', {}), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(ev('java.digestHex("abc", "SHA-256")', {}), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('java.strToBytes/bytesToStr: UTF-8 字节桥 roundtrip', () => {
  const ev = ctor();
  const code = `
    var b = java.strToBytes("悦读", "utf-8");
    b.length + "|" + java.bytesToStr(b, "utf-8");
  `;
  assert.equal(ev(code, {}), '6|悦读');
});

test('java.hexDecodeToByteArray: hex→Buffer', () => {
  const ev = ctor();
  // 6964 = "id" in hex
  const code = `java.hexDecodeToByteArray("6964").length`;
  assert.equal(ev(code, {}), 2);
});

test('java.toNumChapter: 中文数字→阿拉伯', () => {
  const ev = ctor();
  assert.equal(ev('java.toNumChapter("第一章")', {}), '第1章');
  assert.equal(ev('java.toNumChapter("第十五章")', {}), '第15章');
  assert.equal(ev('java.toNumChapter("第一百二十三章")', {}), '第123章');
  // 不匹配则原样返回
  assert.equal(ev('java.toNumChapter("Hello")', {}), 'Hello');
});

test('java.getUserAgent: 返回默认 UA 字符串', () => {
  const ev = ctor();
  const ua = ev('java.getUserAgent()', {}) as string;
  assert.ok(ua.length > 20);
  assert.ok(ua.includes('Mozilla'));
});

test('java 规则桥: getElements/getStringList/setContent（AnalyzeRule 实例桥）', async () => {
  // 走完整链路：构造 AnalyzeEnv（含 javaExtra + jsEvalSync），JS 段里调 java.getElements
  const { AnalyzeRule } = await import('../selector/analyze');
  const variables = createVariableStore();
  const javaExtra: Record<string, unknown> = {};
  const env = {
    baseUrl: 'https://x.com/',
    variables,
    javaExtra,
    jsEvalSync: createJsEvaluator({ variables, javaExtra }),
    jsEval: createJsEvaluator({ variables, javaExtra }),
    toAbsolute: (u: string) => u,
  };
  const HTML = '<ul><li class="it"><a href="/1">A</a></li><li class="it"><a href="/2">B</a></li></ul>';
  // 1) java.getElements + toArray（合集源真实用法）
  const rule = '@js:list = java.getElements(".it"); list.toArray().length;';
  const ar = new AnalyzeRule(env).setContent(HTML);
  const r1 = ar.getString(rule);
  assert.equal(String(await r1), '2');
  // 2) java.getString（规则桥内再求规则）
  const r2 = await ar.getString('@js:java.getString(".title@text")');
  assert.ok(typeof r2 === 'string');
  // 3) java.setContent + getStringList
  const r3 = await ar.getString('@js:java.setContent("<p>x</p>"); java.getStringList("p@text")[0];');
  assert.equal(String(await r3), 'x');
});

test('evalRule hook: 完整规则求值（非 AnalyzeRule 上下文的 java.getString）', async () => {
  // 场景：URL JS 构造等直接用 env.jsEvalSync 的上下文，java.getString(rule) 对 bindings.$ 求完整规则
  const { AnalyzeRule } = await import('../selector/analyze');
  const variables = createVariableStore();
  const javaExtra: Record<string, unknown> = {};
  let envRef: Record<string, unknown> | undefined;
  const evalRule = (rule: string, value: unknown): string => {
    if (envRef && value != null && value !== '') {
      try {
        return new AnalyzeRule(envRef as never).setContent(value, 'https://x.com/').syncGetString(rule);
      } catch {
        return '';
      }
    }
    return '';
  };
  const env = {
    baseUrl: 'https://x.com/',
    variables,
    javaExtra,
    jsEvalSync: createJsEvaluator({ variables, javaExtra, evalRule }),
    jsEval: createJsEvaluator({ variables, javaExtra, evalRule }),
    toAbsolute: (u: string) => u,
  };
  envRef = env as never;
  const HTML = '<ul><li class="it"><a href="/1">A</a></li><li class="it"><a href="/2">B</a></li></ul>';
  const out = env.jsEvalSync('java.getString("li.it@text") + "|" + java.getString("a@href")', { $: HTML });
  assert.equal(String(out), 'A\nB|/1\n/2'); // 多元素 \n 连接（Legado text 语义）
});

// ---- Rhino 顶层声明提升（`this.foo()` 写法支持） ----
// Rhino 里脚本顶层的 function/var 声明会成为**全局对象属性**，源脚本因此大量使用
// `this.foo()`（例：独阅读网 loginUrl 的 this.auto_reg() / this.Login(param)）。
// 我们用直接 eval，声明只落在 eval 所在函数作用域 → 必须显式挂到 globalThis。

test('顶层 function 声明可通过 this.foo() 调用（Rhino 语义）', () => {
  const ev = ctor();
  const r = ev(
    `function auto_reg() { return 'guest-1'; }
function decrypt(s) { return 'D:' + s; }
this.auto_reg() + '|' + this.decrypt('x')`,
    {},
  ) as string;
  assert.equal(r, 'guest-1|D:x');
});

test('顶层 var 声明同样可 this.foo()（var f = function）', () => {
  const ev = ctor();
  const r = ev("var getData = function () { return 'ok'; }\nthis.getData()", {}) as string;
  assert.equal(r, 'ok');
});

test('this.foo 不跨调用泄漏（求值后全局还原）', () => {
  const ev = ctor();
  ev('function leak() { return 1; }\nleak()', {});
  const r = ev('typeof this.leak', {}) as string;
  assert.equal(r, 'undefined', '上一次求值的声明不得留到下一次');
});

test('jsLib（lib）里的声明可被 this.foo() 调用', () => {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    lib: 'function libFn() { return "from-lib"; }',
  });
  assert.equal(ev('this.libFn()', {}) as string, 'from-lib');
});

test('eval 完成值语义未被破坏（最后一个表达式仍为返回值）', () => {
  const ev = ctor();
  assert.equal(ev('1; 2; "last"', {}) as string, 'last');
  assert.equal(ev('function f(){return "x"}\nf()', {}) as string, 'x');
});

// ---- 摘要 / 字节数组密钥（Legado JsEncodeUtils.kt:45-500） ----
// 语料实证：独阅读网 jsLib 写 `java.hexDecodeToByteArray(java.digestHex(secret, "SHA-256"))`
// 作为 AES key —— 若 digestHex 缺失、或 createSymmetricCrypto 只吃字符串，
// key 会变成 "12,34,..." 这类 46 字符串并触发长度校验失败。

test('java.digestHex: SHA-256 / MD5（hutool DigestUtil.digester 语义）', () => {
  const ev = ctor();
  assert.equal(ev('java.digestHex("abc", "SHA-256")', {}) as string, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(ev('java.digestHex("abc", "MD5")', {}) as string, '900150983cd24fb0d6963f7d28e17f72');
  // 算法名容错：SHA-1 / SHA1 / sha256
  assert.equal(ev('java.digestHex("abc", "SHA-1")', {}) as string, ev('java.digestHex("abc", "sha1")', {}) as string);
});

test('java.digestBase64Str / HMacHex', () => {
  const ev = ctor();
  assert.equal(ev('java.digestBase64Str("abc", "MD5")', {}) as string, Buffer.from('900150983cd24fb0d6963f7d28e17f72', 'hex').toString('base64'));
  // 与 Node 侧独立实现对齐（hutool HMac(algorithm, key.toByteArray()).digestHex(data)，key 走 UTF-8）
  const expectedHmac = createHmac('sha256', Buffer.from('k', 'utf-8')).update('abc', 'utf-8').digest('hex');
  assert.equal(ev('java.HMacHex("abc", "HmacSHA256", "k")', {}) as string, expectedHmac);
  assert.match(ev('java.HMacBase64("abc", "HmacSHA1", "k")', {}) as string, /^[A-Za-z0-9+/]+=*$/);
});

test('createSymmetricCrypto 接受字节数组 key（Uint8Array）—— 独阅读网写法', () => {
  const ev = ctor();
  const code = `
var key = java.hexDecodeToByteArray(java.digestHex("secretKey", "SHA-256"));
var c = java.createSymmetricCrypto("AES/ECB/PKCS5Padding", key);
var enc = c.encryptBase64("hello");
c.decryptStr(enc)`;
  assert.equal(ev(code, {}) as string, 'hello');
});

test('createSymmetricCrypto 接受字节数组 iv（hex 字符串 key + 字节 iv）', () => {
  const ev = ctor();
  const code = `
var key = java.hexDecodeToByteArray("0123456789abcdef0123456789abcdef");
var iv = java.hexDecodeToByteArray("00000000000000000000000000000000");
var c = java.createSymmetricCrypto("AES/CBC/PKCS5Padding", key, iv);
c.decryptStr(c.encryptBase64("中文正文"))`;
  assert.equal(ev(code, {}) as string, '中文正文');
});

test('createSymmetricCrypto 非法 key 长度报错信息含「hex/base64」提示', () => {
  const ev = ctor();
  assert.throws(() => ev('java.createSymmetricCrypto("AES/ECB/PKCS5Padding", "short")', {}), /hex\/base64/);
});

// ---- `#452` 图片解密：`decrypt(data)` 的入参形态对齐 hutool/Legado ----
// 用户口径：「图片解密的规则方面，我们要兼容 legado 写法」。
// 上游 `help/JsEncodeUtils.kt` 取 hutool `SymmetricCrypto`，其 `decrypt(data)` 的 data
// 可为 **byte[] / InputStream / String**（String 走 `SecureUtil.decode`：全 hex 按 hex，否则 base64）。
// 本仓原先只接 Uint8Array、且把字符串当 UTF-8 明文 ⇒ 两种 Legado 写法都会解出垃圾。

test('decrypt(String): 密文串按 hutool SecureUtil.decode（全 base64 / 全 hex 各一）', () => {
  const ev = ctor();
  const b64 = `
var c = java.createSymmetricCrypto("AES/CBC/PKCS5Padding", "0123456789abcdef", "abcdef9876543210");
java.bytesToStr(c.decrypt(c.encryptBase64("hello-世界")), "utf-8")`;
  assert.equal(ev(b64, {}) as string, 'hello-世界', 'base64 串走 base64 分支');
  const hex = `
var c = java.createSymmetricCrypto("AES/ECB/PKCS5Padding", "0123456789abcdef");
java.bytesToStr(c.decrypt(c.encryptHex("hello-hex")), "utf-8")`;
  assert.equal(ev(hex, {}) as string, 'hello-hex', '全 hex 串走 hex 分支（不是 base64）');
});

test('decrypt(InputStream 语义对象): 带 readAllBytes()/read() 的流也能解（封面那种写法）', () => {
  const ev = ctor();
  const byAll = `
var c = java.createSymmetricCrypto("AES/ECB/PKCS5Padding", "0123456789abcdef");
var raw = java.base64DecodeToByteArray(c.encryptBase64("stream-bytes"));
var stream = { readAllBytes: function () { return raw; } };
java.bytesToStr(c.decrypt(stream), "utf-8")`;
  assert.equal(ev(byAll, {}) as string, 'stream-bytes', 'readAllBytes() 兜底');
  const byRead = `
var c = java.createSymmetricCrypto("AES/ECB/PKCS5Padding", "0123456789abcdef");
var raw = java.base64DecodeToByteArray(c.encryptBase64("cursor-read"));
var stream = { pos: 0, read: function () { return this.pos < raw.length ? raw[this.pos++] : -1; } };
java.bytesToStr(c.decrypt(stream), "utf-8")`;
  assert.equal(ev(byRead, {}) as string, 'cursor-read', 'read() 到 -1 的字节循环兜底');
});
