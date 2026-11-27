/**
 * 回归锁：`java.` **规则桥**的两个缺陷面（2026-09-22，🎨快看漫画「详情通了但目录 0 章」排查中挖出）。
 *
 * 背景：该源跨阶段用 `cache` 传 NUXT JSON，目录规则是
 *   `<js>java.setContent(cache.get('kkmh')); result = java.getElements('$.data[*].comicList[*]')</js>`
 * 链路：详情 `init` 里 `cache.put('kkmh', JSON.stringify(__NUXT__))` → 目录阶段 `cache.get` 读出
 * （`#106`，见 `cache-cross-request.test.ts`）→ `java.setContent` 把它设为当前文档 →
 * `java.getElements('$.data[*].comicList[*]')` 取 26 条章节。
 *
 * 这里锁住后两步暴露的两个**类级**缺陷：
 *
 *  · **类V：JSON 对象数组被 `bridgeDom` 换成空列表。**
 *    `bridgeDom` 对「非空但不是 DOM 节点」的数组一律 `bridgeList([])` → `[{id,…},…]` 变空列表
 *    （`length` 为 undefined、`size()` 返回 0）。对齐 Legado 应原样交给脚本
 *    （`AnalyzeRule.kt:440`：`Mode.Json -> getAnalyzeByJSonPath(result).getList(rule)`）。
 *    引擎内探针实测：`innerLen: 2`（求值正确）→ `bridged: isArr=false, size=0`（被清空）。
 *
 *  · **类W：`java.setContent/getElements/getElement/getStringList` 在 worker 路径下静默失效。**
 *    这四个方法在 `WORKER_SRC` 里没有定义、`hostRpc` 里没有分支 → 落到 java Proxy 的
 *    「未实现 → 返回空串」兜底。同一份源、同一次请求：**L1 = 26 章，worker = 0 章**（实测对照）。
 *    修法：这类脚本必须留 L1（`JAVA_RULE_API_RE` 判定，见 js.ts 的注释；RPC 化挂账 #108）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { makeRuleBridge as makeRuleBridgeCore } from '../selector/rule-bridge';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/** 计数池：worker 用例必须**真的**走池（否则回落 L1 也会通过 → 测试空转） */
