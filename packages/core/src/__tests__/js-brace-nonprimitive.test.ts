/**
 * `#387b` 回归锁：`@js:` / `<js>` 段内的 `{{expr}}` 插值**不得**把非原始值拼进 JS 源码。
 *
 * ## 用户报障原文（RSS 订阅源 `˃̶͈ ꇴ ˂̶͈`）
 * ```
 * Invalid or unexpected token｜出现在 yuedu-rule.js:1
 * | let uri=getUrl();💔访问出错💔;; | ^
 * | 片段=let uri=getUrl();💔访问出错💔;; ()=>{ var url=`http://${this.getUrl()}.uaa.cn.mt/miyao.html`;
 *        java.startBrowser(url,'密钥') }; let start=start(); let ml=getKey(); …
 * ```
 *
 * ## 真因
 * 该源 `ruleArticles`（**整段 `@js:`**）：
 * ```
 * let uri=getUrl();{{TD()}};{{setzt()}};
 * {{eval(String(source.loginUrl))}};
 * let start=start(); … let list = [ … ]; list
 * ```
 * 三处 `{{}}` 的**完成值**分别是：`TD()` → 字符串（无害）、`setzt()` → `''`、
 * `eval(String(source.loginUrl))` → **箭头函数**（`loginUrl` 的最后一条语句是 `my=()=>{…}` 赋值）。
 * 而拼值走的是 `String(v)` ⇒ 函数源码 `()=>{…}` 被拼进语句位 ⇒ **语法错**，整条规则连脚本都跑不到。
 *
 * 作者本意是「跑副作用」（同一作者家族的 📂alicesw 在 `@js:` 里就是**裸写** `eval(String(source.loginUrl));`，
 * 只有 URL 模板里才套 `{{…;GetUL();}}` 并以**调用收尾**拿文本值）。
 *
 * ## 判据（对齐 Legado `makeUpRule` 的 `null -> Unit`）
 * 函数 `String()` 出来是函数源码、对象是 `[object Object]` —— **都不可能是一段合法 JS**
 * ⇒ JS 源码位一律**不拼**（`PlaceholderOpts.nonPrimitive='drop'`）。
 * ⚠️ 这是**严格改进**：这两类值在 JS 源码位当前也 100% 是语法错 ⇒ drop 只可能把「死」变「活」。
 * ⚠️ 语料面：`@js:`/`<js>` 段内含 `{{}}` 的规则 **183 处 / 109 源** —— 是类别，不是单源。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzeRule } from '../selector/analyze';
import { fixRhinoLetSelfRef } from '../selector/js';
import { resolveUrl } from '../net';
import { createVariableStore } from '../store';

test('#398b fixRhinoLetSelfRef：仅 jsLib 全局名的 let/const 自引用改写为「作用域优先」查找', () => {
  const g = new Set(['start', 'getKey']);
  /**
   * `#611` step3 起改写目标不是裸 globalThis：chain 模式下 jsLib 声明已迁到独立作用域
   * （`__yueduScope` 求值层 / `__yueduLibScope` lib 工厂体），裸 globalThis 会拿不到
   * ⇒ 统一「作用域优先、回落 globalThis」的四路径同判据查找（见 fixRhinoLetSelfRef 注释）。
   */
  const lookup = '(typeof __yueduScope!=="undefined"&&__yueduScope?__yueduScope:globalThis)';
  assert.equal(
    fixRhinoLetSelfRef('let uri=getUrl();let start=start();\nlet ml=getKey();', g),
    `let uri=getUrl();let start=${lookup}["start"]();\nlet ml=getKey();`,
    '自引用名是 jsLib 全局函数 ⇒ RHS 换作用域优先查找（Rhino 无 let-TDZ 的等价语义）',
  );
  assert.equal(
    fixRhinoLetSelfRef('const start=start(1);', g),
    `const start=${lookup}["start"](1);`,
    'const 同款',
  );
  assert.equal(
    fixRhinoLetSelfRef('let start=start();', new Set()),
    'let start=start();',
    '全局名单为空 ⇒ 原样（真正的 TDZ bug 不替源圆）',
  );
  assert.equal(
    fixRhinoLetSelfRef('let foo=foo();', g),
    'let foo=foo();',
    '非 jsLib 全局名 ⇒ 原样',
  );
  // `#611` step3：lib 自身变体（查找走 __yueduLibScope）
  const libLookup = '(typeof __yueduLibScope!=="undefined"&&__yueduLibScope?__yueduLibScope:globalThis)';
  assert.equal(
    fixRhinoLetSelfRef('let start=start();', g, libLookup),
    `let start=${libLookup}["start"]();`,
    '第三参可换查找表达式（jsLib 自身用 __yueduLibScope）',
  );
  assert.equal(
    fixRhinoLetSelfRef('let x = start(1), y=2;', g),
    'let x = start(1), y=2;',
    '普通声明（等号右边不是同名词）不受影响 —— 那在 V8 本来就能解析到全局',
  );
});

