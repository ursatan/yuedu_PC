/**
 * `#627` 「远端字体失效 ⇒ 本地回落」的**可验证判据**。
 *
 * 爱丽丝相关源生成的正文里，`@font-face` 的 `src` 指向已失效的远端 ttf
 * （地址现在返回 HTML），浏览器解码失败后整段正文落到默认字体/方框。
 *
 * Node 里没有 `document.fonts`，所以这里锁三层**静态可证**的东西：
 *  ① 只认「远程 @font-face」才注入（普通正文零改动）；
 *  ② 回落声明只含 `local()` 来源 —— **绝不再引用那条失效远端 URL**；
 *  ③ 壳内脚本以 `FontFace.status === "error"` 判定（不是「没声明」、也不是「还在加载」），
 *     且只改**用到该 family 的元素**（不全局 `*`，避免图标字体被一起改）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildHtmlDoc } from '../src/utils/html-shell';
import {
  LOCAL_FONT_FALLBACK_STACK,
  extractRemoteFontFamilies,
  fontFallbackCss,
  fontFallbackScript,
  planFontFallback,
} from '../src/utils/font-fallback';

const REMOTE_FACE =
  '@font-face{font-family:"Source Han Sans CN";src:url("https://alanskycn.gitee.io/teachme/assets/font/Source Han Sans CN Regular.ttf") format("truetype")}';
// 页面自带样式带 id：方便断言「没有额外插入静态 <style>@font-face」
const REMOTE_DOC =
  `<html><head><style id="page-font">${REMOTE_FACE}</style></head><body><p>正文</p></body></html>`;

test('#627 只把「远程 @font-face」当需要回落的 family', () => {
  assert.deepEqual(extractRemoteFontFamilies(REMOTE_DOC), ['Source Han Sans CN']);
  // data: 内联字体是自足的，不需要回落
  assert.deepEqual(
    extractRemoteFontFamilies('<style>@font-face{font-family:X;src:url(data:font/ttf;base64,AA==)}</style>'),
    [],
  );
  // 纯 local() 也不触发
  assert.deepEqual(
    extractRemoteFontFamilies('<style>@font-face{font-family:Y;src:local("KaiTi")}</style>'),
    [],
  );
  // 注释里的示例不算
  assert.deepEqual(
    extractRemoteFontFamilies(`<!-- ${REMOTE_FACE} --><p>无字体</p>`),
    [],
  );
});

test('#627 回落字体栈：楷体系列在前，末尾必须有通用回退', () => {
  for (const f of ['KaiTi', 'STKaiti', '楷体']) {
    assert.ok(LOCAL_FONT_FALLBACK_STACK.includes(f), `栈里必须有 ${f}`);
  }
  assert.match(LOCAL_FONT_FALLBACK_STACK, /serif$/, '末尾必须是通用 serif（否则可能落回方框）');
});

test('#627 回落 @font-face 只用 local()，不含任何网络地址', () => {
  const css = fontFallbackCss(['Source Han Sans CN']);
  assert.match(css, /@font-face\{font-family:"Source Han Sans CN";src:local\(/);
  assert.equal(/https?:|url\(\s*["']?\s*\/\//i.test(css), false, '回落声明不得再引用远端 URL');
  assert.ok(!css.includes('alanskycn.gitee.io'), '失效的外链一个字都不能带进回落 CSS');
  assert.ok(!css.includes('http'), '不许有 http 字样');
});

test('#627 壳内脚本：以 FontFace.status === "error" 判定，且只改用到该 family 的元素', () => {
  const js = fontFallbackScript(['Source Han Sans CN']);
  assert.match(js, /status==="error"/, '必须是真实加载失败，而不是「未声明/加载中」');
  assert.match(js, /data-yuedu-font-fallback/, '必须留下可验证的标记');
  assert.match(js, /getComputedStyle\(el\)\.fontFamily/, '按元素实际 font-family 判定（不能全局 *）');
  assert.match(js, /setProperty\("font-family",STACK,"important"\)/, '要能压过站点 !important 声明');
  assert.equal(/\bhttps?:\/\//i.test(js), false, '脚本内不得出现远端字体地址');
  assert.equal(js.includes('`'), false, 'srcdoc 拼接纪律：脚本文本里不能出现反引号');
  assert.equal(js.includes('</script>'), false, 'srcdoc 拼接纪律：不能出现字面 script 闭合标签');
});

test('#627 planFontFallback：普通正文返回 null（零注入）', () => {
  assert.equal(planFontFallback('<p>纯文本</p>'), null);
  assert.equal(planFontFallback(''), null);
  const plan = planFontFallback(REMOTE_DOC);
  assert.ok(plan, '远程字体文档必须给出回落方案');
  assert.deepEqual(plan?.families, ['Source Han Sans CN']);
});

test('#627 buildHtmlDoc：远程字体文档注入、普通文档一字不加，且脚本在页面样式之后', () => {
  const plain = buildHtmlDoc('<p>纯文本</p>');
  assert.equal(plain.includes('yuedu-font-fallback'), false, '普通文档不得有任何字体回落代码');

  const doc = buildHtmlDoc(REMOTE_DOC);
  assert.ok(doc.includes('yuedu-font-fallback'), '远程字体文档必须注入回落');
  assert.ok(doc.includes('src:local('), '脚本内必须带本地字体候选（运行时按 error 才追加）');
  // ★ 静态输出不得预置本地别名 @font-face：同 family 的后声明会覆盖页面自带的声明，
  //   那样远端字体正常时也会被换成本地字体。别名只能由脚本在确认 error 后动态插入。
  assert.equal(doc.includes('<style>@font-face{font-family'), false, '不得静态预置本地别名');
  // 顺序：页面自带的 @font-face 在前，回落脚本在后（脚本运行时 append 的别名才是最后一条）
  const pageStyle = doc.indexOf(REMOTE_FACE);
  const fallbackJs = doc.indexOf('src:local(');
  assert.ok(pageStyle >= 0 && fallbackJs >= 0, '页面字体声明与回落脚本必须都在');
  assert.ok(fallbackJs > pageStyle, '回落脚本必须排在页面样式之后');
  assert.ok(fallbackJs < doc.indexOf('</head>'), '回落脚本必须在 head 内（解析早于正文）');
});

test('#627 html-shell 接线：唯一注入点在 buildHtmlDoc 的 </head> 之前', () => {
  const src = readFileSync(join(process.cwd(), 'src/utils/html-shell.ts'), 'utf8');
  assert.match(src, /import \{ planFontFallback \} from '\.\/font-fallback'/, '必须复用同一份纯函数');
  assert.match(src, /const fontPlan = planFontFallback\(raw\)/, '按正文内容门控');
  assert.match(src, /fontInject \+ '<\/head>'/, '回落件插到 head 末尾（页面样式之后）');
});