function countingPool(raw: ReturnType<typeof createWorkerSandboxPool>) {
  const st = { evals: 0 };
  const pool = new Proxy(raw as unknown as Record<string, unknown>, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => {
          st.evals++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ReturnType<typeof createWorkerSandboxPool>;
  return { pool, st };
}

/** 建一套「L1 + javaExtra(ruleApi)」环境，等价于引擎 `makeEnv` 的骨架 */
function makeL1() {
  const variables = createVariableStore();
  const javaExtra: Record<string, unknown> = {};
  const jsEval = createJsEvaluator({ variables, javaExtra });
  const env = { variables, javaExtra, jsEvalSync: jsEval, jsEval };
  const ar = new AnalyzeRule(env as never);
  return { variables, javaExtra, jsEval, ar };
}

/**
 * 规则桥的**测试替身** —— `#313` 起直接复用 core 的唯一实现。
 *
 * 之前这里自己写了一份同构实现，与 `engine-legado` / `engine-rss` 的实现**三处并存**；
 * 给桥加第三个 op（`'object'`，对齐上游 `getElement`）时，三处的参数类型当场对不上
 * （typecheck 直接报 `Type '"object"' is not assignable to type '"elements" | "strings"'`）
 * —— 那次漂移就是这次收敛成 `selector/rule-bridge.ts` 的起因。
 */
const makeRuleBridge = (variables: ReturnType<typeof createVariableStore>) =>
  makeRuleBridgeCore({
    env: () => ({ variables } as never),
    baseUrl: 'https://t.test',
  });

/** 池销毁（测试收尾，避免 worker 泄漏） */
function destroyPool(pool: unknown): Promise<void> {
  return (pool as { destroy?: () => Promise<void> }).destroy?.() ?? Promise.resolve();
}

const NUXT = JSON.stringify({
  layout: 'default',
  data: [{ id: '3963', topicInfo: { title: '执子之剑' }, comicList: [{ id: 174225, title: '序章 结契之路' }, { id: 174226, title: '第 1 话' }] }],
});

test('类V：java.getElements 对 JSONPath 取出的**对象数组**必须返回数组（不得塌成空列表）', () => {
  const { jsEval, ar } = makeL1();
  ar.setContent('<html><body>page</body></html>');
  const out = jsEval(
    `java.setContent(${JSON.stringify(NUXT)}); ` +
      'var els = java.getElements("$.data[*].comicList[*]"); ' +
      'JSON.stringify({isArr: Array.isArray(els), n: els.length, first: els[0] && els[0].title, ' +
      'size: els.size ? els.size() : -1})',
    { $: '' },
  );
  const r = JSON.parse(String(out)) as { isArr: boolean; n: number; first: string; size: number };
  assert.equal(r.isArr, true, '必须是数组（旧实现被 bridgeDom 换成空列表 → isArr=false）');
  assert.equal(r.n, 2, '必须有 2 条（旧实现 length 为 undefined）');
  assert.equal(r.first, '序章 结契之路', '元素内容必须保留（旧实现 [0] 为 undefined）');
  assert.equal(r.size, 2, 'jsoup Elements 的 size() 必须与真实条数一致');
});

test('类V：java.getElement / java.getStringList 同样不得把 JSON 对象数组清空', () => {
  const { jsEval, ar } = makeL1();
  ar.setContent(NUXT);
  const out = jsEval(
    'var se = java.getElement("$.data[*].comicList[*]"); ' +
      'var sl = java.getStringList("$.data[*].comicList[*].title"); ' +
      'JSON.stringify({seIsArr: Array.isArray(se), seN: se.length, slN: sl.length, sl0: sl[0]})',
    { $: '' },
  );
  const r = JSON.parse(String(out)) as { seIsArr: boolean; seN: number; slN: number; sl0: string };
  assert.equal(r.seIsArr, true, 'getElement 也必须返回数组（旧实现 filter(isNode) 把 JSON 对象全滤掉）');
  assert.equal(r.seN, 2);
  assert.equal(r.slN, 2, 'getStringList 同样不能被清空');
  assert.equal(r.sl0, '序章 结契之路');
});

test('类V：`java.getElements` 与 TS 侧直接求值必须一致（防再次单路径回归）', () => {
  const { jsEval, ar } = makeL1();
  ar.setContent(NUXT);
  const viaJava = jsEval('JSON.stringify(java.getElements("$.data[*].comicList[*]"))', { $: '' });
  const direct = JSON.stringify(ar.syncGetElements('$.data[*].comicList[*]'));
  assert.equal(String(viaJava), direct, 'java 桥与直接求值必须给出同一结果（此前 java 桥多了一层把数组清空）');
});

/**
 * `#313`（2026-10-07 立项 → 同日交付）：`java.getElement` 必须实现上游的**两种**返回形态。
 *
 * 上游事实（逐行核实）：`AnalyzeRule.kt:895` `bindings["java"] = this` ⇒ 源脚本里的 `java`
 * 就是 `AnalyzeRule` 本体，`java.getElement(rule)` == `AnalyzeRule.getElement(rule)`（`:384-414`）：
 *   · `Mode.Json`  → **`getObject`**（`ctx.read` 原文；对象 / 标量 / 数组**都算命中**）⇒ 返回**原值**
 *   · `Mode.Css` / `Mode.XPath` → **`getElements`** ⇒ 返回**整个列表**（不是第 0 个！）
 * 本仓旧实现「一律取 `getElements(...)[0]`」⇒ **错两处**。
 *
 * ⚠️ **旧锁已反转**（先例 `#108`：类W 的「必须留 L1」在 RPC 化后改成「必须真进 worker」）。
 *    旧锁断言的是「对象目标返回空 + 桥与 `syncGetElements` 逐字一致」——那是「两侧一致地错」；
 *    本条现在断言**正确语义**，并**另外**钉住 L1 / worker 不分岔。
 *
 * 交付形态：`getElementTyped()` 返回 `{list, value}` 显式标记；桥的 op 从 `'elements'|'strings'`
 * 扩到 `+'object'`，回传 `{kind:'nodes'|'value'}` —— **不能只靠返回值形状判**：
 * 「Css 的元素列表」与「Json 的数组」在 JSON 里长得一模一样。
 *
 * ⚠️ 本仓 `RuleMode` 里 CSS 写作 **`'Default'`（没有 `'Css'` 成员）**，别照上游 `Mode.Css` 猜。
 *
 * 语料面（179 源扫描）：真 `java.getElement(` 共 14 处 / 12 源 —— 13 处 Json 目标**全是数组**、
 * 1 处 Css。⇒ 旧语义在现语料零可观测差异；本锁的价值是把**两种形态都钉住**，防退回 `[0]`。
 */
test('#313：`java.getElement` 是「两形态」—— Json 目标给原值、Css 目标给整个列表', () => {
  const { jsEval, ar } = makeL1();
  ar.setContent(JSON.stringify({ data: { bookInfo: { name: '书名A' } }, list: [{ t: 'a' }] }));
  // ⚠️ 判据必须用 `size()`：`bridgeDom` 对空数组返回的是 `bridgeList([])`，
  //    它的 `length` 是 **undefined**（不是 0）—— 拿 `.length` 断言会得到 NaN 的假失败。
  const probe = (rule: string) => JSON.parse(String(jsEval(
    `var g = java.getElement(${JSON.stringify(rule)}); ` +
      'JSON.stringify({size: g && g.size ? g.size() : -2, ' +
      'isArr: Array.isArray(g), ' +
      'name: g && g.get ? (g.get("bookInfo") || {}).name : null, ' +
      'first: g && g[0] ? g[0].t : null})',
    { $: '' },
  ))) as { size: number; isArr: boolean; name: string | null; first: string | null };
  // 形态一：**非数组**的 JSON 目标 —— 必须返回**该对象本身**（旧实现返回空列表 ⇒ size 为 0）
  const obj = probe('$.data');
  assert.equal(obj.isArr, false, 'Json 目标不得被包成数组（上游 getObject 给原值）');
  assert.equal(obj.size, 1, '必须拿到对象本身（键数 1）；旧实现在这里是 0');
  assert.equal(obj.name, '书名A', '对象内容必须可读（Map API 的 get 也必须在）');
  // 形态二：**数组**的 JSON 目标 —— 保留内容与 `.size()`（13/14 处真实用法落在这一形态）
  const arr = probe('$.list');
  assert.equal(arr.isArr, true, '数组目标仍是真数组');
  assert.equal(arr.size, 1, '数组目标必须正常');
  assert.equal(arr.first, 'a', '数组元素内容必须保留');
});

test('#313：`java.getElement` 对 Css 目标返回**整个列表**（旧实现只给第 0 个）', () => {
  const { jsEval, ar } = makeL1();
  ar.setContent('<html><body><div class="c">甲</div><div class="c">乙</div></body></html>');
  const out = JSON.parse(String(jsEval(
    'var g = java.getElement("div.c"); ' +
      'JSON.stringify({isArr: Array.isArray(g), ' +
      'size: g && g.size ? g.size() : -2, ' +
      'first: g && g[0] ? String(g[0].text()) : null, ' +
      'all: g && g.size ? [String(g[0].text()), String(g[1].text())] : []})',
    { $: '' },
  ))) as { isArr: boolean; size: number; first: string | null; all: string[] };
  assert.equal(out.isArr, true, 'Css 目标必须是可迭代列表（上游 Mode.Css → getElements 整个列表）');
  assert.equal(out.size, 2, '必须给全部 2 个（旧实现取 [0] 只剩 1 个）');
  assert.equal(out.first, '甲', '第 0 个内容');
  assert.deepEqual(out.all, ['甲', '乙'], '第 1 个也必须在（证明确实是「整个列表」而非首元素）');
  // 与 TS 侧 `getElements` **条数**一致（形态可能不同：一个给数组、一个给 Elements 桥）
  assert.equal(
    (ar.syncGetElements('div.c') as unknown[]).length,
    2,
    '`java.getElement`(Css) 与 `getElements` 必须同条数',
  );
});

/**
 * `#313` 的对偶面：**L1 与 worker 必须同形**。
 *
 * 旧锁的反面教训（`#313` 立项原因）：桥的同步侧与 worker 侧**都**用 `getList` 语义，
 * 于是「一致地错」—— 测试全绿也说明不了对错。加 `op:'object'` 之后两侧都要实现上游的
 * 两种形态；本条把「对象目标」这一形态在 **worker 路径**上钉住（L1 侧见上一条）。
 */
test('#313：worker 路径下 Json 对象目标同样拿到原值（与 L1 同形，不得分岔）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    ruleBridge: makeRuleBridge(variables),
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  try {
    const doc = JSON.stringify({ data: { bookInfo: { name: '书名A' } }, list: [{ t: 'a' }] });
    const code =
      `java.setContent(${JSON.stringify(doc)}); ` +
      'var o = java.getElement("$.data"); var l = java.getElement("$.list"); ' +
      'JSON.stringify({oIsArr: Array.isArray(o), oSize: o && o.size ? o.size() : -2, ' +
      'oName: o && o.get ? o.get("bookInfo").name : null, ' +
      'lIsArr: Array.isArray(l), lSize: l && l.size ? l.size() : -2})';
    const out = JSON.parse(String(await Promise.resolve(ev(code, { $: '' })))) as {
      oIsArr: boolean; oSize: number; oName: string | null; lIsArr: boolean; lSize: number;
    };
    assert.ok(st.evals > 0, '必须真的走 worker（若为 0 说明回落 L1，本条就空转了）');
    assert.equal(out.oIsArr, false, 'worker 侧对象目标不得被包成数组');
    assert.equal(out.oSize, 1, 'worker 侧必须拿到对象本身（键数 1）');
    assert.equal(out.oName, '书名A', 'worker 侧对象内容必须可读');
    assert.equal(out.lIsArr, true, 'worker 侧数组目标仍是真数组');
    assert.equal(out.lSize, 1, 'worker 侧数组目标条数正确');
  } finally {
    await destroyPool(pool);
  }
});

/**
 * `#108`（2026-09-25）：四个规则桥方法**已 RPC 化** —— 不再把这类脚本推回 L1。
 *
 * 旧锁（类W）断言的是「必须留 L1」，那是当时的兜底；代价是语料里 18 个**同时用 `java.ajax`**
 * 的源也跟着回 L1，而 L1 的同步 HTTP（execFileSync）会阻塞进程事件循环。
 * 现在断言反过来：**必须真的进 worker，且结果与 L1 一致**。
 */
test('#108：java.setContent/getElements 在 worker 路径下经 RPC 生效（不再静默空）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    ruleBridge: makeRuleBridge(variables),
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  try {
    // setContent 之后**不带 mContent** 的 getElements 必须能读到刚设的内容（#108 的核心语义）
    const code =
      `java.setContent(${JSON.stringify(NUXT)}); ` +
      'String(java.getElements("$.data[*].comicList[*]").size())';
    const out = await Promise.resolve(ev(code, { $: '' }));
    assert.equal(String(out), '2', `规则桥必须经 RPC 生效，实际：${String(out)}`);
    assert.ok(st.evals > 0, '必须真的走 worker（兜底正则已撤；若为 0 说明仍在 L1）');
  } finally {
    await destroyPool(pool);
  }
});

