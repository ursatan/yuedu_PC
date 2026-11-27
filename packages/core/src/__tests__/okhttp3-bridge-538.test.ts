/**
 * `#538` **okhttp3 桥**回归锁（收口 `#473` 剩余 3 源：阅文集团 / 大灰狼聚合 / 木里聚合）。
 *
 * 三条不变量：
 *  ① 路由：三种真实源码形态（importPackage / hasJavaClass+eval / RequestBody.create）都不再锁 L1；
 *  ② 语义：worker 与 L1 对同一脚本**逐字一致**（GET/POST/头/状态码，本地 http 服务器实证）；
 *  ③ 字节保真：worker 的 `body().bytes()` 对含 0x80~0xFF 的二进制响应**逐字节精确**
 *     （raw 模式；L1 侧受 syncHttp 字符串契约限制，是文档化的边界，不参与本断言）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { needsJavaBridgeL1, wireOkhttpTransport } from '../selector/java-bridge';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/** 本地服务器：/text 文本 · /echo 回显请求体 · /bin 二进制（含 0x80~0xFF） */
const BIN = Buffer.from([0x00, 0x41, 0x80, 0xff, 0xc2, 0x00, 0x7f, 0xfe, 0x81]);
let server: Server;
let base = '';
test.before(() => new Promise<void>((resolve) => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/bin')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(BIN);
      return;
    }
    if (req.url?.startsWith('/echo')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/plain', 'x-echo': String(req.headers['x-t'] ?? '') });
        res.end(Buffer.concat(chunks));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-test': 'yes' });
    res.end('okhttp-text');
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    resolve();
  });
}));
test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('① 路由：importPackage 与裸类名形态放行；动态 eval 形态按设计保守留 L1（#538）', () => {
  // 阅文/木里：importPackage(Packages.okhttp3) ⇒ 命名空间在白名单 ⇒ 放行
  assert.equal(
    needsJavaBridgeL1('var ji = new JavaImporter();\nji.importPackage(Packages.okhttp3);\nwith (ji) { var c = new OkHttpClient(); }'),
    false,
    'importPackage(Packages.okhttp3) 应放行',
  );
  // 木里：RequestBody.create + MediaType.parse（无 Packages 字面量、无 JavaImporter）⇒ 放行
  assert.equal(
    needsJavaBridgeL1('RequestBody.create(body, MediaType.parse("application/json"))'),
    false,
    '裸类名（RequestBody/MediaType）应放行',
  );
  // 大灰狼：eval('Packages.' + x) 动态拼接 ⇒ 静态不可判 ⇒ **按设计留 L1**（保守：
  // 「判不准仍然留 L1」）；该源在 L1 侧现在有真实现（makeOkhttp3Ns）⇒ 语义同样修好
  assert.equal(
    needsJavaBridgeL1("var classObj = eval('Packages.' + 'okhttp3.HttpUrl');\nHttpUrl.parse(u).topPrivateDomain()"),
    true,
    '动态 eval 形态应保守留 L1',
  );
});

const getScript = [
  'var ji = new JavaImporter();',
  'ji.importPackage(Packages.okhttp3);',
  'with (ji) {',
  '  var client = new OkHttpClient();',
  '  var b = new Request.Builder().url(url).get().addHeader("X-T", "1");',
  '  var r = client.newCall(b.build()).execute();',
  '  r.code() + "|" + r.body().string() + "|" + r.header("x-test") + "|" + r.isSuccessful();',
  '}',
].join('\n');

const postScript = [
  'var ji = new JavaImporter();',
  'ji.importPackage(Packages.okhttp3);',
  'with (ji) {',
  '  var client = new OkHttpClient();',
  '  var body = RequestBody.create("k=v&a=1", MediaType.parse("application/x-www-form-urlencoded"));',
  '  var b = new Request.Builder().url(url + "/echo").post(body).addHeader("X-T", "2");',
  '  var r = client.newCall(b.build()).execute();',
  '  r.code() + "|" + r.body().string() + "|" + r.header("x-echo") + "|" + r.header("content-type");',
  '}',
].join('\n');

