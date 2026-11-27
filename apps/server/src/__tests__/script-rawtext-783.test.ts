/**
 * 过闸重放的**非 HTML 资源取原文**判据（五个 qyyuapi 漫画源的 `Unexpected token '<'` 根因）。
 *
 * Chromium 打开 `.js` / `.json` 会把响应包成「文本阅读器」文档（`<html>…<pre>…`）。
 * 过闸重放若直接返回 outerHTML，引擎拿到的是 HTML ⇒ jsLib 预编译 `Unexpected token '<'`。
 * 修复要求：`antibotPassPage` 的三次取页都带 `rawText: true`，且只有**非 HTML 文本资源**
 * 才改走 `fetch().text()` 取响应原文（普通页面仍返回 DOM，避免 webView/JSON 读取方回归）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isNonHtmlTextContentType } from '../browser-session';

const SRC = readFileSync(join(process.cwd(), 'src/browser-session.ts'), 'utf8');
const INDEX_SRC = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');

test('内容类型判据：脚本 / JSON 取原文；HTML 页面维持 DOM 语义', () => {
  assert.equal(isNonHtmlTextContentType('text/plain'), true);
  assert.equal(isNonHtmlTextContentType('text/javascript'), true);
  assert.equal(isNonHtmlTextContentType('application/javascript'), true);
  assert.equal(isNonHtmlTextContentType('application/x-javascript'), true);
  assert.equal(isNonHtmlTextContentType('application/json'), true);
  assert.equal(isNonHtmlTextContentType('application/xml'), true);
  assert.equal(isNonHtmlTextContentType('text/html'), false);
  assert.equal(isNonHtmlTextContentType('application/xhtml+xml'), false);
  assert.equal(isNonHtmlTextContentType('image/png'), false);
  assert.equal(isNonHtmlTextContentType(''), false);
});

test('antibotPassPage 的三次取页都必须要求响应原文（否则 jsLib 还是拿到阅读器 DOM）', () => {
  const start = INDEX_SRC.indexOf('async function antibotPassPage');
  assert.ok(start >= 0, '找不到 antibotPassPage');
  const body = INDEX_SRC.slice(start, start + 8000);
  const calls = body.match(/renderWithSession\(url, \{[^}]*\}\)/g) ?? [];
  assert.ok(calls.length >= 3, `antibotPassPage 应有 3 次取页，实际 ${calls.length}`);
  assert.equal(calls.filter((c) => c.includes('rawText: true')).length, 3, '三次取页都要 rawText: true');
});

test('只有非 HTML 文本资源才用 fetch().text() 取原文（普通页面不走这条）', () => {
  assert.match(SRC, /export interface SessionRenderOptions[\s\S]*?rawText\?: boolean;/);
  const fn = SRC.slice(SRC.indexOf('async function readRawTextDocument'));
  assert.ok(fn.length > 0);
  assert.match(fn, /isNonHtmlTextContentType\(contentType\)/);
  assert.match(fn, /fetch\(location\.href/);
  // 早退条件必须在取原文之前：HTML 页面直接返回空串，调用方继续走 DOM 逻辑
  assert.match(fn, /if \(!isNonHtmlTextContentType\(contentType\)\) return '';/);
});
