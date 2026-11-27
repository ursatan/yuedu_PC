/**
 * `#531` 回归锁：**JS 规则返回 jsoup `Elements`（元素数组）时不得塌成 1 个字符串**，
 * 且两条求值路径（L1 / worker）结果必须逐项一致。
 *
 * ## 症状（用户实测）
 * 🔍 找书啦·求书互助（zhaoshu.la）发现页进书 →「搜索 ✓ / 详情 ✓ / **目录 0 章**」，
 * `tocError = "e.hasClass is not a function"`。该源 `ruleToc.chapterList` 是整段 `@js:`：
 * `new Packages.org.jsoup.select.Elements()` → `out.add(box)` / `out.add(r)` → `return out`。
 *
 * ## 取证链（逐层，均已复跑）
 *   ① 页面是**服务端渲染**（静态 HTML 里就有 `h1.request-book-name` 与 `div.reply-item`），
 *      不是「回复动态加载」⇒ 排除站点侧；
 *   ② worker 路径：`__yueduSendable` 对元素包装做 `structuredClone` **必失败**
 *      （包装上 `html/text/attr/select…` 都是**可枚举函数**）⇒ 退化成 `String(v)`，
 *      而 jsoup `Elements.toString()` = **全表 outerHTML 拼接** ⇒ 2 个元素塌成 1 个字符串
 *      （`els.length = 1`）；
 *   ③ 阶段二 `chapterName` 里 `result` 是那个字符串，worker 内 `typeof result.hasClass`
 *      不再是 function ⇒ 脚本抛错 ⇒ 整个目录段失败 ⇒ 0 章；
 *   ④ L1 路径另有同族缺口：`result` 是「String 包装 + 桥接」的**假 Document**，
 *      其元素面缺 `clone()/child(i)`、且 `attr(k,v)` **写形态被静默丢弃**
 *      ⇒ `h1.clone is not a function` / `data-rid` 恒空。
 *
 * ## Legado 语义
 * `AnalyzeRule` 在 Rhino 里 `bindings["result"]` 就是那个 JS 返回的 Java 对象
 * （`Elements` / `Element`），**方法面与身份都保留**，两个阶段看到的是同一个对象。
 * 我们跨 postMessage 传不了函数 ⇒ 走「描述符回流 + 宿主按 nid 重建」（与规则桥
 * `java.getElements` 同一条通道）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzeRule, createJsEvaluator, createMemoryKeyValueStore, createVariableStore } from '../index';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';

/** 复刻 zhaoshu.la/request/N.html 的目录相关结构（h1 带徽标 + 回复项 + 外链回复） */
const HTML = `<html><body>
<h1 class="request-book-name">📖 我的大宝剑 <span class="badge badge-solved">已解决</span></h1>
<div class="reply-section">
  <div class="reply-item accepted">
    <div class="reply-user-name-row"><a href="/user/1.html">找书啦管理员</a></div>
    <div class="reply-text">该回复已被采纳为最佳答案</div>
    <button data-type="reply" data-id="403">赞</button>
    <a href="https://other.example/book/9.html">外部书源</a>
  </div>
</div>
</body></html>`;

const BASE = 'https://www.zhaoshu.la/request/512.html';

/** 源里 `ruleToc.chapterList` 的**逐字形态**（Elements + clone 净化 + parseBodyFragment child + attr 写 + text 写） */
const LIST_RULE = `@js:(function(){var Jsoup=Packages.org.jsoup.Jsoup;var d=(result&&typeof result.select==='function')?result:Jsoup.parse(String(result));var out=new Packages.org.jsoup.select.Elements();var h1=d.select('h1.request-book-name').first();var title=h1?(function(){var c=h1.clone(),bs=c.select('span.badge');for(var z=0;z<bs.size();z++)bs.get(z).remove();return String(c.text());})().replace(/^[\\s📖]+/,'').trim():'求书原帖';var box=Jsoup.parseBodyFragment('<div class="zs-intro" data-rid="intro" data-no="0"></div>').body().child(0);box.text('📋 求书原帖｜'+title);out.add(box);var rs=d.select('div.reply-item');for(var i=0;i<rs.size();i++){var r=rs.get(i);var b=r.select('button[data-type=reply]').first();r.attr('data-rid',b?b.attr('data-id'):('n'+(i+1)));r.attr('data-no',String(i+1));out.add(r);var gl=r.select('a[href]');var got={};for(var j=0;j<gl.size();j++){var hu=String(gl.get(j).attr('href'));if(hu.indexOf('http')!==0||hu.indexOf('zhaoshu.la')>=0||got[hu]){continue;}got[hu]=1;var op=Jsoup.parseBodyFragment('<div class="zs-open"></div>').body().child(0);op.attr('data-rid','open-'+encodeURIComponent(hu));op.attr('data-no',String(i+1));var zh=hu.substring(hu.indexOf('//')+2).split('/')[0].replace(/^www\\./,'');op.text('🔗 一键开书 · 回复'+(i+1)+' · '+zh);out.add(op);}}return out;})()`;

/** 源里 `ruleToc.chapterName`（把 `result` 当**元素**用：hasClass/attr/select/text） */
const NAME_RULE = `@js:(function(){var e=result;if(e.hasClass('zs-intro')||e.hasClass('zs-open'))return e.text();var no=e.attr('data-no');var t=e.select('div.reply-text').first();var tx=String(t?t.text():'');return '💬 回复'+no+'｜'+tx;})()`;

/** 源里 `ruleToc.chapterUrl`（读阶段一写下的 `data-rid`） */
const URL_RULE = `@js:(function(){var b=baseUrl||'';return b+'#reply-'+result.attr('data-rid');})()`;

