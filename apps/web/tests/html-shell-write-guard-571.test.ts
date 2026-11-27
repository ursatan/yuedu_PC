/**
 * `#571` 文档写保护回归锁（白屏修复）。
 *
 * 真因（2026-10-23 运行时取证）：163 的 `redirect.js` 在**解析后**调 `document.write`
 * ⇒ HTML 规范隐式 `document.open()` ⇒ 整篇文档被清空（用户看到「闪一下全白」）。
 *
 * 判据不止 `readyState`：实测该页被外部脚本拖住，6.8s 仍是 `loading`，但 body 已有 2000+ 字
 * ⇒ 还必须拦「body 已有子元素」时的写。这里锁三件事：
 *  ① body 还是空的时候（真正的解析早期）`write` **原样放行**；
 *  ② body 已有内容（无论 readyState 是否 loading）`write/open` **不再清空文档**；
 *  ③ `buildHtmlDoc` 把守卫放在**站点脚本之前**（否则站点先跑就来不及了）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { buildHtmlDoc, buildWriteGuard } from '../src/utils/html-shell';

function withDoc(html: string, fn: (doc: Document, win: Window) => void): void {
  // ⚠️ `runScripts: 'outside-only'` 才让 `window.eval` 在**窗口上下文**里执行
  // （默认模式的 eval 是 Node 的，里面没有 document）。
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  try {
    fn(dom.window.document, dom.window as unknown as Window);
  } finally {
    dom.window.close();
  }
}

/** jsdom 的 readyState 是原型 getter ⇒ 用 own 属性覆盖来模拟解析期/解析后 */
function setReadyState(doc: Document, v: 'loading' | 'complete'): void {
  Object.defineProperty(doc, 'readyState', { configurable: true, get: () => v });
}

test('#571 解析早期（body 还空）：document.write 必须原样生效', () => {
  withDoc('<!doctype html><html><head></head><body></body></html>', (doc, win) => {
    setReadyState(doc, 'loading');
    (win as unknown as { eval: (s: string) => void }).eval(buildWriteGuard());
    doc.write('<p id="early">解析期追加</p>');
    assert.ok(doc.getElementById('early'), '解析早期 write 是站点正常用法，不能拦');
  });
});

test('#571 正文已出现：document.write / open 不得清空整篇文档', () => {
  withDoc('<!doctype html><html><head><title>t</title></head><body><p id="keep">原始内容</p></body></html>', (doc, win) => {
    setReadyState(doc, 'loading'); // ★ 刻意保持 loading —— 复刻 163 的真实状态
    (win as unknown as { eval: (s: string) => void }).eval(buildWriteGuard());
    doc.write('<p>late write</p>');
    doc.writeln('<p>late writeln</p>');
    const opened = doc.open();
    assert.ok(doc.getElementById('keep'), `写保护失效，文档被清空：${doc.documentElement?.innerHTML ?? '(null)'}`);
    assert.equal(opened, doc, 'open 应返回当前文档（语义上的 no-op）');
  });
});

test('#571 解析完成（readyState=complete）：同样不得清空', () => {
  withDoc('<!doctype html><html><head><title>t</title></head><body><p id="keep">原始内容</p></body></html>', (doc, win) => {
    setReadyState(doc, 'loading');
    (win as unknown as { eval: (s: string) => void }).eval(buildWriteGuard());
    setReadyState(doc, 'complete');
    doc.write('<p>x</p>');
    assert.ok(doc.getElementById('keep'));
  });
});

test('#571 buildHtmlDoc：守卫必须排在站点脚本之前', () => {
  const raw = '<html><head><title>x</title></head><body><script>window.__siteRan=1</script><p>正文</p></body></html>';
  const out = buildHtmlDoc(raw, { base: 'https://example.com/' });
  const guard = out.indexOf('childElementCount > 0');
  const site = out.indexOf('window.__siteRan=1');
  assert.ok(guard > 0, '壳里应有写保护脚本');
  assert.ok(site > 0, '站点脚本仍在');
  assert.ok(guard < site, `守卫必须在站点脚本之前：guard=${guard} site=${site}`);
});
