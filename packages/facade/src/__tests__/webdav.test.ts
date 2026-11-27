/**
 * `#208` WebDAV 客户端单测（HTTP 打桩 + 真实形态的 `207 Multi-Status` 报文）。
 *
 * ★ 防空转约定：每个「回落/拒绝」用例旁都有能通过的对照（同函数、换入参）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HttpRequestOptions, HttpResponse, WebDavConfig } from '@yuedu/core';
import { WebDavClient, parsePropFind } from '../webdav';

const CFG: WebDavConfig = {
  url: 'https://dav.example.com/dav',
  username: 'u',
  password: 'p',
  dir: 'legado',
  authEncoding: 'utf-8',
};

/** 打桩 HTTP：记录每次调用，按队列回响应 */
function stubHttp(...responses: Array<Partial<HttpResponse> | ((o: HttpRequestOptions) => Partial<HttpResponse>)>) {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: unknown }> = [];
  let i = 0;
  const http = {
    request: async (url: string, o: HttpRequestOptions = {}): Promise<HttpResponse> => {
      calls.push({ url, method: o.method, headers: o.headers, body: o.body });
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      const r = typeof next === 'function' ? next(o) : next;
      return { status: 200, headers: {}, body: '', url, ...r } as HttpResponse;
    },
  };
  return { calls, http };
}

/* ── XML 解析 ────────────────────────────────────────────────────── */

const NS_XML = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/legado/bookProgress/</d:href>
    <d:propstat><d:prop>
      <d:displayname>bookProgress</d:displayname>
      <d:resourcetype><d:collection/></d:resourcetype>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/legado/bookProgress/%E7%94%B2_%E4%B9%99.json</d:href>
    <d:propstat><d:prop>
      <d:displayname>甲_乙.json</d:displayname>
      <d:getcontentlength>123</d:getcontentlength>
      <d:getlastmodified>Wed, 21 Oct 2015 07:28:00 GMT</d:getlastmodified>
      <d:getcontenttype>application/json</d:getcontenttype>
      <d:resourcetype/>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

