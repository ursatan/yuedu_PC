/**
 * `#208` 直链上传配置 + 源分享（服务端侧）单测。
 *
 * 上游对照：`DirectLinkUpload.kt` 的 `getRule/getConfig/putConfig/delConfig/getSummary/getExpiryDate`
 * 与 `DirectLinkUploadConfig.kt` 的「测试」按钮。
 * ★ 防空转约定：每个「回落/拒绝」用例旁有能通过的对照（同函数、换入参）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_DIRECT_LINK_UPLOAD_RULES,
  decodeSourceSharePassphrase,
  sourceShareExpiresAt,
  type DirectLinkUploadRule,
  type HttpResponse,
} from '@yuedu/core';
import {
  DirectLinkUploadConfig,
  safeShareFileName,
  shareSource,
  testDirectLinkRule,
} from '../share-direct-link';

/** 每个用例一个独立临时目录（不带仓库 `tmp/`，见 `_probe-env.mjs` 注释里那类卡死经历） */
function tmpFile(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `share-dl-${tag}-`));
  return path.join(dir, 'direct-link-upload.json');
}

const CUSTOM: DirectLinkUploadRule = {
  uploadUrl: 'https://my.example.com/up,{"method":"POST","body":{"file":"fileRequest"},"type":"multipart/form-data"}',
  downloadUrlRule: '$.data',
  summary: '我的网盘',
  compress: false,
  expiryDate: 7,
};

/** 打桩 HTTP：记录调用并回固定响应 */
function stubHttp(makeBody: (url: string) => string, url = 'https://my.example.com/up') {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  return {
    calls,
    http: {
      request: async (u: string, o: { method?: string; body?: unknown } = {}): Promise<HttpResponse> => {
        calls.push({ url: u, method: o.method, body: o.body });
        return { status: 200, headers: {}, body: makeBody(u), url };
      },
    },
  };
}

/* ── 配置持久化 ────────────────────────────────────────────────────── */

test('#208 配置：没文件 ⇒ 用内置第 1 条，且 custom=false', () => {
  const cfg = new DirectLinkUploadConfig(tmpFile('fresh'));
  assert.equal(cfg.getCustomRule(), null);
  assert.deepEqual(cfg.getRule(), DEFAULT_DIRECT_LINK_UPLOAD_RULES[0]);
  assert.equal(cfg.getState().custom, false);
  assert.equal(cfg.getState().defaults.length, 3);
  assert.equal(cfg.summary(), DEFAULT_DIRECT_LINK_UPLOAD_RULES[0]!.summary);
  assert.equal(cfg.expiryDate(), 30, '内置第 1 条有效期 30 天');
});

test('#208 配置：putConfig 落盘且**重启后仍在**（同路径新实例读得到）', () => {
  const file = tmpFile('persist');
  new DirectLinkUploadConfig(file).putConfig(CUSTOM);

  // 落盘内容本身要合法、可读（原子写：文件里不该有半截 json）
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as DirectLinkUploadRule;
  assert.deepEqual(onDisk, CUSTOM);

  const again = new DirectLinkUploadConfig(file);
  assert.equal(again.getState().custom, true);
  assert.deepEqual(again.getRule(), CUSTOM);
  assert.equal(again.expiryDate(), 7, '改配置后口令有效期跟着变');
});

test('#208 配置：delConfig 删自定义 ⇒ 回落内置第 1 条（本地文件也清掉）', () => {
  const file = tmpFile('del');
  const cfg = new DirectLinkUploadConfig(file);
  cfg.putConfig(CUSTOM);
  assert.equal(cfg.getState().custom, true);
  cfg.delConfig();
  assert.equal(cfg.getState().custom, false);
  assert.deepEqual(cfg.getRule(), DEFAULT_DIRECT_LINK_UPLOAD_RULES[0]);
  assert.equal(fs.existsSync(file), false);
});

