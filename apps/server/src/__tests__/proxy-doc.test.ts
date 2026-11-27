/**
 * 回归锁：`/api/proxy` 回传 HTML 文档时的两道修补（`#435`，91视频「播放器全黑」）。
 *
 * 真机 CDP 实测（`.tmp-432/probe-435-base.mjs`）：
 *   · 经代理原样回传 ⇒ 播放器页 `typeof Hls === "undefined"`、`video.readyState === 0`（黑屏）；
 *   · 加 `<base href=上游URL>` ⇒ `typeof Hls === "function"`（相对 JS 取到了）。
 * 而 `<base>` 只管相对资源：页内 `getQueryVariable("url")` 读的是 `location.search`，
 * 代理后它只剩我们的 `u=…` ⇒ 还要 `history.replaceState` 把 search 还原成上游那份。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
// `#457`「响应体像不像 HTML 文档」的判据（core 唯一实现，服务端路由与 web 取页共用）
import { looksLikeHtmlDocument } from '@yuedu/core';
import { docPatchHead, injectProxiedDocPatches } from '../proxy-doc';

const UP = 'https://ha2.dd.frcfwb.cn/t2player.html?url=https://ehapp2.dd.frcfwb.cn/cshort/x.m3u8';

test('修补片段：`<base>` 指上游 + `location.search` 还原成上游 search', () => {
  const p = docPatchHead(UP);
  assert.ok(p.startsWith('<base href="https://ha2.dd.frcfwb.cn/t2player.html?url='), `实际：${p}`);
  assert.ok(p.includes('history.replaceState'), '必须还原 location.search（页内脚本靠它取参数）');
  // 只还原 search：路径仍是我们的路由；★ 且必须是**绝对地址**（`<base>` 已在前面把
  // 相对地址的解析基准指到上游 ⇒ 相对写法会跨源、replaceState 抛 SecurityError）
  assert.ok(p.includes('location.origin+location.pathname+'), '必须以绝对地址（origin+pathname）拼 search');
  assert.ok(p.includes('?url='), '上游 search 原样带上');
  assert.ok(p.endsWith('</script>'), `片段应以闭合标签结束，实际：${p}`);
  // ★ 生成的 **JS 体内**不得出现字面闭合标签（否则脚本会被页面解析器提前截断）
  const body = p.slice(p.indexOf('<script>') + '<script>'.length, p.indexOf('</script>'));
  assert.ok(body.length > 0 && !body.includes('</script'), `JS 体内不得有闭合标签，实际：${body}`);
  // 上游 query 里带 `</script>` 时也必须被转义掉
  const evil = docPatchHead('https://a.b/c?x=</script>');
  const evilBody = evil.slice(evil.indexOf('<script>') + '<script>'.length, evil.indexOf('</script>'));
  assert.ok(!evilBody.includes('</script'), `实测恶意 query 也要转义，实际：${evilBody}`);
});

test('注入位置：必须在 `<head>` 之后（排在页面自己的脚本之前）', () => {
  const html = '<!doctype html><html><head><title>t</title><script src="hls7.min.js"></script></head><body></body></html>';
  const out = injectProxiedDocPatches(html, UP);
  assert.ok(out.indexOf('<base href=') > out.indexOf('<head>'), '应插在 head 开标签之后');
  assert.ok(out.indexOf('<base href=') < out.indexOf('<script src="hls7.min.js">'), '★ 必须早于页面自己的脚本');
  assert.ok(out.endsWith('</html>'), '其余内容不动');
});

test('无 `<head>` / 无 `<html>` 也能注入；上游 URL 不可解析 ⇒ 原样返回（不猜）', () => {
  assert.ok(injectProxiedDocPatches('<div>x</div>', UP).startsWith('<base href='), '没有 head/html ⇒ 前置');
  const noHead = injectProxiedDocPatches('<html x><body>y</body></html>', UP);
  assert.ok(noHead.indexOf('<base href=') > noHead.indexOf('<html x>'), '有 html ⇒ 插在 html 之后');

  const raw = '<html><head></head></html>';
  assert.equal(injectProxiedDocPatches(raw, ''), raw);
  assert.equal(injectProxiedDocPatches(raw, 'not a url'), raw);
  assert.equal(docPatchHead('not a url'), '');
});

test('上游无 query ⇒ 只注 `<base>`（不写无意义的 replaceState）', () => {
  const p = docPatchHead('https://a.b/c.html');
  assert.ok(p.startsWith('<base href="https://a.b/c.html">'));
  assert.ok(!p.includes('replaceState'), `实际：${p}`);
});

test('属性值转义：上游 URL 里的引号/& 不破坏 `<base>`', () => {
  const p = docPatchHead('https://a.b/c.html?q="x"&y=<z>');
  assert.ok(p.includes('&quot;') && p.includes('&amp;') && p.includes('&lt;'), `实际：${p}`);
});

/**
 * `#457` ★ 回归锁：**只看 `content-type` 不够，必须看 body 形状**。
 *
 * 用户 2026-10-14 实测（「源仓库导入失败」）：`www.yckceo.com/index/durl/add.html?data=…`
 * 是 `text/html` 却只回 **一行纯文本 URL**（62 字节）⇒ 补丁被注入到纯文本前 ⇒ 站内脚本
 * （经壳层 NET 桥 `fetch` 它）拿到 `<base href=…><script>…</script>https://…` ⇒ 弹层里的
 * "生成地址"被污染 ⇒ 复制到导入框报「请输入 http(s) 开头的地址」。
 */
