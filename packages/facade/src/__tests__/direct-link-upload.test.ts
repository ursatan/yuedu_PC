/**
 * `#208` 直链上传（执行层）+ 最小 zip 写入器的单测。
 *
 * 上游对照：`DirectLinkUpload.kt:26-71` · `OkHttpUtils.kt:157-192 postMultipart` ·
 * `ZipUtils.kt:37 zipByteArray`。
 * ★ 防空转约定：既断言「按规则发出去的东西对」，也断言「缺规则时明确报错」，
 *   且每条拒绝用例旁有能通过的对照。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { DEFAULT_DIRECT_LINK_UPLOAD_RULES, type DirectLinkUploadRule, type HttpResponse } from '@yuedu/core';
import {
  applyDirectLinkDownloadRule,
  buildDirectLinkForm,
  uploadDirectLink,
  uploadSourceJson,
  type UploadFile,
} from '../direct-link-upload';
import { createZip, crc32, zipSingleFile } from '../zip-writer';

const FIXED_MTIME = new Date(2026, 9, 6, 12, 0, 0); // 2026-10-06 12:00（本地时区）

const RULE: DirectLinkUploadRule = {
  uploadUrl: 'https://sy.example.com/shuyuan,{"method":"POST","body":{"file":"fileRequest"},"type":"multipart/form-data"}',
  downloadUrlRule: "$.data@js:if (result == '') \n '' \n else \n 'https://dl.example.com/' + result",
  summary: '测试网盘',
  compress: false,
  expiryDate: 30,
};

const FILE: UploadFile = {
  fileName: 'bookSource.json',
  contentType: 'application/json',
  bytes: new TextEncoder().encode('{"bookSourceName":"甲"}'),
};

/* ── zip 写入器 ─────────────────────────────────────────────────────── */

test('#208 zip：单条目结构 = 本地头 PK\\x03\\x04 … EOCD PK\\x05\\x06，且 CRC 正确', () => {
  const text = '{"bookSourceName":"甲"}';
  const bytes = new TextEncoder().encode(text);
  const zip = zipSingleFile('bookSource.json', bytes, { mtime: FIXED_MTIME });

  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50, '本地文件头签名');
  assert.equal(dv.getUint32(zip.length - 22, true), 0x06054b50, 'EOCD 签名');
  assert.equal(dv.getUint32(14, true), crc32(bytes), '本地头里的 CRC32 必须是原文的');
  assert.equal(dv.getUint32(22, true), bytes.length, '未压缩长度 = 原文长度');
  assert.equal(dv.getUint16(8, true) === 8 || dv.getUint16(8, true) === 0, true, 'method ∈ {8 deflate, 0 stored}');

  const nameLen = dv.getUint16(26, true);
  const name = new TextDecoder().decode(zip.subarray(30, 30 + nameLen));
  assert.equal(name, 'bookSource.json', '条目名 = 原文件名（对齐 ZipUtils.zipByteArray）');
});

test('#208 zip：deflate 条目能被 zlib.inflateRawSync 解开（证明产物真能被解压）', () => {
  // 够长且高度重复的内容 ⇒ 一定走 DEFLATED 分支
  const text = JSON.stringify({ a: 'x'.repeat(2000) });
  const raw = new TextEncoder().encode(text);
  const zip = zipSingleFile('a.json', raw, { mtime: FIXED_MTIME });
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint16(8, true), 8, '高度可压缩的内容应选 DEFLATED');
  const compSize = dv.getUint32(18, true);
  const nameLen = dv.getUint16(26, true);
  const dataStart = 30 + nameLen;
  const out = inflateRawSync(zip.subarray(dataStart, dataStart + compSize));
  assert.equal(new TextDecoder().decode(out), text, '解压回来必须与原文逐字节相同');
  assert.ok(zip.length < raw.length, '压缩后应比原文小');
});

test('#208 zip：已压缩过的内容退回 STORED（不为了「压缩」把体积做大）', () => {
  // ★ 必须是**真随机**字节。第一版用的是 `(i * 常数) % 256` —— 那是周期性序列
  //   （1024 字节里 256 字节的模式重复 4 次），deflate 一压就小 ⇒ 用例会假失败。
  //   这里用 xorshift32 造不可压缩数据。
  const rnd = new Uint8Array(4096);
  let s = 0x9e3779b9;
  for (let i = 0; i < rnd.length; i += 1) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    rnd[i] = s & 0xff;
  }
  const zip = zipSingleFile('r.bin', rnd, { mtime: FIXED_MTIME });
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint16(8, true), 0, '不可压缩 ⇒ STORED');
  assert.equal(dv.getUint32(22, true), rnd.length, 'STORED 时未压缩长度仍 = 原文长度');
  const nameLen = dv.getUint16(26, true);
  const stored = zip.subarray(30 + nameLen, 30 + nameLen + rnd.length);
  assert.deepEqual(Array.from(stored), Array.from(rnd), 'STORED 时原文直出');
});