test('#208 解析 207：带 DAV: 前缀前缀的报文 —— 目录/文件/大小/时间/绝对地址', () => {
  const files = parsePropFind(NS_XML, 'https://dav.example.com/dav/legado/bookProgress/');
  assert.equal(files.length, 2);

  const dir = files[0];
  assert.ok(dir);
  if (!dir) return;
  assert.equal(dir.isDir, true, 'resourcetype 含 collection ⇒ 目录');
  assert.equal(dir.displayName, 'bookProgress');
  assert.equal(dir.url, 'https://dav.example.com/dav/legado/bookProgress/', '相对 href 补成绝对地址 + 目录补尾斜杠');

  const file = files[1];
  assert.ok(file);
  if (!file) return;
  assert.equal(file.isDir, false);
  assert.equal(file.displayName, '甲_乙.json', 'displayname 优先于从 href 推出来的名字');
  assert.equal(file.size, 123);
  assert.equal(file.lastModify, Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'));
  assert.equal(file.url, 'https://dav.example.com/dav/legado/bookProgress/甲_乙.json', 'href 里的百分号转义要解回中文');
});

test('#208 解析 207：服务器不声明 DAV: 前缀（localName 兜底）也要解得出', () => {
  const plain = `<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/dav/x.json</href>
    <propstat><prop><getcontentlength>7</getcontentlength><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;
  const files = parsePropFind(plain, 'https://dav.example.com/dav/');
  assert.equal(files.length, 1);
  assert.equal(files[0]?.displayName, 'x.json', 'displayname 缺失 ⇒ 从 href 末段取');
  assert.equal(files[0]?.size, 7);
  assert.equal(files[0]?.isDir, false);
});

test('#208 解析 207：getlastmodified 解析不出 ⇒ 回落 0（不是 NaN，上游也是 0）', () => {
  const bad = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>
    <d:href>/dav/a.json</d:href><d:propstat><d:prop><d:getlastmodified>不是日期</d:getlastmodified></d:prop></d:propstat>
  </d:response></d:multistatus>`;
  const files = parsePropFind(bad, 'https://dav.example.com/dav/');
  assert.equal(files[0]?.lastModify, 0);
  assert.equal(Number.isNaN(files[0]?.lastModify), false);
});

test('#208 解析 207：没有 href 的条目被跳过（不产生半截数据）', () => {
  const weird = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
    <d:response><d:propstat><d:prop><d:displayname>无href</d:displayname></d:prop></d:propstat></d:response>
    <d:response><d:href>/dav/b.json</d:href></d:response>
  </d:multistatus>`;
  const files = parsePropFind(weird, 'https://dav.example.com/dav/');
  assert.equal(files.length, 1);
  assert.equal(files[0]?.displayName, 'b.json');
});

/* ── 客户端动作 ──────────────────────────────────────────────────── */

test('#208 PROPFIND：Depth=1、带 Basic 头、请求体是 XML', async () => {
  const stub = stubHttp({ status: 207, body: NS_XML });
  const c = new WebDavClient(CFG, { http: stub.http });
  await c.propfind('https://dav.example.com/dav/legado/bookProgress/');
  const call = stub.calls[0];
  assert.ok(call);
  if (!call) return;
  assert.equal(call.method, 'PROPFIND');
  assert.equal(call.headers?.['Depth'], '1');
  assert.equal(call.headers?.['Authorization'], `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.match(String(call.body), /<a:propfind xmlns:a="DAV:">/);
});

test('#208 listFiles：不含目录自己（对齐上游 it.path != path 的过滤）', async () => {
  const stub = stubHttp({ status: 207, body: NS_XML });
  const c = new WebDavClient(CFG, { http: stub.http });
  const url = 'https://dav.example.com/dav/legado/bookProgress/';
  const files = await c.listFiles(url);
  assert.equal(files.length, 1, '两条里过滤掉了被请求的那个目录本身');
  assert.equal(files[0]?.displayName, '甲_乙.json');
  // 对照：不过滤的话是 2 条 —— 证明过滤真的生效了
  assert.equal(parsePropFind(NS_XML, url).length, 2);
});

test('#208 exists：2xx 即存在；404 返回 false；**其它错误不能被当成「不存在」吞掉**', async () => {
  const okStub = stubHttp({ status: 207, body: NS_XML });
  assert.equal(await new WebDavClient(CFG, { http: okStub.http }).exists(), true);

  const missStub = stubHttp({ status: 404, body: 'not found' });
  assert.equal(await new WebDavClient(CFG, { http: missStub.http }).exists(), false);

  // ★ 500 必须继续抛（若被吞成 false，用户会看到「已创建」但实际没建）
  const errStub = stubHttp({ status: 500, body: 'boom' });
  await assert.rejects(() => new WebDavClient(CFG, { http: errStub.http }).exists(), /HTTP 500|boom|未知错误/);
});

test('#208 check：401 ⇒ unauthorized（不是「通过」）· 网络异常 ⇒ unreachable · 2xx ⇒ 通过', async () => {
  const bad = new WebDavClient(CFG, { http: stubHttp({ status: 401 }).http });
  const r1 = await bad.check();
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.kind, 'unauthorized');

  // ★ 与上游的差异：连不上**不再**回 true（上游 getOrDefault(true) 是假通过）
  const down = new WebDavClient(CFG, {
    http: {
      request: async () => {
        throw new Error('DNS 解析失败');
      },
    },
  });
  const r2 = await down.check();
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.kind, 'unreachable');

  const good = new WebDavClient(CFG, { http: stubHttp({ status: 207, body: NS_XML }).http });
  assert.deepEqual(await good.check(), { ok: true });
});