test('#208 配置：文件坏掉 / 字段非法 ⇒ 当作「没有自定义」，不抛不崩', () => {
  const broken = tmpFile('broken');
  fs.writeFileSync(broken, '{ 这不是 json', 'utf-8');
  const c1 = new DirectLinkUploadConfig(broken);
  assert.equal(c1.getCustomRule(), null);
  assert.deepEqual(c1.getRule(), DEFAULT_DIRECT_LINK_UPLOAD_RULES[0], '坏配置不能让分享功能整体不可用');

  const invalid = tmpFile('invalid');
  fs.writeFileSync(invalid, JSON.stringify({ ...CUSTOM, expiryDate: 999999 }), 'utf-8');
  const c2 = new DirectLinkUploadConfig(invalid);
  assert.equal(c2.getCustomRule(), null, '超范围的有效期 ⇒ 视为无效配置');

  // 对照：同一个文件换成合法内容立刻被接受
  const good = tmpFile('good');
  fs.writeFileSync(good, JSON.stringify(CUSTOM), 'utf-8');
  assert.equal(new DirectLinkUploadConfig(good).getState().custom, true);
});

test('#208 文件名净化：去路径与非法字符、补 .json、不重复补', () => {
  assert.equal(safeShareFileName('我的源'), '我的源.json');
  assert.equal(safeShareFileName('a/b:c*d?.json'), 'a_b_c_d_.json');
  assert.equal(safeShareFileName('   '), 'bookSource.json');
  assert.equal(safeShareFileName(''), 'bookSource.json');
  assert.equal(safeShareFileName('x.JSON'), 'x.JSON', '已有 .json 后缀（大小写无关）不再补');
});

/* ── 测试上传（上游配置对话框的「测试」） ─────────────────────────────── */

test('#208 测试上传：固定 test.json + "{}" + application/json', async () => {
  const stub = stubHttp(() => JSON.stringify({ data: 'zz.json' }));
  const res = await testDirectLinkRule({ ...CUSTOM, downloadUrlRule: '$.data' }, { http: stub.http as never });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, 'https://my.example.com/up');
  assert.equal(stub.calls[0]?.method, 'POST');
  const form = stub.calls[0]?.body as FormData;
  const part = form.get('file');
  assert.ok(part instanceof File);
  if (part instanceof File) {
    assert.equal(part.name, 'test.json');
    assert.equal(part.size, 2, '内容恒为 "{}"');
  }
  assert.equal(res.downloadUrl, 'zz.json');
});

/* ── 分享一个源 ────────────────────────────────────────────────────── */

test('#208 分享源：口令能解回上传得到的 url，类型 sy，有效期与规则一致', async () => {
  const stub = stubHttp(() => JSON.stringify({ data: 'abc123.json' }));
  const file = tmpFile('share');
  const cfg = new DirectLinkUploadConfig(file);
  cfg.putConfig({ ...CUSTOM, downloadUrlRule: '$.data@js:"https://dl.example.com/" + result' });

  const out = await shareSource({ raw: { bookSourceName: '甲', bookSourceUrl: 'https://a.com' }, name: '甲' }, cfg, {
    http: stub.http as never,
  });
  assert.equal(out.ok, true, out.ok ? '' : JSON.stringify(out.error));
  if (!out.ok) return;
  assert.equal(out.value.downloadUrl, 'https://dl.example.com/abc123.json');
  assert.equal(out.value.summary, '我的网盘');
  assert.equal(out.value.upload.fileName, '甲.json');

  const dec = decodeSourceSharePassphrase(out.value.passphrase);
  assert.equal(dec.kind, 'success', '生成的口令必须能被 decode');
  if (dec.kind !== 'success') return;
  assert.equal(dec.value.url, 'https://dl.example.com/abc123.json');
  assert.equal(dec.value.type, 'sy');
  // ★ 有效期与口令内携带的时间**同源**（防「界面显示 7 天、口令里是别的」）
  assert.equal(out.value.expiresAt, sourceShareExpiresAt(7));
  assert.equal(dec.value.expiresAt, out.value.expiresAt);
});

