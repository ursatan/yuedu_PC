/**
 * `#364` **存储垫片**的回归锁 —— 直接**执行**壳层生成的那段脚本，断言语义。
 *
 * ## 为什么这么测（而不是看字符串）
 * 垫片的核心语义是「**真访问抛错才覆盖**」（自门控）：沙箱里 `window.localStorage`
 * 读属性就抛 SecurityError（用户 2026-10-09 实测「阅读 · 全版本汇总」整站初始化中断）；
 * 非沙箱环境不抛 ⇒ 一字不改。必须分别构造「抛错」与「不抛」两种假环境真跑一遍，
 * 断言两侧行为 —— 只 grep 字符串锁不住「自门控」这半个语义。
 *
 * 真浏览器端到端证据：`.tmp-r3/storage-probe-run.cjs`（真 Chromium 151，srcdoc sandbox）
 * —— 垫片三属性（localStorage/sessionStorage/document.cookie）读写回路全 OK。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStorageShim, buildHtmlDoc, buildStartPageJavaShim } from '../src/utils/html-shell';

/** 在假环境里跑垫片；`lsThrows`/`ssThrows`/`cookieThrows` 控制三属性的「真访问」行为 */
function run(opts: { lsThrows?: boolean; ssThrows?: boolean; cookieThrows?: boolean } = {}) {
  const secErr = () => {
    throw new Error(
      "SecurityError: Failed to read the 'localStorage' property from 'Window': " +
        "The document is sandboxed and lacks the 'allow-same-origin' flag.",
    );
  };

  // 模拟真沙箱语义：**读属性本身**就抛（不是 getItem 抛）；非沙箱侧给带 getItem 的「真存储」
  // （垫片探针要真调一次 getItem —— 假对象没这方法会 TypeError ⇒ 被误判成沙箱，测不出自门控）
  const realLS = { get: () => (opts.lsThrows ? secErr() : { getItem: () => null }) };
  const realSS = { get: () => (opts.ssThrows ? secErr() : { getItem: () => null }) };

  const win = {} as Record<string, unknown>;
  Object.defineProperty(win, 'localStorage', { get: () => realLS.get(), configurable: true, enumerable: true });
  Object.defineProperty(win, 'sessionStorage', { get: () => realSS.get(), configurable: true, enumerable: true });

  let cookieVal = 'a=1';
  const doc = {
    get cookie() {
      if (opts.cookieThrows) secErr();
      return cookieVal;
    },
    set cookie(v: string) {
      if (opts.cookieThrows) secErr();
      cookieVal = v;
    },
  } as unknown as Document;

  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', buildStorageShim());
  fn(win, doc);
  return { win, doc };
}

test('垫片 · 沙箱环境：localStorage 抛错 ⇒ 被内存态覆盖，读写/删除/清空/length/key 回路', () => {
  const { win } = run({ lsThrows: true });
  const ls = win['localStorage'] as Storage;
  assert.ok(ls, '覆盖后必须有值');
  assert.equal(ls.getItem('k'), null, '初始为空');
  ls.setItem('k', 'v1');
  assert.equal(ls.getItem('k'), 'v1');
  ls.setItem('k', 'v2');
  assert.equal(ls.getItem('k'), 'v2', '同名覆盖');
  ls.setItem('k2', 'v');
  assert.equal(ls.length, 2);
  assert.equal(ls.key(0), 'k');
  assert.equal(ls.key(5), null, '越界返回 null');
  ls.removeItem('k');
  assert.equal(ls.getItem('k'), null);
  assert.equal(ls.length, 1);
  ls.clear();
  assert.equal(ls.length, 0);
  // 数字会被转字符串（Storage 语义）
  ls.setItem('n', 123 as unknown as string);
  assert.equal(ls.getItem('n'), '123');
});

test('垫片 · 沙箱环境：sessionStorage 抛错 ⇒ 同样被覆盖', () => {
  const { win } = run({ ssThrows: true });
  const ss = win['sessionStorage'] as Storage;
  ss.setItem('s', 't');
  assert.equal(ss.getItem('s'), 't');
});

test('垫片 · 非沙箱环境：真访问不抛 ⇒ **一字不改**（自门控的另一半）', () => {
  const { win, doc } = run({ lsThrows: false, ssThrows: false, cookieThrows: false });
  // 假环境的「真存储」就是空对象读写 —— 若垫片错误地覆盖了它，getItem 行为会变
  const ls = win['localStorage'] as unknown as { v?: Record<string, string> };
  assert.ok(ls, '仍是原对象（可访问）');
  assert.equal((doc.cookie as unknown as string) || 'a=1', 'a=1', 'cookie 原样');
  // 对偶：shim 没有被装进一个「干净的新存储」—— 原描述符仍在
  const d = Object.getOwnPropertyDescriptor(win, 'localStorage');
  assert.ok(d?.get, '非沙箱 ⇒ 原 getter 保留（未 defineProperty）');
});

test('垫片 · 沙箱环境：document.cookie 抛错 ⇒ own 属性遮蔽，读/写/同名覆盖', () => {
  const { doc } = run({ cookieThrows: true });
  assert.equal(doc.cookie, '', '初始为空');
  doc.cookie = 'x=1';
  assert.equal(doc.cookie, 'x=1');
  doc.cookie = 'y=2';
  assert.ok(doc.cookie.includes('x=1') && doc.cookie.includes('y=2'));
  doc.cookie = 'x=9';
  assert.equal(doc.cookie, 'x=9; y=2', '同名键原地覆盖（保序），不重复堆积');
});