type Out = { count: number; names: string[]; urls: string[] };

/** 按 engine.ts 的目录流程跑：getElements → 逐元素 chapterName / chapterUrl */
async function runToc(jsEval: unknown): Promise<Out> {
  const variables = createVariableStore();
  const env = {
    baseUrl: BASE,
    variables,
    storage: createMemoryKeyValueStore(),
    jsEval,
    jsEvalSync: jsEval,
    toAbsolute: (u: string) => u,
    // 与生产线一致（引擎注入的 source 字段快照 ⇒ 绑定可克隆 ⇒ 真正落 worker）
    sourceFields: { bookSourceUrl: 'https://www.zhaoshu.la', bookSourceName: '找书啦' },
    bookData: { bookUrl: BASE },
  } as never;
  const els = await new AnalyzeRule(env).setContent(HTML, BASE).getElements(LIST_RULE);
  const names: string[] = [];
  const urls: string[] = [];
  for (const el of els) {
    const ea = new AnalyzeRule(env).setContent(el as object, BASE);
    names.push(await ea.getString(NAME_RULE));
    urls.push(await ea.getString(URL_RULE));
  }
  return { count: els.length, names, urls };
}

test('#531 JS 返回 Elements：worker 路径不得塌成 1 个字符串（L1 与 worker 逐项一致）', async () => {
  const expected: Out = {
    count: 3,
    names: ['📋 求书原帖｜我的大宝剑', '💬 回复1｜该回复已被采纳为最佳答案', '🔗 一键开书 · 回复1 · other.example'],
    urls: [
      `${BASE}#reply-intro`,
      `${BASE}#reply-403`,
      `${BASE}#reply-open-${encodeURIComponent('https://other.example/book/9.html')}`,
    ],
  };

  // ---- L1（无 pool ⇒ createHybridJsEvaluator 直接返回 l1）----
  const l1 = createHybridJsEvaluator({ variables: createVariableStore() });
  const l1out = await runToc(l1);
  assert.deepEqual(l1out, expected, `L1 目录应 3 章且 URL 带 data-rid：${JSON.stringify(l1out)}`);

  // ---- worker ----
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: '' }),
  });
  const wout = await runToc(ev);
  assert.deepEqual(wout, expected, `worker 目录应 3 章且 URL 带 data-rid（不得塌成字符串）：${JSON.stringify(wout)}`);
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

test('#531 阶段一写下的属性必须能被阶段二读到（nid 身份不因跨 worker 而丢）', async () => {
  const variables = createVariableStore();
  const pool = createWorkerSandboxPool({ size: 1 });
  const jsEval = createHybridJsEvaluator({
    variables,
    pool,
    http: async () => ({ status: 200, headers: {}, body: '' }),
  });
  const env = {
    baseUrl: BASE,
    variables,
    storage: createMemoryKeyValueStore(),
    jsEval,
    jsEvalSync: jsEval,
    toAbsolute: (u: string) => u,
    sourceFields: { bookSourceUrl: 'https://www.zhaoshu.la', bookSourceName: '找书啦' },
    bookData: { bookUrl: BASE },
  } as never;
  const els = await new AnalyzeRule(env).setContent(HTML, BASE).getElements(LIST_RULE);
  assert.equal(els.length, 3, `元素个数必须是 3（塌成字符串时会是 1）：${els.length}`);
  // 宿主拿到的必须是**可链式活元素**（不是字符串、不是纯 JSON）
  const first = els[0] as { hasClass?: (c: string) => boolean; attr: (k: string) => string };
  assert.equal(typeof first?.hasClass, 'function', '元素上必须仍有 jsoup 方法（hasClass）');
  assert.equal(first.attr('data-rid'), 'intro', '元素必须按 nid 读**活节点**（阶段一写入可见）');
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

test('#531 L1 桥面补齐 clone/child 与 attr(text) 写形态（同一条 ruleToc 在无 pool 时也通）', async () => {
  const variables = createVariableStore();
  // 纯 L1：createJsEvaluator（引擎在无 worker 池时的兜底路径）
  const jsEval = createJsEvaluator({ variables, sourceLabel: 'test' });
  const env = {
    baseUrl: BASE,
    variables,
    storage: createMemoryKeyValueStore(),
    jsEval,
    jsEvalSync: jsEval,
    toAbsolute: (u: string) => u,
    sourceFields: { bookSourceUrl: 'https://www.zhaoshu.la' },
    bookData: { bookUrl: BASE },
  } as never;
  const ar = new AnalyzeRule(env).setContent(HTML, BASE);
  const probe = await ar.runJs(
    "var d=result;var h1=d.select('h1.request-book-name').first();" +
      "var c=h1.clone();var bs=c.select('span.badge');bs.get(0).remove();" +
      "d.select('div.reply-item').first().attr('data-rid','X9');" +
      "JSON.stringify({ clone: typeof h1.clone, child: typeof d.select('body').first().child," +
      " cleaned: String(c.text()).trim(), writeBack: d.select('div.reply-item').first().attr('data-rid') });",
  );
  const v = JSON.parse(String(probe)) as { clone: string; child: string; cleaned: string; writeBack: string };
  assert.equal(v.clone, 'function', 'L1 桥面必须有 clone');
  assert.equal(v.child, 'function', 'L1 桥面必须有 child');
  assert.equal(v.cleaned, '📖 我的大宝剑', 'clone 后删徽标只作用于副本');
  assert.equal(v.writeBack, 'X9', 'attr(k,v) 写形态必须生效（此前被静默丢弃）');
});
