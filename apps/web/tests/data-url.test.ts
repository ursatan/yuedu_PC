/**
 * `#392` `data:` 内联页解码锁。
 *
 * 场景（用户实测 RSS 源 `˃̶͈ ꇴ ˂̶͈` 的「书源更新」按钮）：`update()` 把一整页 HTML
 * 内联成 `data:text/html;base64,<b64>` 交给 `java.startBrowser(url,'更新')`。
 * 这一页里带「导入书源」链接 —— **只有应用内壳层**（`buildHtmlDoc` 注入的导航桥）点得动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dataUrlHtml } from '../src/utils/data-url';

const utf8B64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

test('#392 base64 内联页必须按 UTF-8 还原（直接 atob 会让中文乱码）', () => {
  const html = '<!DOCTYPE html><html><body><p>书源更新</p><a href="legado://import/bookSource?src=https%3A%2F%2Fx.com%2Fa.json">导入书源</a></body></html>';
  const out = dataUrlHtml('data:text/html;base64,' + utf8B64(html));
  assert.equal(out, html, '中文必须原样回来（否则页面标题/按钮全是乱码）');
  assert.match(String(out), /legado:\/\/import\/bookSource/, '导入链接必须还在（它就是应用内浏览器的意义）');
});

test('#392 百分号编码形态同样支持；`;charset=utf-8` 等参数照旧', () => {
  const html = '<p>更新</p>';
  assert.equal(dataUrlHtml('data:text/html,' + encodeURIComponent(html)), html);
  assert.equal(
    dataUrlHtml('data:text/html;charset=utf-8,' + encodeURIComponent(html)),
    html,
    '参数段（charset）不得让判据落空',
  );
});

test('#392 对偶：非 html 的 data URL / 普通网址 / 空值 ⇒ null（调用方走 iframe 直连）', () => {
  assert.equal(dataUrlHtml('data:image/png;base64,iVBORw0KGgo='), null, '图片 data URL 不是页面');
  assert.equal(dataUrlHtml('https://shuyuan.test/'), null);
  assert.equal(dataUrlHtml('legado://import/bookSource?src=a'), null);
  assert.equal(dataUrlHtml(''), null);
  assert.equal(dataUrlHtml(undefined), null);
  assert.equal(dataUrlHtml(null), null);
  assert.equal(dataUrlHtml('data:text/html;base64,@@@不是base64@@@'), null, '坏 base64 必须返回 null 而不是抛');
});