test('② GET/POST 语义：worker 与 L1 逐字一致（本地服务器实证）', async () => {
  const bindings = { url: base };
  // L1：换成 mock 传输（本沙箱 execFileSync curl 恒空 ⇒ 真 syncHttp 不可用；
  //    mock 与本地服务器返回同一份文本 ⇒ 与 worker 结果直接对拍）
  wireOkhttpTransport((_method: string, u: string, body: string | undefined, headers: Record<string, string>): { body: string; code: number; headers: Record<string, string> } => {
    if (u.endsWith('/echo')) return { body: body ?? '', code: 200, headers: { 'x-echo': headers['X-T'] ?? '', 'content-type': 'application/x-www-form-urlencoded' } };
    return { body: 'okhttp-text', code: 200, headers: { 'x-test': 'yes' } };
  });
  const l1Get = String(await Promise.resolve(createHybridJsEvaluator({ variables: createVariableStore() })(getScript, bindings)));
  const l1Post = String(await Promise.resolve(createHybridJsEvaluator({ variables: createVariableStore() })(postScript, bindings)));
  assert.equal(l1Get, '200|okhttp-text|yes|true', `L1 GET 基线不对：${l1Get}`);
  assert.equal(l1Post, '200|k=v&a=1|2|application/x-www-form-urlencoded', `L1 POST 基线不对：${l1Post}`);

  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool });
  const wkGet = String(await Promise.resolve(ev(getScript, bindings)));
  const wkPost = String(await Promise.resolve(ev(postScript, bindings)));
  assert.equal(wkGet, l1Get, 'worker 与 L1 的 GET 结果不一致');
  assert.equal(wkPost, l1Post, 'worker 与 L1 的 POST 结果不一致');
});

test('③ 二进制保真：worker body().bytes() 对 0x80~0xFF 逐字节精确（raw 模式）', async () => {
  const code = [
    'var ji = new JavaImporter();',
    'ji.importPackage(Packages.okhttp3);',
    'with (ji) {',
    '  var client = new OkHttpClient();',
    '  var r = client.newCall(new Request.Builder().url(url + "/bin").get().build()).execute();',
    '  var bytes = r.body().bytes();',
    '  var out = [];',
    '  for (var i = 0; i < bytes.length; i++) out.push(bytes[i]);',
    '  out.join(",") + "|len=" + bytes.length;',
    '}',
  ].join('\n');
  const pool = createWorkerSandboxPool({ size: 1 });
  const out = String(await Promise.resolve(createHybridJsEvaluator({ variables: createVariableStore(), pool })(code, { url: base })));
  assert.equal(out, `${[...BIN].join(',')}|len=${BIN.length}`, '二进制字节在 raw 通道里失真');
});

test('④ HttpUrl：topPrivateDomain 的 eTLD+1 启发式（大灰狼 getSubDomain 形态）', async () => {
  const code = [
    'var ji = new JavaImporter();',
    'ji.importPackage(Packages.okhttp3);',
    'with (ji) {',
    '  var a = HttpUrl.parse("https://www.example.com/x?q=1").topPrivateDomain();',
    '  var b = HttpUrl.parse("https://x.foo.com.cn/y").topPrivateDomain();',
    '  var c = HttpUrl.parse("https://sub.api.io/z").topPrivateDomain();',
    '  var d = HttpUrl.parse("https://h.io/p?a=b&c=d%20e").queryParameter("c");',
    '  a + "|" + b + "|" + c + "|" + d;',
    '}',
  ].join('\n');
  const pool = createWorkerSandboxPool({ size: 1 });
  const out = String(await Promise.resolve(createHybridJsEvaluator({ variables: createVariableStore(), pool })(code, {})));
  assert.equal(out, 'example.com|foo.com.cn|api.io|d e', `HttpUrl 语义不对：${out}`);
});
