/**
 * `#523` 回归锁：**worker 侧 `document` / `window`**（挂账 `#92` 的 worker 半边）。
 *
 * ## 背景
 * 宿主（L1）的 `document` 是当前内容**真实的 jsdom Document**（`#92`：腾讯漫画正文页的浏览器探针
 * `eval("!!document.getElementsByTagName('html')")` 要算进 nonce，缺它就整条规则崩）。
 * worker 里既无 DOM 也无 jsdom ⇒ 此前由 `js.ts` 的 `HOST_DOCUMENT_RE`（**文本暴匹配**）把
 * 「文本里出现 `document.`」的源一律强留 L1 —— 代价是这些源的 `java.ajax` 继续在主线程
 * `execFileSync` 同步阻塞（`#497` 实证的 stall 家族），而语料里 27 个提到 `document` 的源中
 * 绝大多数只是把它写在 **webView/webJs 的 HTML 载荷字符串**里（求值器根本不执行那段）。
 *
 * ## 本批
 * ① worker 侧补 `document`（只读 DOM facade，活节点仍在宿主，走 `rpc('dom')`）与 `window`（= 全局对象）；
 * ② 路由守卫从「文本暴匹配」改为「**成员白名单**」：白名单内成员 ⇒ 落 worker；名单外成员、裸
 *    `document`、或内容不是可下发字符串 ⇒ 仍留 L1（宁留也不静默半残）。
 *
 * 四条不变量：①两条路径结论逐字一致；②白名单源**真的落 worker**（无 l1-eval）；③名单外成员留 L1；
 * ④`window` 在 worker 里就是全局对象（浏览器语义）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalyzeRule, createMemoryKeyValueStore, createVariableStore, parseHtmlStats } from '../index';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { blockSamples, resetBlocks } from '../diag/block-stats';

const PAGE =
  '<html><head><title>页面标题</title></head>' +
  '<body><div id="x" class="box">正文甲</div><p class="c">第二段</p></body></html>';

/** 宿主 `document-binding.test.ts` 的同款探针（白名单成员全覆盖） */
const PROBE = [
  `String(!!document.getElementsByTagName('html'))`,
  `String(document.getElementsByTagName('html').length)`,
  `document.documentElement.nodeName`,
  `document.getElementById('x').textContent`,
  `String(document.querySelector('.c').innerHTML)`,
  `String(document.getElementById('x').className)`,
  `String(document.querySelectorAll('p').length)`,
  `document.title`,
  `String(window === globalThis)`,
  `String(typeof window.Array)`,
].join('\\n');

function envOf(jsEval: unknown, variables = createVariableStore()): object {
  return {
    baseUrl: 'https://ac.qq.com/ComicView/index/id/1/cid/1',
    variables,
    storage: createMemoryKeyValueStore(),
    jsEval,
    jsEvalSync: jsEval,
    toAbsolute: (u: string) => u,
    sourceFields: { bookSourceUrl: 'https://ac.qq.com', bookSourceName: '腾讯漫画(test)' },
    bookData: { bookUrl: 'https://ac.qq.com/ComicView/index/id/1/cid/1' },
  };
}

test('#523 document/window：worker 与 L1 的取值**逐字一致**，且该源真落 worker', async () => {
  // 逐条求值（每条独立一次 eval，避免多行脚本只取最后一行）
  const probes = PROBE.split('\\n');
  const l1 = createHybridJsEvaluator({ variables: createVariableStore() });
  const l1out: string[] = [];
  for (const p of probes) l1out.push(String(await new AnalyzeRule(envOf(l1) as never).setContent(PAGE).getString(`@js:${p}`)));

  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: '' }),
  });
  resetBlocks();
  const wout: string[] = [];
  for (const p of probes) wout.push(String(await new AnalyzeRule(envOf(ev) as never).setContent(PAGE).getString(`@js:${p}`)));

  // ① 逐条一致（含 `document.documentElement.nodeName` / `getElementsByTagName('html')` 的**含根**语义）
  assert.deepEqual(wout, l1out, `worker 与 L1 必须逐字一致：\nworker=${JSON.stringify(wout)}\nL1=${JSON.stringify(l1out)}`);
  // ② 值本身就对齐浏览器（不是「两条路径一起错」）
  assert.equal(l1out[0], 'true', `getElementsByTagName('html') 应为真值：${l1out[0]}`);
  assert.equal(l1out[2], 'HTML', `documentElement.nodeName：${l1out[2]}`);
  assert.equal(l1out[3], '正文甲', `getElementById('x').textContent：${l1out[3]}`);
  assert.equal(l1out[6], '1', `querySelectorAll('p').length：${l1out[6]}`);
  assert.equal(l1out[7], '页面标题', `document.title：${l1out[7]}`);
  assert.equal(l1out[8], 'true', `window === globalThis：${l1out[8]}`);
  // ③ 真落 worker：白名单内的 document 用法**不应**触发任何 L1 求值
  const l1samples = blockSamples().filter((s) => s.kind === 'l1-eval');
  assert.equal(l1samples.length, 0, `白名单内用法应落 worker，不该有 L1 求值：${JSON.stringify(l1samples)}`);
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

