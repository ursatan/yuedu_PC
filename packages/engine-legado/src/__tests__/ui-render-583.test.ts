/**
 * `#583` **源自绘 UI 渲染通道**（七猫：段评 / 本章说 / 神评 / 书评）。
 *
 * 第一版「选项图 ⇒ 下发 html（iframe）」被用户 2026-10-23 复测否决：
 * 书籍正文因此丢了阅读样式 / 划词工具 / 高亮 / 分页。
 * 现在锁的是**文本模式**：
 *  · 正文仍是 `paragraphs`（阅读器原样渲染）；
 *  · 选项图抽成 `uiMarks`（段落末尾的按钮），不再变成 `[图]`，也不再产生 `html`；
 *  · `evalUiAction`：把 `click` / `callBackJs` 放进源真实环境（jsLib + 源桩）求值，
 *    把 `java.showBrowser` 的面板地址带回前端。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LegadoEngine, parseOptionImageSrc } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

/** 段评气泡（行内小图） */
const BUBBLE =
  '<img src="data:image/svg+xml;base64,PHN2Zy8+,{"style":"text","type":"qmpl","click":"qmC_OpenComment(\\"paragraph\\",\\"1\\",\\"2\\",\\"abc\\")"}">';
/** 本章说（整宽条，源把它单独 push 成一行） */
const CHAPTER_BAR =
  '<img src="data:image/svg+xml;base64,QkFSLQ==,{"style":"FULL","type":"qmpl-chapter-preview","click":"qmC_OpenComment(\\"chapter\\",\\"1\\",\\"2\\",\\"\\")"}">';

function makeCtx(body: string): EngineContext {
  return {
    reqId: 'ui-583',
    sourceId: 'https://api-bc.wtzw.com#测试',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        // 目录页/正文页同一个假服务：/ch/ 走正文，其余走「详情页」
        const isChapter = /\/ch\//.test(url);
        return {
          status: 200,
          headers: { 'content-type': isChapter ? 'text/plain' : 'text/html' },
          body: isChapter ? body : '<html><body><div class="ch"><a href="/ch/1">第1章</a></div></body></html>',
          url,
        };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
    toastSink: [],
  };
}

function compile(raw: Record<string, unknown>) {
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

const BASE_RAW = {
  bookSourceUrl: 'https://k.test',
  bookSourceName: '七猫测试',
  searchUrl: 'https://k.test/s?q={{key}}',
  ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
  ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '@js:result' },
};

test('#583 parseOptionImageSrc：按最后一个 ",{" 切分，普通图片不误判', () => {
  const p = parseOptionImageSrc(
    'data:image/svg+xml;base64,AAA,{"style":"text","type":"qmpl","click":"qmC_OpenComment()"}',
  );
  assert.ok(p, '选项图应被识别');
  assert.equal(p!.src, 'data:image/svg+xml;base64,AAA');
  assert.equal(p!.opt['type'], 'qmpl');
  assert.equal(parseOptionImageSrc('https://x.test/a.png'), null, '普通插图不带选项 JSON');
  assert.equal(parseOptionImageSrc('data:image/png;base64,AAA,{bad json}'), null, '坏 JSON 不识别');
});

test('#583 content：文本正文 + uiMarks（不发 html，选项图不再变成 [图]）', async () => {
  const rule = compile(BASE_RAW);
  const raw = `正文第一句${BUBBLE}\n正文第二句\n${CHAPTER_BAR}`;
  const ctx = makeCtx(raw);
  const d = await new LegadoEngine().detail(
    rule as never,
    { action: 'detail', id: JSON.stringify({ bookUrl: 'https://k.test/book/1' }) },
    ctx,
  );
  const ch = d.chapters?.[0];
  assert.ok(ch, '应有章节');
  const c = await new LegadoEngine().content(rule as never, { action: 'content', id: JSON.stringify(ch!.payload) }, ctx);

  assert.equal(c.html, undefined, '不得再下发 html（否则阅读器会切 iframe）');
  assert.deepEqual(c.paragraphs, ['正文第一句', '正文第二句'], '段落保持干净（按钮不混进正文）');
  assert.ok(!c.paragraphs.some((p) => p.includes('[图]')), '选项图不能变成 [图]');

  const marks = c.uiMarks ?? [];
  assert.equal(marks.length, 2, '两个按钮都要下发');
  const bubble = marks.find((m) => m.type === 'qmpl');
  assert.ok(bubble, '段评气泡');
  assert.equal(bubble!.para, 0, '段评挂在第一段');
  assert.equal(bubble!.style, 'text');
  assert.equal(bubble!.label, '段评');
  assert.ok(bubble!.img.startsWith('data:image/svg+xml;base64,'), '按钮图片地址已去掉选项尾巴');
  assert.ok(!bubble!.img.includes(',{'), 'img 里不能带选项 JSON');
  assert.match(bubble!.click, /qmC_OpenComment/);

  const bar = marks.find((m) => m.type === 'qmpl-chapter-preview');
  assert.ok(bar, '本章说条目');
  assert.equal(bar!.para, -1, '本章说挂章末');
  assert.equal(bar!.style, 'full');
  assert.equal(bar!.label, '本章说');
});

test('#583 content：普通文本源零影响（没有 uiMarks / html）', async () => {
  const rule = compile(BASE_RAW);
  const ctx = makeCtx('第一段\n第二段');
  const d = await new LegadoEngine().detail(
    rule as never,
    { action: 'detail', id: JSON.stringify({ bookUrl: 'https://k.test/book/1' }) },
    ctx,
  );
  const ch = d.chapters?.[0];
  const c = await new LegadoEngine().content(rule as never, { action: 'content', id: JSON.stringify(ch!.payload) }, ctx);
  assert.deepEqual(c.paragraphs, ['第一段', '第二段']);
  assert.equal(c.uiMarks, undefined);
  assert.equal(c.html, undefined);
});

test('#583 evalUiAction：jsLib 函数可跑，java.showBrowser 的面板地址带回前端', async () => {
  const raw = {
    ...BASE_RAW,
    jsLib: [
      'function openPanel(bid, ev){',
      '  java.showBrowser("https://api-cmnt.wtzw.com/", "<b>" + bid + "</b>", "", "{}");',
      '  return true;',
      '}',
      'function whichEvent(e){ return String(e); }',
    ].join('\n'),
  };
  const rule = compile(raw);
  const ctx = makeCtx('<html><body></body></html>');
  const engine = new LegadoEngine();
  const r = await engine.evalUiAction(rule as never, { code: 'openPanel("203436", event)' }, ctx);
  assert.equal(r.value, 'true');
  assert.ok(r.browserUrl?.startsWith('data:text/html;base64,'), 'showBrowser 的 html 必须转 data URL');

  // 事件绑定（callBackJs 的分支判据）
  const r2 = await engine.evalUiAction(rule as never, { code: 'whichEvent(event)', event: 'clickCustomButton' }, ctx);
  assert.equal(r2.value, 'clickCustomButton');
});