/**
 * 桩求值器：**记录**每次收到的代码，并按表达式返回指定类型（模拟真实完成值）。
 * - `fn()` → 箭头函数（复刻 `eval(String(source.loginUrl))`）
 * - `obj()` → 普通对象
 * - `n` → 数字 7（对偶：原始值必须照常拼入，不能被一起丢掉）
 */
function makeEnv(seen: string[]) {
  const evalFn = (code: string): unknown => {
    seen.push(code);
    if (/^\s*fn\(\)\s*$/.test(code)) return () => 1;
    if (/^\s*obj\(\)\s*$/.test(code)) return { a: 1 };
    if (/^\s*n\s*$/.test(code)) return 7;
    return `OUT:${code}`; // 脚本本体：回一个可识别的标记值
  };
  return {
    baseUrl: 'https://api.test/',
    variables: createVariableStore(),
    jsEval: async (code: string) => evalFn(code),
    jsEvalSync: (code: string) => evalFn(code),
    toAbsolute: (u: string) => resolveUrl('https://api.test/', u),
  } as never;
}

test('#387b：@js: 段内 {{}} 求值为函数/对象时不得拼进脚本（旧实现 ⇒ Invalid or unexpected token）', async () => {
  const seen: string[] = [];
  // 复刻真源形态：副作用式插值（值本身没用）+ 脚本尾部返回列表
  const rule = '@js:\nstart();{{fn()}};{{obj()}};\nlet list=[1,2];\nlist';
  const out = await new AnalyzeRule(makeEnv(seen))
    .setContent('<html></html>', 'https://api.test/')
    .getString(rule);

  const script = seen.find((c) => c.includes('let list'));
  assert.ok(script, `脚本必须被执行；实际 jsEval 收到 ${JSON.stringify(seen)}`);
  assert.ok(
    !script.includes('=>'),
    `函数源码不得被拼进脚本（拼进去就是语法错）：${JSON.stringify(script)}`,
  );
  assert.ok(
    !script.includes('[object Object]'),
    `对象不得被拼成 [object Object]（同样非法）：${JSON.stringify(script)}`,
  );
  // 副作用调用本身仍必须发生（drop 的是**拼接**，不是求值）
  assert.ok(seen.some((c) => /^\s*fn\(\)\s*$/.test(c)), 'fn() 仍必须被求值（只丢弃拼接）');
  assert.ok(seen.some((c) => /^\s*obj\(\)\s*$/.test(c)), 'obj() 仍必须被求值');
  assert.equal(out, 'OUT:' + script, '脚本的返回值必须原样透出（整段规则没被语法错打断）');
});

test('#387b 对偶：原始值（数字/字符串）照常拼入 —— 不能把该拼的一起丢掉', async () => {  const seen: string[] = [];
  const out = await new AnalyzeRule(makeEnv(seen))
    .setContent('<html></html>', 'https://api.test/')
    .getString('@js:\nlet k={{n}};k');
  const script = seen.find((c) => c.includes('let k'));
  assert.ok(script, '脚本必须被执行');
  assert.ok(script.includes('let k=7;'), `数字必须原样拼入：${JSON.stringify(script)}`);
  assert.equal(out, 'OUT:' + script);
});