/**
 * `#406`（2026-10-12）**worker 返回值的形状面** —— `#108` 那条锁只验了「worker 内部 `.size()` 正确」，
 * 漏掉了**结果跨回宿主之后**的形状（这才是引擎实际消费的那一步）。
 *
 * 缺陷：`op='elements'` 一律走 `describeRuleNode` ⇒ JSON 列表被包成
 * `{outerHTML: JSON.stringify(x), …}`，且描述符元素带**可枚举函数**（worker `mkList` 挂的
 * `html/text/attr/select…`）⇒ `structuredClone` 失败 ⇒ `__yueduSendable` 退化为 `String(v)`
 * （元素 `toString` = outerHTML，逗号 join）⇒ 宿主 `getElements` **只拿到 1 个字符串**。
 *
 * 用户可见症状（🎨快看漫画，真实源）：详情解析出 176 章、目录恒 **0 章**
 * （同一份源 **L1 = 176 章 / worker = 0 章**，用 legado 引擎 + 真 worker 池实测对照）。
 * 修法：桥判定「元素全非 DOM 节点」⇒ 回 `{kind:'values'}`，worker 侧原样给回 JSON 数组
 * （方法用 `__yueduAttachJsonMap` 挂，非枚举 ⇒ 可克隆）。
 */