test('#208 分享源：raw 传字符串也认；空 raw ⇒ empty（不发请求）', async () => {
  const stub = stubHttp(() => JSON.stringify({ data: 'u.json' }));
  const cfg = new DirectLinkUploadConfig(tmpFile('share-str'));
  // ★ downloadUrlRule 必须产出**绝对地址**：口令里要带的就是可公网下载的 url，
  //   相对路径过不了 canEncode（这条用例测的是「raw 传字符串也认」，别让地址形态混进来）。
  cfg.putConfig({ ...CUSTOM, downloadUrlRule: '$.data@js:"https://u.example.com/" + result' });

  const ok = await shareSource({ raw: '{"a":1}', name: 'x' }, cfg, { http: stub.http as never });
  assert.equal(ok.ok, true, ok.ok ? '' : JSON.stringify(ok.error));
  if (ok.ok) assert.equal(ok.value.downloadUrl, 'https://u.example.com/u.json');
  assert.equal(stub.calls.length, 1);

  for (const raw of [null, undefined, '', '   ']) {
    const empty = await shareSource({ raw }, cfg, { http: stub.http as never });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.error.kind, 'empty');
  }
  assert.equal(stub.calls.length, 1, '空输入不该发出请求');
});

test('#208 分享源：网盘地址含口令保留字符 ⇒ unshareable，但**把 url 带出来**', async () => {
  // 「店」是映射表里 `.` 的替身之一 ⇒ 必然通不过 canEncode
  const stub = stubHttp(() => JSON.stringify({ data: '店/x.json' }));
  const cfg = new DirectLinkUploadConfig(tmpFile('share-bad'));
  cfg.putConfig({ ...CUSTOM, downloadUrlRule: '$.data@js:"https://a.com/" + result' });
  const out = await shareSource({ raw: { a: 1 }, name: 'x' }, cfg, { http: stub.http as never });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.kind, 'unshareable');
  if (out.error.kind !== 'unshareable') return;
  assert.equal(out.error.downloadUrl, 'https://a.com/店/x.json', '白上传了也要把链接交给用户');
  assert.match(out.error.detail, /无法编成口令/);

  // 对照：把地址换成一个干净的结果 ⇒ 立刻成功
  const stub2 = stubHttp(() => JSON.stringify({ data: 'ok.json' }));
  const good = await shareSource({ raw: { a: 1 }, name: 'x' }, cfg, { http: stub2.http as never });
  assert.equal(good.ok, true);
});

test('#208 分享源：上传本身失败 ⇒ upload 类错误（不是 unshareable）', async () => {
  const http = {
    request: async () => {
      throw new Error('上传请求失败：DNS 解析失败（域名可能已失效）');
    },
  };
  const cfg = new DirectLinkUploadConfig(tmpFile('share-fail'));
  cfg.putConfig({ ...CUSTOM, downloadUrlRule: '$.data' });
  const out = await shareSource({ raw: { a: 1 } }, cfg, { http: http as never });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.kind, 'upload');
  if (out.error.kind === 'upload') assert.match(out.error.detail, /DNS 解析失败/);
});

test('#208 分享源：compress 规则下真发 zip（文件名带 .zip、口令指向同一个 url）', async () => {
  const stub = stubHttp(() => JSON.stringify({ data: 'z.json' }));
  const cfg = new DirectLinkUploadConfig(tmpFile('share-zip'));
  cfg.putConfig({ ...CUSTOM, compress: true, downloadUrlRule: '$.data@js:"https://d/" + result' });
  const out = await shareSource({ raw: { a: 1 }, name: '甲' }, cfg, { http: stub.http as never });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.upload.compressed, true);
  assert.equal(out.value.upload.fileName, '甲.json.zip');
  assert.equal(out.value.upload.contentType, 'application/zip');
});