test('#387b 既有语义不回归：{{$.x}} 这类值仍按原文拼入（走默认 stringify，不受 drop 影响）', async () => {
  // 非 JS 段（CSS/URL 模板）走默认策略 —— 这里用 URL 模板形态验证「drop 不外溢」
  const seen: string[] = [];
  const env = makeEnv(seen) as unknown as Record<string, unknown>;
  env['jsEval'] = async (code: string) => {
    seen.push(code);
    return 'V';
  };
  env['jsEvalSync'] = (code: string) => {
    seen.push(code);
    return 'V';
  };
  const out = await new AnalyzeRule(env as never)
    .setContent('<html></html>', 'https://api.test/')
    .getString('https://x.test/p?q={{vv}}', true);
  assert.ok(out.includes('q=V'), `非 JS 段仍须拼值：${out}`);
});

/**
 * ⚠️ `#398`（2026-10-11）：本用例的判据**已升级** —— 上游逐行核对（`AnalyzeRule.kt:453-497`）：
 * **getElements 的循环根本不调 makeUpRule** ⇒ 列表规则的 Js 段**整段不做 {{}} 替换**，
 * 脚本原样 evalJS —— `{{TD()}}` 由 JS 引擎按嵌套块 `{ {TD()} }` 执行（副作用保留、值丢弃）。
 * 旧的「drop 拼接」还不够：TD() 成功路径返回**原始字符串** `` `turn` ``（˃̶͈ ꇴ ˂̶͈ 实测），
 * 原始值照拼 ⇒ `turn is not defined`，整条列表规则死掉 ⇒ 发现页全空。
 */
test('#398 getElements 路径：JS 段整段不替换 {{}}（上游 getElements 无 makeUpRule）', async () => {
  const seen: string[] = [];
  const out = await new AnalyzeRule(makeEnv(seen))
    // 复刻真源形态：`{{TD()}}`（副作用调用，返回值是字符串也没关系）+ 尾部返回列表
    .setContent('<html></html>', 'https://api.test/')
    .getElements('@js:\nstart();{{TD()}};{{fn()}};\nlet list=[{a:1}];\nlist');
  const script = seen.find((c) => c.includes('let list'));
  assert.ok(script, `脚本必须被执行；实际 jsEval 收到 ${JSON.stringify(seen)}`);
  assert.ok(script.includes('{{TD()}}'), `{{TD()}} 必须原样留在脚本里（运行期按嵌套块执行副作用）：${JSON.stringify(script)}`);
  assert.ok(script.includes('{{fn()}}'), `{{fn()}} 同样原样保留：${JSON.stringify(script)}`);
  assert.ok(!script.includes('turn'), `求值结果不得被拼进脚本（TD() 返回 "turn" 会变成 turn is not defined）：${JSON.stringify(script)}`);
  // 桩对脚本本体回 `OUT:<code>` ⇒ 能原样透出就证明「整段规则跑到了、没被打断」
  assert.deepEqual(out, ['OUT:' + script], '脚本的返回值必须原样透出');
});

test('#398 对偶：getElement（单值）路径上游**有** makeUpRule ⇒ 原始值照常替换、非原始值 drop', async () => {
  const seen: string[] = [];
  await new AnalyzeRule(makeEnv(seen))
    .setContent('<html></html>', 'https://api.test/')
    .getElement('@js:\nstart();{{n}};{{fn()}};\nlet v=1;\nv');
  const script = seen.find((c) => c.includes('let v'));
  assert.ok(script, '脚本必须被执行');
  assert.ok(script.includes('start();7;'), `原始值必须照常拼入（getElement 有 makeUpRule）：${JSON.stringify(script)}`);
  assert.ok(!script.includes('=>'), `函数源码不得拼入（#387b drop）：${JSON.stringify(script)}`);
});

test('#398 对偶：getString 路径行为不变（原始值拼入、非原始值 drop）', async () => {
  const seen: string[] = [];
  const out = await new AnalyzeRule(makeEnv(seen))
    .setContent('<html></html>', 'https://api.test/')
    .getString('@js:\nlet k={{n}};k');
  const script = seen.find((c) => c.includes('let k'));
  assert.ok(script, '脚本必须被执行');
  assert.ok(script.includes('let k=7;'), `数字必须原样拼入：${JSON.stringify(script)}`);
  assert.equal(out, 'OUT:' + script);
});