test('#406：worker 返回的 JSON 列表必须保住条数与字段（旧实现整表塌成 1 个字符串）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const javaExtra: Record<string, unknown> = {};
  const ev = createHybridJsEvaluator({
    variables,
    javaExtra,
    pool,
    ruleBridge: makeRuleBridge(variables),
  });
  try {
    /**
     * ⚠️ 断言必须落在**返回给宿主的那个值**上（`ev(code)` 的返回值）——
     * 只看 worker **内部**（如 `els.length` / `.size()`）会漏掉本条缺陷：
     * 旧实现在 worker 内部一直是对的，坏的是**跨 postMessage 回来**那一步。
     */
    const code =
      `java.setContent(${JSON.stringify(NUXT)}); ` +
      'var els = java.getElements("$.data[*].comicList[*]"); els;';
    const ret = (await Promise.resolve(ev(code, { $: '' }))) as unknown;
    assert.ok(st.evals > 0, '必须真的走 worker（若为 0 说明回落 L1，本条就空转了）');
    assert.ok(Array.isArray(ret), `跨回宿主后必须仍是数组（旧实现退化成 String(v) = 一个逗号拼接的长串）`);
    const arr = ret as Array<{ title?: string }>;
    assert.equal(arr.length, 2, `条数必须保住（旧实现整表塌成 1 个字符串）`);
    assert.equal(arr[0]?.title, '序章 结契之路', '字段必须可读（旧实现塞在 outerHTML 的 JSON 串里，取不到）');

    // 对偶：同一条脚本走 L1 必须**同形**（上游 `bindings["java"] = this` 的语义是两侧逐字等价）
    const l1 = makeL1();
    const l1Ret = l1.jsEval(code, { $: '' }) as Array<{ title?: string }>;
    assert.deepEqual(
      l1Ret.map((x) => x?.title),
      arr.map((x) => x?.title),
      'L1 与 worker 必须给出同一份结果',
    );
  } finally {
    await destroyPool(pool);
  }
});