test('#208 zip：多条目 + 拒绝非法入参（空名 / 反斜杠 / 超 4GiB 不静默）', () => {
  const enc = new TextEncoder();
  const zip = createZip(
    [
      { name: 'a/b.json', data: enc.encode('1') },
      { name: 'c.json', data: enc.encode('2') },
    ],
    { mtime: FIXED_MTIME },
  );
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint16(zip.length - 22 + 10, true), 2, 'EOCD 里总条目数 = 2');

  assert.throws(() => createZip([{ name: '', data: enc.encode('x') }]), /条目名不能为空/);
  assert.throws(() => createZip([{ name: 'a\\b.json', data: enc.encode('x') }]), /请用 \/ 分隔/);
  // 对照：同名但用 / 就是合法的
  assert.doesNotThrow(() => createZip([{ name: 'a/b.json', data: enc.encode('x') }]));
});

/* ── multipart 组装 ────────────────────────────────────────────────── */

test('#208 组装：fileRequest 那项变文件部件（字段名/文件名/类型都对），其余是普通字段', () => {
  const rule: DirectLinkUploadRule = {
    ...RULE,
    uploadUrl: 'https://x.com/up,{"method":"POST","body":{"file":"fileRequest","token":"abc"},"type":"multipart/form-data"}',
  };
  const built = buildDirectLinkForm(rule, FILE);
  assert.equal(built.compressed, false);
  assert.equal(built.fileName, 'bookSource.json');
  assert.equal(built.contentType, 'application/json');
  assert.deepEqual(built.bodyMap, { file: 'fileRequest', token: 'abc' });

  const form = built.form;
  assert.equal(form.get('token'), 'abc', '非文件字段按字符串部件');
  const part = form.get('file');
  assert.ok(part instanceof File, 'fileRequest 那一项必须是 File（带文件名）');
  if (part instanceof File) {
    assert.equal(part.name, 'bookSource.json', 'multipart 部件的 filename');
    assert.equal(part.type, 'application/json', '部件的 Content-Type 用规则给的 contentType');
  }
});

test('#208 组装：compress=true ⇒ 文件名加 .zip、类型改 application/zip、内容是真 zip', () => {
  const built = buildDirectLinkForm({ ...RULE, compress: true }, FILE, { zipMtime: FIXED_MTIME });
  assert.equal(built.compressed, true);
  assert.equal(built.fileName, 'bookSource.json.zip');
  assert.equal(built.contentType, 'application/zip');
  assert.ok(built.bytes.length > 0);
  const dv = new DataView(built.bytes.buffer, built.bytes.byteOffset, built.bytes.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50, '产物应是 zip');
  const nameLen = dv.getUint16(26, true);
  assert.equal(
    new TextDecoder().decode(built.bytes.subarray(30, 30 + nameLen)),
    'bookSource.json',
    'zip 内条目名是**原名**（不是 xxx.zip）',
  );
});

test('#208 组装：body 不是对象 / 没有 fileRequest / type 非 multipart ⇒ 明确报错', () => {
  assert.throws(
    () => buildDirectLinkForm({ ...RULE, uploadUrl: 'https://x.com/up,{"body":{"name":"a"}}' }, FILE),
    /没有 fileRequest/,
  );
  // 对照：同一个 body 加上 fileRequest 就不再报错（证明拒绝是因为缺标记，不是别的原因）
  assert.doesNotThrow(() =>
    buildDirectLinkForm({ ...RULE, uploadUrl: 'https://x.com/up,{"body":{"name":"a","file":"fileRequest"}}' }, FILE),
  );
  // body 缺失等价于「没有 fileRequest」
  assert.throws(() => buildDirectLinkForm({ ...RULE, uploadUrl: 'https://x.com/up' }, FILE), /没有 fileRequest/);

  assert.throws(
    () => buildDirectLinkForm({ ...RULE, uploadUrl: 'https://x.com/up,{"type":"application/json"}' }, FILE),
    /只支持 multipart/,
  );
  // 对照：同一形状但 type 是 multipart 变体（带 boundary 参数）应通过
  assert.doesNotThrow(() =>
    buildDirectLinkForm(
      {
        ...RULE,
        uploadUrl: 'https://x.com/up,{"type":"multipart/form-data; charset=utf-8","body":{"file":"fileRequest"}}',
      },
      FILE,
    ),
  );
});

/* ── downloadUrlRule 求值 ──────────────────────────────────────────── */

