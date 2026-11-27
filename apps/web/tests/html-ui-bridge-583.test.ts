/**
 * `#583` **源自绘 UI 的壳层一半**：图片选项 `click` 解析 + 面板里的 `qmRun` RPC 桥。
 *
 * 锁三件事（只看字符串锁不住的部分也一并断言）：
 *  ① 按钮由**引擎重写**成 `src` + `data-yuedu-ui`（裸引号形态进 DOM 会被截断）；
 *  ② 选项图必须打 `data-yuedu-optimg` 标记，且**先于**资源改写桥执行（否则 data URL 被送去做图片解密）；
 *  ③ `qmRun` 只对真的用到的页面注入（普通正文一字不改）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHtmlDoc, buildImageOptionBridge, buildSourceRunBridge } from '../src/utils/html-shell';

const OPTION_IMG =
  '<img src="data:image/svg+xml;base64,PHN2Zy8+" data-yuedu-ui="{&quot;style&quot;:&quot;text&quot;,&quot;type&quot;:&quot;qmpl&quot;,&quot;click&quot;:&quot;qmC_OpenComment()&quot;}">';

test('#583 图片选项桥：读 data-yuedu-ui、按 style 设版式、点击上报 yueduSourceUi', () => {
  const js = buildImageOptionBridge();
  assert.match(js, /data-yuedu-ui/, '必须读引擎重写后的选项属性');
  assert.match(js, /data-yuedu-optimg/, '必须打标记（资源桥据此跳过）');
  assert.match(js, /yuedu-opt-text/, '行内小图版式');
  assert.match(js, /yuedu-opt-full/, '整宽条版式');
  assert.match(js, /yueduSourceUi/, '点击必须上报宿主');
  assert.match(js, /parent\.postMessage/, '沙箱 iframe 只能 postMessage 给父页');
  assert.ok(!js.includes('`'), 'srcdoc 拼接纪律：生成的脚本里不能出现反引号');
});

test('#583 面板 qmRun 桥：返回 Promise，结果按 id 回填', () => {
  const js = buildSourceRunBridge();
  assert.match(js, /window\.qmRun=run/);
  assert.match(js, /yueduSourceRunResult/);
  assert.match(js, /new Promise/);
});

test('#583 buildHtmlDoc：图片桥先于资源桥；qmRun 桥按内容门控', () => {
  const raw = `<div>正文${OPTION_IMG}</div>`;
  const doc = buildHtmlDoc(raw, { origin: 'http://127.0.0.1:3000', sid: 's1' });
  const iOpt = doc.indexOf('data-yuedu-optimg');
  // 资源改写桥的**自身**锚点（不能用 data-original：LIVE 桥里也出现这个词）
  const iRes = doc.indexOf('function fixEl(el)');
  assert.ok(iOpt > 0, '内容页必须注入图片选项桥');
  assert.ok(iRes > 0, '资源改写桥也在');
  assert.ok(iOpt < iRes, '图片选项桥必须排在资源改写桥之前');

  const noRun = buildHtmlDoc(raw, {});
  assert.ok(!noRun.includes('window.qmRun=run'), '普通正文不应注入 qmRun（一字不改）');

  const withRun = buildHtmlDoc('<script>window.qmRun("x")</script>', {});
  assert.ok(withRun.includes('window.qmRun=run'), '评论面板（用到 qmRun）必须注入');
});
