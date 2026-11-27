/**
 * `#563` 回归锁：jsoup 仿真的 **`abs:` 属性协议** 与 `Jsoup.parse(html, baseUri)` 的基址。
 *
 * 用户实测（🄼黄金屋 -，2026-10-22）：bookList JS 里
 *   `var u = e.attr('abs:href'); if(!u) continue;`
 * 手机 App（真 jsoup）30 项正常，PC 引擎恒 0 项。真因：本仿真①丢弃 `Jsoup.parse` 的第二参
 * （文档基址）、②不认识 `abs:` 前缀 ⇒ `attr('abs:href')` 恒空串 ⇒ 每项都被 continue 掉。
 * 这里锁四件事：
 *  ① `parse(html, base)` 后 `abs:href` 解出**绝对地址**；
 *  ② 属性缺失 / 基址缺失 / 无 second 参 ⇒ 如实 `''`（真 jsoup `absUrl` 同语义）；
 *  ③ 文档里显式 `<base href>` **覆盖** parse 的第二参（jsoup `Document.baseUri` 语义）；
 *  ④ 已是绝对地址的属性值原样返回（不重复拼接）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsoupDom } from '../selector/jsoup-dom';

test('A-① parse(html, base) 后 abs:href 解出绝对地址（黄金屋判例）', () => {
  const dom = new JsoupDom();
  const nid = dom.parse(
    '<a class="book-card" href="/novel/55">开局一座神秘岛</a>',
    'https://www.huangjinwu.org/rank/allvisit/1.html',
  );
  const el = dom.select(nid, 'a.book-card')[0]!;
  assert.equal(el.attrs['href'], '/novel/55', '普通 attr 不受影响');
  assert.equal(dom.attr(el.nid as number, 'abs:href'), 'https://www.huangjinwu.org/novel/55');
});

test('A-② 属性缺失 / 基址缺失 / 没给基址 ⇒ abs: 如实返回空串', () => {
  const dom = new JsoupDom();
  // 没给基址（jsdom 落 about:blank）⇒ 解不出绝对地址
  const n1 = dom.parse('<a href="/novel/55">A</a>');
  const e1 = dom.select(n1, 'a')[0]!;
  assert.equal(dom.attr(e1.nid as number, 'abs:href'), '');
  // 给了基址但元素没有 href
  const n2 = dom.parse('<a>A</a>', 'https://x.com/');
  const e2 = dom.select(n2, 'a')[0]!;
  assert.equal(dom.attr(e2.nid as number, 'abs:href'), '');
});

test('A-③ 文档里显式 <base href> 覆盖 parse 的第二参（jsoup Document.baseUri 语义）', () => {
  const dom = new JsoupDom();
  const nid = dom.parse(
    '<head><base href="https://cdn.example.com/"></head><body><a href="/novel/9">B</a></body>',
    'https://www.example.com/',
  );
  const el = dom.select(nid, 'a')[0]!;
  assert.equal(dom.attr(el.nid as number, 'abs:href'), 'https://cdn.example.com/novel/9');
});

test('A-④ 已是绝对地址的属性值原样返回', () => {
  const dom = new JsoupDom();
  const nid = dom.parse('<a href="https://other.com/novel/1">C</a>', 'https://www.example.com/');
  const el = dom.select(nid, 'a')[0]!;
  assert.equal(dom.attr(el.nid as number, 'abs:href'), 'https://other.com/novel/1');
});