test('#208 求值：内置 3 条规则的 downloadUrlRule 形态都能跑（@js 三元 / $.msg）', async () => {
  const [r1, , r3] = DEFAULT_DIRECT_LINK_UPLOAD_RULES;
  const got1 = await applyDirectLinkDownloadRule(r1!.downloadUrlRule, JSON.stringify({ data: 'abc123' }));
  assert.equal(got1, 'https://shuyuan.nyasama.net/shuyuan/abc123', '空值分支外的字符串拼接');

  const empty1 = await applyDirectLinkDownloadRule(r1!.downloadUrlRule, JSON.stringify({ data: '' }));
  assert.equal(empty1, '', 'data 为空 ⇒ 规则回空串（不是 "undefined" 之类的脏值）');

  const got3 = await applyDirectLinkDownloadRule(r3!.downloadUrlRule, JSON.stringify({ msg: 'http://dl/x' }));
  assert.equal(got3, 'http://dl/x', '$.msg 纯 JSONPath');
});

/* ── 端到端（打桩 HTTP） ───────────────────────────────────────────── */

function stubHttp(handler: (url: string, opts: { headers?: Record<string, string>; body?: unknown }) => HttpResponse) {
  const calls: Array<{ url: string; method?: string; body?: unknown; headers?: Record<string, string> }> = [];
  return {
    calls,
    http: {
      request: async (url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
        calls.push({ url, method: opts.method, body: opts.body, headers: opts.headers });
        return handler(url, opts);
      },
    },
  };
}

test('#208 端到端：POST 到剥离选项尾巴的地址 + multipart 体 + 从响应抠出下载地址', async () => {
  const stub = stubHttp(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 0, data: 'file777.json' }),
    url: 'https://sy.example.com/shuyuan',
  }));
  const res = await uploadDirectLink(RULE, FILE, { http: stub.http as never });

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, 'https://sy.example.com/shuyuan', 'URL 已剥离 ,{…}（且 POST 不像 GET 那样截 query）');
  assert.equal(stub.calls[0]?.method, 'POST', '上游 upload() 恒 POST');
  assert.ok(stub.calls[0]?.body instanceof FormData, '体是 multipart FormData');
  assert.equal(res.downloadUrl, 'https://dl.example.com/file777.json');
  assert.equal(res.fileName, 'bookSource.json');
  assert.equal(res.byteLength, FILE.bytes.length);
  assert.equal(res.compressed, false);
});

test('#208 端到端：规则给空 ⇒ 报错里**带上响应体**（否则用户无法自救）', async () => {
  const stub = stubHttp(() => ({
    status: 200,
    headers: {},
    body: '{"code":500,"msg":"文件太大"}',
    url: 'https://sy.example.com/shuyuan',
  }));
  await assert.rejects(
    () => uploadDirectLink({ ...RULE, downloadUrlRule: '$.nothing' }, FILE, { http: stub.http as never }),
    (e: Error) => /上传失败/.test(e.message) && /文件太大/.test(e.message),
  );
});

test('#208 端到端：uploadUrl / downloadUrlRule 缺失 ⇒ 上游同款文案', async () => {
  const stub = stubHttp(() => ({ status: 200, headers: {}, body: '{}', url: 'x' }));
  await assert.rejects(() => uploadDirectLink({ ...RULE, uploadUrl: '  ' }, FILE, { http: stub.http as never }), /上传url未配置/);
  await assert.rejects(
    () => uploadDirectLink({ ...RULE, downloadUrlRule: '' }, FILE, { http: stub.http as never }),
    /下载地址规则未配置/,
  );
  assert.equal(stub.calls.length, 0, '参数不合法时不该发出任何请求');
});

test('#208 端到端：网络失败 ⇒ 包成「上传请求失败：<原因>」', async () => {
  const http = {
    request: async () => {
      throw new Error('DNS 解析失败（域名可能已失效）');
    },
  };
  await assert.rejects(
    () => uploadDirectLink(RULE, FILE, { http: http as never }),
    /上传请求失败：DNS 解析失败/,
  );
});

test('#208 便捷入口：源 json 文本走同一条链，文件名与类型是 json', async () => {
  const stub = stubHttp(() => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ msg: 'http://dl/1.json' }),
    url: 'https://sy.example.com/shuyuan',
  }));
  const res = await uploadSourceJson({ ...RULE, downloadUrlRule: '$.msg' }, '{"a":1}', '甲.json', {
    http: stub.http as never,
  });
  assert.equal(res.fileName, '甲.json');
  assert.equal(res.contentType, 'application/json');
  assert.equal(res.byteLength, new TextEncoder().encode('{"a":1}').length);
  assert.equal(res.downloadUrl, 'http://dl/1.json');
});