test('壳 · 存储垫片**无条件注入**且排在其它注入件之前（先于站点脚本就位）', () => {
  // file:// 态（origin 空）也要注入 —— Electron 桌面态同样有沙箱 iframe
  const doc = buildHtmlDoc('<p>x</p>', { sid: 's' });
  const at = doc.indexOf('__yuedu_probe__');
  assert.ok(at > 0, '存储垫片必须注入（探针串）');
  // NAV 桥无条件注入；垫片在它前面
  const nav = doc.indexOf('postMessage');
  assert.ok(nav > at, '垫片必须先于导航桥（解析器顺序 ⇒ 先于一切站点脚本）');
});

test('`#437` 启动页：快照灌入 ⇒ 同步可读；写入 ⇒ 防抖回传宿主（跨重进持久化的关键两半）', async () => {
  // 作者的书架存在 localStorage（千百羽论坛 `pput/pget`），沙箱里必须由宿主落盘 ——
  // 少了任何一半，用户看到的就是「加入书架后重进该源，书架空」。
  const posted: Array<{ key?: string; data?: string }> = [];
  const parent = { postMessage: (m: { yueduStartStorage?: { key?: string; data?: string } }) => { if (m?.yueduStartStorage) posted.push(m.yueduStartStorage); } };
  const win = {} as Record<string, unknown>;
  const secErr = () => {
    throw new Error('SecurityError: sandboxed');
  };
  Object.defineProperty(win, 'localStorage', { get: () => secErr(), configurable: true, enumerable: true });
  Object.defineProperty(win, 'sessionStorage', { get: () => secErr(), configurable: true, enumerable: true });
  const doc = { get cookie() { return ''; }, set cookie(_v: string) {} } as unknown as Document;

  const snap = JSON.stringify({ 'x8_shelf': '{"a":1}' });
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'parent', buildStorageShim({ snapshot: snap, key: 'k1' }))(win, doc, parent);
  const ls = win['localStorage'] as Storage;
  assert.equal(ls.getItem('x8_shelf'), '{"a":1}', '快照必须同步可读（首屏就要渲染书架）');
  ls.setItem('x8_shelf', '{"a":2}');
  await new Promise((r) => setTimeout(r, 600)); // 防抖 400ms
  assert.equal(posted.length, 1, '写入必须回传宿主一次（防抖合并）');
  assert.equal(posted[0]?.key, 'k1');
  assert.equal(JSON.parse(posted[0]!.data!)['x8_shelf'], '{"a":2}');
  // `java.put/get` / `source.put/get` 走同一份存储
  const kv = win['__yueduKV'] as { get: (k: string) => string; put: (k: string, v: string) => string };
  assert.equal(kv.get('x8_shelf'), '{"a":2}', '同一份存储（java.put 与 localStorage 不分裂）');
});

test('`#437` 不传 key ⇒ 不回传宿主（普通正文不往宿主写东西）', async () => {
  const posted: unknown[] = [];
  const parent = { postMessage: (m: unknown) => posted.push(m) };
  const win = {} as Record<string, unknown>;
  const secErr = () => {
    throw new Error('SecurityError: sandboxed');
  };
  Object.defineProperty(win, 'localStorage', { get: () => secErr(), configurable: true, enumerable: true });
  Object.defineProperty(win, 'sessionStorage', { get: () => secErr(), configurable: true, enumerable: true });
  const doc = { get cookie() { return ''; }, set cookie(_v: string) {} } as unknown as Document;
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'parent', buildStorageShim())(win, doc, parent);
  (win['localStorage'] as Storage).setItem('a', 'b');
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(posted, [], '没有 key 就不该回传');
});

test('`#437` 启动页 java 垫片：能力面（charset / hex / 兜底解码 / ajaxAwait / KV）', () => {
  const js = buildStartPageJavaShim({ origin: 'http://127.0.0.1:3000', sid: 's' });
  for (const need of [
    "opt.charset", // `,{"charset":"gbk"}` ⇒ 透传 `&cs=`（服务端按该字符集解码）
    "'&cs='", // 同上
    "'&ty=hex'", // `,{"type":"hex"}` ⇒ 服务端回原始字节的 hex
    'hexDecodeToByteArray', // 作者的兜底：hex → 字节
    'bytesToStr', // 兜底：字节 → 指定字符集文本
    'window.ajaxAwait', // 作者优先用它（Legado 内容页才有）
    '__yueduKV', // 与 localStorage 同一份存储 ⇒ 跨重进持久
  ]) {
    assert.ok(js.includes(need), `启动页垫片必须提供 ${need}`);
  }
  assert.doesNotMatch(js, /`/, '生成的脚本不能有反引号（srcdoc 拼接纪律）');
  assert.doesNotMatch(js, /<\/script/i, '不能出现字面 script 闭合标签');
});

test('垫片 · 生成的脚本**不能有反引号**（会截断拼接它的模板串）', () => {
  assert.doesNotMatch(buildStorageShim(), /`/);
  assert.doesNotMatch(buildStorageShim(), /<\/script/i, '字面 script 闭合标签会提前切断 SFC');
});