test('#108：java.getStringList 经 RPC 返回字符串数组（与 L1 结果一致）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    ruleBridge: makeRuleBridge(variables),
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  try {
    const code =
      `java.setContent(${JSON.stringify(NUXT)}); ` +
      'JSON.stringify(java.getStringList("$.data[*].comicList[*].title"))';
    const out = await Promise.resolve(ev(code, { $: '' }));
    assert.deepEqual(JSON.parse(String(out)), ['序章 结契之路', '第 1 话']);
    assert.ok(st.evals > 0, '必须走 worker');
  } finally {
    await destroyPool(pool);
  }
});

test('#108：java.getElement 在 worker 里也返回**可迭代的列表**（Legado 语义，不是单个）', async () => {
  const { pool } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    ruleBridge: makeRuleBridge(variables),
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  try {
    const code =
      `java.setContent(${JSON.stringify(NUXT)}); ` +
      'var se = java.getElement("$.data[*].comicList[*]"); ' +
      'JSON.stringify({isArr: Array.isArray(se), n: se.length, size: se.size()})';
    const out = await Promise.resolve(ev(code, { $: '' }));
    const r = JSON.parse(String(out)) as { isArr: boolean; n: number; size: number };
    assert.equal(r.isArr, true, 'getElement 返回的必须是数组（脚本 Array.from(...) 依赖）');
    assert.equal(r.n, 2);
    assert.equal(r.size, 2);
  } finally {
    await destroyPool(pool);
  }
});

test('类W：不含规则桥调用的脚本仍走 worker（兜底判定不得把 worker 全关掉）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  try {
    const out = await Promise.resolve(ev('java.ajax("https://h.test/a"); "ok"', {}));
    assert.equal(String(out), 'ok');
    assert.ok(st.evals > 0, '纯 java.ajax 脚本必须仍走 worker（否则是过度回退，会重新引入事件循环阻塞）');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});

