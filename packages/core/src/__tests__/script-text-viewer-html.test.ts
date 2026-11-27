/**
 * 外链脚本（jsLib / exploreUrl）缓存**不得接受浏览器「文本阅读器」DOM**。
 *
 * 现场：MYCOMIC / Komiic / 热辣漫画 / 漫画柜 / 拷贝漫画 五个 qyyuapi 系源同时报
 * `Unexpected token '<'`。原因不是脚本坏了，而是 `.js` 撞 WAF 后被浏览器重放，
 * Chromium 打开脚本 URL 会自动包一层阅读器文档：
 *   `<html><head><meta name="color-scheme" …></head><body><pre …>源码</pre></body></html>`
 * 这层 DOM 被当脚本写进镜像/持久层/文件层 ⇒ 之后每次启动都 `<` 开头 ⇒ 预编译必炸。
 *
 * 本文件锁的是「读写两侧都拒收 + `<!--` 合法 JS 不误伤」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isMarkupDocumentBody,
  isRenderedTextDocument,
  jsMirrorRelPath,
  readJsMirror,
  writeJsMirror,
  __resetJsMirrorWarningsForTest,
} from '../net/jslib-mirror';
import { readScriptFile, writeScriptFile, type ScriptFileLayer } from '../selector/js-file';

const JS_BODY = 'function Get(url) { return url; }\n';

/** Chromium 打开 `.js` 时 Chrome 真实生成的阅读器文档（含 color-scheme + pre 样式） */
const VIEWER_HTML =
  '<html><head><meta name="color-scheme" content="light dark"></head>' +
  '<body><pre style="word-wrap: break-word; white-space: pre-wrap;">' +
  'function Get(url) { return url; }' +
  '</pre></body></html>';

function withMirrorDir<T>(fn: (dir: string) => T): T {
  const prev = process.env['YUEDU_JSLIB_MIRROR_DIR'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jslib-viewer-'));
  process.env['YUEDU_JSLIB_MIRROR_DIR'] = dir;
  __resetJsMirrorWarningsForTest();
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env['YUEDU_JSLIB_MIRROR_DIR'];
    else process.env['YUEDU_JSLIB_MIRROR_DIR'] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('判据：阅读器 DOM 命中，普通 JS / `<!--` 注释开头不误伤', () => {
  assert.equal(isRenderedTextDocument(VIEWER_HTML), true);
  assert.equal(isMarkupDocumentBody('<html><body>x</body></html>'), true);
  assert.equal(isMarkupDocumentBody('<?xml version="1.0"?><rss></rss>'), true);
  assert.equal(isMarkupDocumentBody('<!-- legacy comment -->\nfunction Get(){}'), false, '`<!--` 是合法 JS 注释');
  assert.equal(isRenderedTextDocument(JS_BODY), false);
});

test('镜像：拒收阅读器 DOM；旧版本已落盘的污染按未命中回源', () => {
  withMirrorDir((dir) => {
    const url = 'https://qyyuapi.com/sy/js/Komiic漫画/jsLib.js';
    // 写入侧必须拒绝（否则网络重放一次就把污染固化）
    assert.equal(writeJsMirror(url, VIEWER_HTML), null);

    // 模拟旧版本已经写进去的污染：手工落盘 + 正确 meta，确保不是被 meta 校验挡掉的
    const rel = jsMirrorRelPath(url)!;
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, VIEWER_HTML, 'utf-8');

    assert.equal(readJsMirror(url), null, '读取侧必须按未命中处理，让调用方回源重下');
    // 真正的 JS 仍然正常
    assert.ok(writeJsMirror(url, JS_BODY));
    assert.equal(readJsMirror(url)?.text, JS_BODY);
  });
});

test('脚本文件层：读写两侧都拒收阅读器 DOM', () => {
  const mem = new Map<string, string>();
  const layer: ScriptFileLayer = {
    getFile: (k) => mem.get(k) ?? null,
    putFile: (k, v) => {
      mem.set(k, v);
    },
    remove: (k) => {
      mem.delete(k);
    },
  };
  mem.set('polluted', VIEWER_HTML);
  assert.equal(readScriptFile(layer, 'polluted'), null);

  writeScriptFile(layer, 'viewer', VIEWER_HTML, 0);
  assert.equal(mem.has('viewer'), false, '阅读器 DOM 不得写进文件层');

  writeScriptFile(layer, 'ok', JS_BODY, 0);
  assert.equal(mem.get('ok'), JS_BODY);
  assert.equal(readScriptFile(layer, 'ok'), JS_BODY);
});