test('#457 判据：纯文本 / JSON / 清单**不算文档**（补丁绝不注入它们）', () => {
  // ↑ 上面那行是**实测原样**的响应体（一行临时地址）
  const plainOneLine = 'https://www.yckceo.com/d/e5d4ecc64b4c21055ad6a3f9f5d65c26\n';
  assert.equal(looksLikeHtmlDocument(plainOneLine), false, '一行纯文本不得当文档（本次回归的根因）');
  assert.equal(looksLikeHtmlDocument('{"a":1}'), false, 'JSON 不是文档');
  assert.equal(looksLikeHtmlDocument('  [1,2,3]'), false, 'JSON 数组不是文档');
  assert.equal(looksLikeHtmlDocument('#EXTM3U\n#EXTINF:10,\nhttps://x/y.ts'), false, 'm3u8 清单不是文档');
  assert.equal(looksLikeHtmlDocument(''), false);
  assert.equal(looksLikeHtmlDocument('   \n  '), false, '空白不是文档');
  // 保守：`<html` 出现在 2KB 之后 ⇒ 不当文档（宁可少注入）
  assert.equal(looksLikeHtmlDocument('x'.repeat(3000) + '<html>'), false);

  // 真文档必须认（否则 `#435` 的播放器修复会被误伤）
  for (const doc of [
    '<!doctype html><html><head><title>t</title></head><body></body></html>',
    '<HTML><HEAD></HEAD></HTML>',
    '<head><script src="hls7.min.js"></script></head>',
    '<html x><body>y</body></html>',
  ]) {
    assert.equal(looksLikeHtmlDocument(doc), true, `应认作文档：${doc.slice(0, 40)}`);
  }
});

test('#457 接线锁：`/api/proxy` 的文档补丁必须先过这条判据', () => {
  const src = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
  assert.match(
    src,
    /!partial && \/html\/i\.test\(type\) && looksLikeHtmlDocument\(docText\)/,
    '补丁的闸门必须是 content-type **且** body 像文档（两根判据一起）',
  );
  assert.match(src, /import \{[\s\S]*looksLikeHtmlDocument[\s\S]*\} from '@yuedu\/core'/, '判据必须来自 core（唯一实现）');
});