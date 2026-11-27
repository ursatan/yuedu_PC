/**
 * 回归锁：**`getElement` 与 `getElements` 是两条不同的上游路径**（`#309` 修复时打断的调用点）。
 *
 * ## 依据（上游逐行核实，不猜测）
 * `AnalyzeRule.kt:384-414`（`getElement`）与 `:450-499`（`getElements`）在 `Mode.Json` 分支分岔：
 * ```kotlin
 * // getElement
 * Mode.Json -> getAnalyzeByJSonPath(result).getObject(rule)   // ctx.read(rule)  原文，对象也算命中
 * // getElements
 * Mode.Json -> getAnalyzeByJSonPath(result).getList(rule)     // ctx.read<List<Any>>  非数组抛异常 → 空
 * ```
 * `AnalyzeByJSonPath.kt:128-130`（`getObject` = `ctx.read`）vs `:132-137`（`getList` 的 `List` 强转）。
 *
 * ## 缺陷与症状
 * `ruleBookInfo.init` 的上游入口是 **`getElement`**（`BookInfo.kt:58-62`：
 * `setContent(analyzeRule.getElement(it))`）。本仓此前写成 `getElements(initRule)[0]`，
 * 早先靠 `jsonGetList` 的「非数组包成 1 条」蒙对；`jsonGetList` 按上游收紧为「只认数组」后暴露：
 * **`init` 取对象的源 init 恒空** ⇒ `name/author/tocUrl` 退化成对原始响应求值 ⇒ 详情空、目录 0 章（静默）。
 * 语料影响面：🥝猕猴桃漫画（`$.data`）、松鹤庭沐·言璃版（`$.data.bookInfo`），见 `tmp/scan-init.txt`。
 *
 * ## 防空转（两条对偶，方向相反、不落同一处）
 * 只断言「`getElement('$.data')` 拿到对象」不够 —— 把 `getElement` 改成「什么都原样返回」也能过。
 * 所以同时钉住：
 *  ① `getElements('$.data')` 必须仍是 **0 条**（证明收紧后的 `getList` 语义没被这次修复放宽）；
 *  ② 非 JSON 模式（`<js>` 返回对象）两条入口**行为一致**（证明我没有只修一条路）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalyzeRule } from '../selector/analyze';
import { createVariableStore } from '../store';
import { jsonGetObject, jsonGetList, jsonGetString } from '../selector/jsonpath';

const env = { variables: createVariableStore() } as never;

/** 详情页原始响应：`$.data` 是**对象**（模拟「加密负载，init 解密后 setContent」的常见形态） */
const DETAIL_BODY = JSON.stringify({
  status: 1,
  data: {
    comic_name: '解密后书名',
    comic_author: '解密后作者',
    chapters: [{ chapter_name: '第一话' }, { chapter_name: '第二话' }],
  },
});

function makeEnv() {
  const jsEval = (code: string, bindings: Record<string, unknown>): unknown => {
    // <js> 段按 Legado 语义：脚本最后一行表达式 / `result` 即返回值
    if (/^result$/.test(code.trim())) return bindings['result'];
    if (code.includes('return obj')) return { book_info: { id: 10663 } };
    return '';
  };
  return { baseUrl: 'https://detail.test/', variables: createVariableStore(), jsEval, jsEvalSync: jsEval, toAbsolute: (u: string) => u } as never;
}
const mk = () => new AnalyzeRule(makeEnv()).setContent(DETAIL_BODY, 'https://detail.test/');

// ---------------------------------------------------------------- 单元层

test('jsonGetObject：目标是非数组时**照常命中**（上游 `getObject` = ctx.read 原文）', () => {
  const obj = jsonGetObject('$.data', DETAIL_BODY) as Record<string, unknown>;
  assert.equal(typeof obj, 'object', '必须拿到对象');
  assert.equal(obj['comic_name'], '解密后书名');

  // 标量同样命中
  assert.equal(jsonGetObject('$.data.comic_author', DETAIL_BODY), '解密后作者');
});

test('jsonGetObject 与 jsonGetList 的差异必须**只体现在「非数组」上**', () => {
  // 数组目标：两条都命中（getList 返回全部，getObject 返回原始数组）
  assert.equal(jsonGetList('$.data.chapters[*]', DETAIL_BODY, env).length, 2);
  assert.equal((jsonGetObject('$.data.chapters[*]', DETAIL_BODY) as unknown[]).length, 2);
  // 对象目标：一条命中、一条不命中 —— 这就是分岔点
  assert.equal(typeof jsonGetObject('$.data', DETAIL_BODY), 'object');
  assert.equal(jsonGetList('$.data', DETAIL_BODY, env).length, 0, 'getList 对对象必须仍是 0 条（别被这次修复放宽）');
});

test('jsonGetObject：`{$.x}` 内嵌展开 + 读不到时不抛错', () => {
  assert.equal(jsonGetString('$.data.comic_name', DETAIL_BODY, env), '解密后书名');
  assert.equal(jsonGetObject('$.nope.deep', DETAIL_BODY), undefined, '读不到 → undefined，不抛');
});

// ---------------------------------------------------------------- AnalyzeRule 入口层

test('getElement：`$.data` 取**对象**必须命中（init 的真实入口）', async () => {
  const got = await mk().getElement('$.data');
  assert.notEqual(got, undefined, '对象必须命中；undefined ⇒ init 恒空 ⇒ 详情空 + 目录 0 章');
  assert.equal(typeof got, 'object');
  assert.equal((got as Record<string, unknown>)['comic_name'], '解密后书名');
});

test('getElement【对偶①】：同一规则走 `getElements` 必须仍是 0 条', async () => {
  const els = await mk().getElements('$.data');
  assert.equal(els.length, 0, 'getElements 对对象必须仍是 0 条 —— 否则说明我把 getList 又放宽了');
});

test('getElement + init：改写后的内容才算「详情阶段的内容」（端到端串一遍）', async () => {
  const ar = mk();
  const initVal = await ar.getElement('$.data');
  assert.notEqual(initVal, undefined);
  // engine.ts 的下一步：setContent(initVal) 后按 info.name 求值
  const ar2 = new AnalyzeRule(makeEnv()).setContent(initVal, 'https://detail.test/');
  assert.equal(await ar2.getString('$.comic_name'), '解密后书名', 'name 规则应对 init 改写后的内容求值');
  // 防空转：不 setContent 时，同一规则对**原始响应**求值必然取不到（证明上一步真的换了内容）
  assert.equal(await mk().getString('$.comic_name'), '', '原始响应里没有 comic_name 这个顶层键');
});

test('getElement【对偶②】：非 JSON 模式（`<js>` 返回对象）与 getElements[0] 行为一致', async () => {
  const viaElement = await mk().getElement('<js>return obj</js>');
  const viaList = await mk().getElements('<js>return obj</js>');
  assert.notEqual(viaElement, undefined);
  assert.deepEqual(viaElement, viaList[0], '两条入口在 JS 模式必须一致（我没只修一条路）');
});