test('#523 document：惰性 —— 不读 document 的脚本 0 次额外解析（L1 与 worker 都不变量）', async () => {
  const l1 = createHybridJsEvaluator({ variables: createVariableStore() });
  const b0 = parseHtmlStats.count;
  assert.equal(String(await new AnalyzeRule(envOf(l1) as never).setContent(PAGE).getString('@js:1 + 1')), '2');
  assert.equal(parseHtmlStats.count - b0, 0, `L1 不读 document 就不该解析：+${parseHtmlStats.count - b0}`);

  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool, http: async () => ({ status: 200, headers: {}, body: '' }) });
  const b1 = parseHtmlStats.count;
  assert.equal(String(await new AnalyzeRule(envOf(ev) as never).setContent(PAGE).getString('@js:1 + 1')), '2');
  assert.equal(parseHtmlStats.count - b1, 0, `worker 不读 document 也不该解析：+${parseHtmlStats.count - b1}`);
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

test('#523 路由守卫：名单外成员 / 非字符串内容 ⇒ 仍留 L1（宁留也不静默半残）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool, http: async () => ({ status: 200, headers: {}, body: '' }) });
  const env = envOf(ev) as never;

  // ① 名单外成员（createElement）⇒ L1
  resetBlocks();
  await new AnalyzeRule(env).setContent(PAGE).getString('@js:typeof document.createElement');
  assert.equal(
    blockSamples().filter((s) => s.kind === 'l1-eval').length, 1,
    'document.createElement 不在白名单 ⇒ 必须留 L1',
  );

  // ② 裸 document（可能被赋给别名后乱用）⇒ L1
  resetBlocks();
  await new AnalyzeRule(env).setContent(PAGE).getString('@js:typeof document');
  assert.equal(blockSamples().filter((s) => s.kind === 'l1-eval').length, 1, '裸 document ⇒ 必须留 L1');

  // ③ 内容不是字符串（元素内容：没有可下发的 content 字符串）⇒ L1
  resetBlocks();
  const dom = (await import('../index')).parseHtml(PAGE);
  const el = dom.root.querySelector('#x') as Element;
  await new AnalyzeRule(env).setContent(el as never).getString('@js:document.documentElement.nodeName');
  assert.equal(
    blockSamples().filter((s) => s.kind === 'l1-eval').length, 1,
    '元素内容没有可下发的 content 字符串 ⇒ 必须留 L1',
  );

  // ④ 对偶（防空转）：白名单成员 + 字符串内容 ⇒ 走 worker（0 次 L1）
  resetBlocks();
  await new AnalyzeRule(env).setContent(PAGE).getString('@js:document.title');
  assert.equal(blockSamples().filter((s) => s.kind === 'l1-eval').length, 0, '白名单成员应走 worker');
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});


/**
 * `#536b` **lib 内 document 用法的可达性**（`#523` 成员白名单的第二道细化）。
 *
 * 真实案例：七猫 jsLib 56KB 里 `paint()` 用 `document.createElement` 渲染**书评页 UI**
 * （在 WebView 里跑，evaluator 从不执行），但旧守卫扫 lib+code ⇒ 整个源锁 L1 ⇒
 * category/detail 全走同步 HTTP（单次 1s）。现在只有「规则代码可达」的函数才锁 L1。
 */
test('#536b document 守卫：lib 里不可达的用法不锁 L1；可达（含 2 跳）仍锁', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const LIB_DEAD = 'function paint(){ document.createElement("button"); }\nfunction dataFn(a){ return String(a).length; }';
  const LIB_LIVE = 'function build(){ document.createElement("b"); }\nfunction entry(){ build(); }';
  const mk = (lib: string) =>
    createHybridJsEvaluator({ variables: createVariableStore(), pool, lib, http: async () => ({ status: 200, headers: {}, body: '' }) });
  const run = async (lib: string, code: string): Promise<number> => {
    const ev = mk(lib);
    resetBlocks();
    await new AnalyzeRule(envOf(ev) as never).setContent(PAGE).getString(`@js:${code}`);
    return blockSamples().filter((s) => s.kind === 'l1-eval').length;
  };

  // ① lib 有 paint（不可达）+ 规则只调 dataFn ⇒ worker（0 次 L1）
  assert.equal(await run(LIB_DEAD, 'dataFn("abc")'), 0, '不可达的 document 用法不该锁 L1');

  // ② 规则直接引用 paint ⇒ 可达 ⇒ L1
  assert.equal(await run(LIB_DEAD, 'typeof paint'), 1, '规则可达的 document 用法必须留 L1');

  // ③ 2 跳可达（entry → build → document）⇒ L1
  assert.equal(await run(LIB_LIVE, 'entry()'), 1, '经 2 跳调用的 document 用法必须留 L1');

  // ④ 规则代码自己用名单外成员 ⇒ L1（原有判据不变）
  assert.equal(await run(LIB_DEAD, 'typeof document.createElement'), 1, '规则自身名单外用法仍留 L1');

  // ⑤ 回退开关：YUEDU_DOC_REACH=0 ⇒ 恢复旧行为（lib 有任何名单外 document 就 L1）
  const prev = process.env.YUEDU_DOC_REACH;
  process.env.YUEDU_DOC_REACH = '0';
  try {
    assert.equal(await run(LIB_DEAD, 'dataFn("abc")'), 1, 'REACH=0 必须回到旧行为');
  } finally {
    if (prev === undefined) delete process.env.YUEDU_DOC_REACH;
    else process.env.YUEDU_DOC_REACH = prev;
  }
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});