test('#109：`java.getString(rule, mContent)` 的第二参必须生效（此前被 base 的单参数签名丢掉）', () => {
  const { jsEval } = makeL1();
  const out = jsEval(
    'String(java.getString("$.a", JSON.stringify({a: "FROM-MCONTENT"})))',
    { $: '' },
  );
  assert.equal(String(out), 'FROM-MCONTENT', '第二参给了就必须拿它当文档求值（Legado 语义）');
});

test('#109：`java.getString(rule)`（无第二参）仍走宿主 evalRule —— 保持历史路径不变', () => {
  const variables = createVariableStore();
  const javaExtra: Record<string, unknown> = {};
  const seen: Array<[string, unknown]> = [];
  const jsEval = createJsEvaluator({
    variables,
    javaExtra,
    evalRule: (r, v) => {
      seen.push([r, v]);
      return 'EVALRULE';
    },
  });
  new AnalyzeRule({ variables, javaExtra, jsEvalSync: jsEval, jsEval } as never);
  assert.equal(String(jsEval('String(java.getString("$.x"))', { $: 'DOC' })), 'EVALRULE');
  assert.equal(seen.length, 1, '无第二参时必须走 evalRule（而不是规则桥）');
  assert.equal(seen[0]?.[0], '$.x');
  // contextValue 由求值器内部提供（= 当前 `$` 绑定），不是可注入项
  assert.equal(seen[0]?.[1], 'DOC');
});

/**
 * `#380`（2026-10-10）：worker 规则桥缺「预置内容」——整类缺陷。
 *
 * 上游语义：`bindings["java"] = this`（AnalyzeRule.kt:895）⇒ 脚本里
 * `java.getElements(rule)`（不带 mContent）读**实例当前 content**
 * （引擎跑 `@js:` 正文/目录规则前已 `setContent` 章节页）。
 * 本仓 worker 侧 `ruleState.content` 只有脚本显式 `java.setContent` 才有值，
 * 不调 setContent 的脚本在**空内容**上求值 ⇒ 恒空。
 * 实测：书院发现页「🎨包子漫画（优）」（bzmgcn/baozimhcn 同一份规则）
 * `java.getElements('class.comic-contain@amp-img')` + `x.attr('data-src')` ⇒ 正文 0 段
 * （HTTP 200、title 正常、对照纯 CSS 的 bzmanga 源 17 段正常）。
 * 修法：`AnalyzeRule.bindings()` 把字符串型 content 挂 `__yueduRuleContent` 随绑定下发，
 * worker `handle()` 弹出预置进 `ruleState.content`（单实现，L1 无此问题）。
 */
test('#380：worker 路径下 java.getElements（不先 setContent）读实例预置内容', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const javaExtra: Record<string, unknown> = {};
  const ev = createHybridJsEvaluator({
    variables,
    javaExtra,
    pool,
    ruleBridge: makeRuleBridge(variables),
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  const env = { variables, javaExtra, jsEval: ev, jsEvalSync: ev, sourceFields: { name: 't' } };
  const ar = new AnalyzeRule(env as never);
  try {
    ar.setContent(
      '<ul class="comic-contain">' +
        '<amp-img data-src="https://cdn/1.jpg"></amp-img>' +
        '<amp-img data-src="https://cdn/2.jpg"></amp-img>' +
        '</ul>',
    );
    // 包子漫画系正文的同构脚本：不调 setContent，直接 getElements + attr
    const out = await ar.getString(
      '@js: let n = java.getElements("class.comic-contain@amp-img"); ' +
        'let c = []; Array.from(n).forEach(function(x){ c.push(x.attr("data-src")); }); c.join("|")',
    );
    assert.equal(
      String(out),
      'https://cdn/1.jpg|https://cdn/2.jpg',
      `预置内容必须生效（旧实现在空内容上求值 ⇒ 恒空），实际：${String(out)}`,
    );
    assert.ok(st.evals > 0, '必须真的走 worker（若为 0 说明仍在 L1，测不到预置通路）');
  } finally {
    await destroyPool(pool);
  }
});
