/**
 * `#605`：`java.net.URL` + `HttpURLConnection` + 配套流（上游是真 JDK 类，按 JDK 契约移植）。
 *
 * ## 为什么锁
 * 番茄系（🍅番茄小说(APP) / 🍅番茄漫画(APP)）与花花短剧**不用 `java.ajax`**，而是手写 HTTP 客户端：
 * `URL(url).openConnection()` → `setRequestMethod/setRequestProperty` → `getOutputStream().write(bytes)`
 * → `getResponseCode()` → `getInputStream()/getErrorStream()` →（gzip）→ `BufferedReader.readLine()` 循环。
 * 本仓此前 `java.net` 整棵树落兜底 Proxy ⇒ `openConnection is not a function`（6 源）。
 *
 * 这里用**注入的假传输**跑完整链路（不联网、可离线复核），重点锁 JDK 的几条硬语义：
 *  · ≥400 时 `getInputStream()` **必须抛**，错误体只能从 `getErrorStream()` 取；
 *  · `BufferedReader.readLine()` 读到末尾返回 **null**（番茄的 while 循环靠它终止）；
 *  · `getPort()` 未显式给时返回 **-1**，`getDefaultPort()` 才是 80/443；
 *  · `openConnection()` **不发请求**（发在 getResponseCode/getInputStream 时）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';
import { wireJavaNetTransport } from '../selector/java-net';

const ev = createJsEvaluator({ variables: createVariableStore() });
const run = (code: string): string => String(ev(code, { baseUrl: 'https://x.test', source: {} }));

test('URL getter：protocol/host/port(-1)/defaultPort/path/query/ref', () => {
  const j = JSON.parse(
    run(`(function(){
      var u = new Packages.java.net.URL('https://a.example.com:8443/p/q.js?a=1#frag');
      return JSON.stringify({p:u.getProtocol(), h:u.getHost(), port:u.getPort(), dp:u.getDefaultPort(),
        path:u.getPath(), q:u.getQuery(), ref:u.getRef(), f:u.getFile(), s:String(u)});
    })()`),
  ) as Record<string, unknown>;
  assert.equal(j['p'], 'https');
  assert.equal(j['h'], 'a.example.com');
  assert.equal(j['port'], 8443);
  assert.equal(j['dp'], 443);
  assert.equal(j['path'], '/p/q.js');
  assert.equal(j['q'], 'a=1');
  assert.equal(j['ref'], 'frag');
  assert.equal(j['f'], '/p/q.js?a=1');
  // 未给端口 → -1（JDK 语义），defaultPort 才是 443
  const j2 = JSON.parse(run(`(function(){var u=new Packages.java.net.URL('http://b.test/x');return JSON.stringify({port:u.getPort(),dp:u.getDefaultPort()});})()`)) as Record<
    string,
    unknown
  >;
  assert.equal(j2['port'], -1);
  assert.equal(j2['dp'], 80);
});

test('openConnection 全链路：惰性发送 + POST body + header + 状态码 + 流', () => {
  const seen: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  wireJavaNetTransport((req) => {
    seen.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      ...(req.body ? { body: Buffer.from(req.body).toString('utf-8') } : {}),
    });
    return { code: 200, headers: { 'content-type': 'application/json' }, body: new Uint8Array(Buffer.from('{"ok":1}')) };
  });
  try {
    const out = run(`(function(){
      var c = new Packages.java.net.URL('https://api.test/hpost').openConnection();
      // 还没发请求（openConnection 不等于 connect）
      c.setRequestMethod('POST');
      c.setDoOutput(true);
      c.setRequestProperty('X-Token','t1');
      c.setConnectTimeout(20000);
      c.setReadTimeout(25000);
      var os = c.getOutputStream();
      var b = new Packages.java.lang.String('{"a":1}').getBytes('UTF-8');
      os.write(b, 0, b.length);
      os.flush(); os.close();
      var code = c.getResponseCode();
      var is = c.getInputStream();
      var sb = '';
      var rd = new Packages.java.io.BufferedReader(new Packages.java.io.InputStreamReader(is, 'UTF-8'));
      var line;
      while ((line = rd.readLine()) != null) sb += String(line);
      rd.close();
      return JSON.stringify({code:code, body:sb, enc:c.getHeaderField('Content-Type'), len:c.getContentLength()});
    })()`);
    const j = JSON.parse(out) as Record<string, unknown>;
    assert.equal(j['code'], 200);
    assert.equal(j['body'], '{"ok":1}');
    assert.equal(j['enc'], 'application/json');
    assert.equal(j['len'], 8);
    // 请求侧：方法/头/体都按脚本设置发出
    assert.equal(seen.length, 1, 'getResponseCode 时才发一次请求');
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.headers['X-Token'], 't1');
    assert.equal(seen[0]?.body, '{"a":1}');
  } finally {
    wireJavaNetTransport(null);
  }
});

test('JDK 硬语义：≥400 时 getInputStream 抛、错误体走 getErrorStream', () => {
  wireJavaNetTransport(() => ({ code: 404, headers: {}, body: new Uint8Array(Buffer.from('not found')) }));
  try {
    const out = run(`(function(){
      var c = new Packages.java.net.URL('https://api.test/404').openConnection();
      var code = c.getResponseCode();
      var inErr = '';
      try { c.getInputStream(); inErr = 'NO_THROW'; } catch (e) { inErr = 'THREW'; }
      var es = c.getErrorStream();
      var rd = new Packages.java.io.BufferedReader(new Packages.java.io.InputStreamReader(es, 'UTF-8'));
      return JSON.stringify({code:code, inErr:inErr, err: String(rd.readLine())});
    })()`);
    const j = JSON.parse(out) as Record<string, unknown>;
    assert.equal(j['code'], 404);
    assert.equal(j['inErr'], 'THREW', 'JDK：getInputStream 在 >=400 必须抛 IOException');
    assert.equal(j['err'], 'not found');
  } finally {
    wireJavaNetTransport(null);
  }
});

test('GZIPInputStream：gzip 头解压，非 gzip 原样透传', () => {
  const gz = new Uint8Array(gzipSync(Buffer.from('压缩正文')));
  const gzJson = JSON.stringify(Array.from(gz));
  const plainJson = JSON.stringify(Array.from(Buffer.from('原始正文')));
  const out = run(`(function(){
    function readAll(bytes){
      var is = { _bytes: new Uint8Array(bytes) };
      var g = new Packages.java.util.zip.GZIPInputStream(is);
      var rd = new Packages.java.io.BufferedReader(new Packages.java.io.InputStreamReader(g, 'UTF-8'));
      var s = '', line;
      while ((line = rd.readLine()) != null) s += String(line);
      return s;
    }
    return JSON.stringify({gz: readAll(${gzJson}), plain: readAll(${plainJson})});
  })()`);
  const j = JSON.parse(out) as Record<string, unknown>;
  assert.equal(j['gz'], '压缩正文', 'gzip 头（1f 8b）必须解压');
  assert.equal(j['plain'], '原始正文', '非 gzip 原样透传（源常无条件包一层）');
});

test('BufferedReader.readLine：末行不多给空行，末尾返回 null', () => {
  /* 注意：必须用**真换行**（TS 里写 \n 单反斜杠），双反斜杠会变成字面上的 "\\n" 两个字符 */
  const srcText = 'a\nb\r\nc\n';
  const out = run(`(function(){
    var txt = new Uint8Array(${JSON.stringify(Array.from(Buffer.from(srcText)))});
    var rd = new Packages.java.io.BufferedReader(new Packages.java.io.InputStreamReader({_bytes:txt}, 'UTF-8'));
    var lines = [], line, guard = 0;
    while ((line = rd.readLine()) != null && guard++ < 10) lines.push(String(line));
    return JSON.stringify(lines);
  })()`);
  assert.deepEqual(JSON.parse(out), ['a', 'b', 'c'], 'CRLF 也要切开；以换行结尾时不额外产出空行');
});