test('#208 makeAsDir：已存在则**不发 MKCOL**；不存在才发；MKCOL 失败只返回 false 不抛', async () => {
  const exists = stubHttp({ status: 207, body: NS_XML });
  const c1 = new WebDavClient(CFG, { http: exists.http });
  assert.equal(await c1.makeAsDir('https://dav.example.com/dav/legado/'), true);
  assert.equal(exists.calls.filter((x) => x.method === 'MKCOL').length, 0, '已存在不该再建一次');

  const mkdir = stubHttp({ status: 404, body: '' }, { status: 201, body: '' });
  const c2 = new WebDavClient(CFG, { http: mkdir.http });
  assert.equal(await c2.makeAsDir('https://dav.example.com/dav/legado/'), true);
  assert.equal(mkdir.calls.filter((x) => x.method === 'MKCOL').length, 1);

  // 405（目录已存在但 PROPFIND 不给 2xx）⇒ 留痕并返回 false，同步仍继续
  const noop = stubHttp({ status: 404, body: '' }, { status: 405, body: '' });
  const c3 = new WebDavClient(CFG, { http: noop.http });
  assert.equal(await c3.makeAsDir('https://dav.example.com/dav/legado/'), false);
});

test('#208 upload：PUT + Content-Type；overwrite=false 带 If-None-Match', async () => {
  const stub = stubHttp({ status: 201, body: '' }, { status: 201, body: '' });
  const c = new WebDavClient(CFG, { http: stub.http });
  await c.upload('https://dav.example.com/dav/legado/a.json', '{"a":1}', 'application/json');
  assert.equal(stub.calls[0]?.method, 'PUT');
  assert.equal(stub.calls[0]?.headers?.['Content-Type'], 'application/json');
  assert.equal(stub.calls[0]?.body, '{"a":1}');

  await c.upload('https://dav.example.com/dav/legado/a.json', 'x', 'text/plain', false);
  assert.equal(stub.calls[1]?.headers?.['If-None-Match'], '*');
  // 对照：默认覆盖时**不带**该头
  assert.equal(stub.calls[0]?.headers?.['If-None-Match'], undefined);
});

test('#208 上传失败：401 的文案要区分「密码不对」和「服务器不要 Basic」', async () => {
  const c1 = new WebDavClient(CFG, { http: stubHttp({ status: 401, headers: {} }).http });
  await assert.rejects(() => c1.upload('https://x/a', '1'), /账号或密码不对|应用专用密码/);

  const c2 = new WebDavClient(CFG, {
    http: stubHttp({ status: 401, headers: { 'WWW-Authenticate': 'Digest realm="x"' } }).http,
  });
  await assert.rejects(() => c2.upload('https://x/a', '1'), /不接受 Basic 认证/);
});

test('#208 downloadText / downloadBytes：文本按 UTF-8，二进制走 arraybuffer', async () => {
  const t = new WebDavClient(CFG, { http: stubHttp({ status: 200, body: '{"ok":1}' }).http });
  assert.equal(await t.downloadText('https://x/a.json'), '{"ok":1}');

  const bytes = new Uint8Array([1, 2, 3]);
  const b = new WebDavClient(CFG, {
    http: stubHttp({ status: 200, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 3) }).http,
  });
  const got = await b.downloadBytes('https://x/a.bin');
  assert.deepEqual(Array.from(got), [1, 2, 3]);
});

test('#208 ensureDirs：根与 bookProgress 两个目录都建', async () => {
  const stub = stubHttp({ status: 404, body: '' }, { status: 201, body: '' }, { status: 404, body: '' }, { status: 201, body: '' });
  const c = new WebDavClient(CFG, { http: stub.http });
  const out = await c.ensureDirs();
  assert.deepEqual(out, { root: true, progress: true });
  const urls = stub.calls.filter((x) => x.method === 'MKCOL').map((x) => x.url);
  assert.deepEqual(urls, ['https://dav.example.com/dav/legado/', 'https://dav.example.com/dav/legado/bookProgress/']);
});
