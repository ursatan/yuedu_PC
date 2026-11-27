/**
 * `#257` `@js:` 替换求值 + **Java/Android 组引用语义** —— 回归锁。
 *
 * 每条都对着一个「照抄上游时最容易错、且错了还不报错」的点：
 *   ① `$0` = 整个匹配（**JS 的 `String.replace` 不认它**，会原样吐 `$0` —— 用户库里真有一条这样的启用规则）；
 *   ② `@js:` 结果里的 `$N` **要再展开一次**（用户规则 `'一个目录'` 就是 `"第".concat("$1","章 ")`）；
 *   ③ **完成值**语义（`if (c) "x"` 这种末句是表达式语句，`new Function` 的 body 拿不到）；
 *   ④ **宽松模式**（规则里满是 `zk = {...}` 这种不声明就赋值）；
 *   ⑤ **per-match 全新作用域**（上游 `ScriptBindings()` 建在循环体内）且**不污染 `globalThis`**；
 *   ⑥ **`java` 实例「每条规则一次」** ⇒ 同一规则的多个匹配能共享 `java.put/get`；
 *   ⑦ 返回 `undefined`/`null` ⇒ 插入字面量 `"null"`（上游 `unwrapReturnValue` + Kotlin `Any?.toString()`）；
 *   ⑧ 出错 ⇒ 该规则**本次不生效**、正文保持原样、且**必须留痕**；
 *   ⑨ 分组**未参与匹配** ⇒ 插 `null`（Android 行为，不是空串）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createJsEvaluator,
  expandJavaReplacement,
  isJsReplacement,
  jsScriptOf,
  parseReplaceCallbackArgs,
} from '../src/utils/js-replace';
import { applyReplaceRules } from '../src/utils/replace-rules';
import type { ReplaceRule } from '@yuedu/core/contract';

function rule(p: Partial<ReplaceRule> & { id: number }): ReplaceRule {
  return {
    id: p.id,
    name: p.name ?? `r${p.id}`,
    group: p.group ?? null,
    pattern: p.pattern ?? '',
    replacement: p.replacement ?? '',
    scope: p.scope ?? null,
    scopeTitle: p.scopeTitle ?? false,
    scopeSource: p.scopeSource ?? false,
    scopeContent: p.scopeContent ?? true,
    excludeScope: p.excludeScope ?? null,
    isEnabled: p.isEnabled ?? true,
    isRegex: p.isRegex ?? true,
    timeoutMillisecond: p.timeoutMillisecond ?? 3000,
    order: p.order ?? 0,
  };
}

const R = { ruleId: 1, ruleName: 'it' };
const ev = (script: string, match: string, groups: string[] = [match]) =>
  createJsEvaluator(R)(script, { match, groups });

/* -------------------------------------------------------------------------- */
/* 组引用展开（Java `Matcher.appendReplacement`）                               */
/* -------------------------------------------------------------------------- */

test('① `$0` = 整个匹配 —— 而 JS 的 String.replace 做不到（防空转：先证明它本来是坏的）', () => {
  // 防空转：证明「JS 原生替换」确实不认 $0（把匹配到的 `ab` 换成了字面量 `$0`）
  assert.equal('abc'.replace(/(a)(b)/, '$0'), '$0c', 'JS 原生把 $0 当字面量 —— 这正是我们要修的缺陷');

  assert.equal(expandJavaReplacement('$0', ['abc', 'a', 'b']), 'abc');
  assert.equal(expandJavaReplacement('[$0]', ['ab', 'a', 'b']), '[ab]');
});

test('①-b 用户库里那条启用中的规则：`replacement = "$0\\n"` 必须还原成「整个匹配 + 换行」', () => {
  const out = applyReplaceRules('第一段。第二段。', [
    rule({ id: 26, name: '#26 拆分段落', pattern: '[^。]+。', replacement: '$0\n' }),
  ]);
  assert.equal(out.text, '第一段。\n第二段。\n');
  assert.ok(!out.text.includes('$0'), '正文里不得出现字面量 $0');
  assert.deepEqual(out.used, [26]);
});

test('② `$N` 常规展开 + 只有 2 个分组时 `$10` = 第 1 组 + 字面量 `0`', () => {
  assert.equal(expandJavaReplacement('“$2”', ['ab', 'a', 'b']), '“b”');
  assert.equal(expandJavaReplacement('$1$2', ['ab', 'a', 'b']), 'ab');
  // Java 文档：第一个数字必是组号，后续数字「只有能构成合法组号才并入」
  assert.equal(expandJavaReplacement('$10', ['ab', 'a', 'b']), 'a0');
  const many = ['m', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10'];
  assert.equal(expandJavaReplacement('$10', many), 'g10', '够 10 个分组时 $10 就是第 10 组');
});

test('②-b `$` 后面不是数字/`{`、串尾孤立的 `$`、越界组号 ⇒ 全部抛错（Java 也是抛）', () => {
  assert.throws(() => expandJavaReplacement('$$', ['a']), /Illegal group reference/);
  assert.throws(() => expandJavaReplacement('$&', ['a']), /Illegal group reference/);
  assert.throws(() => expandJavaReplacement('a$', ['a']), /group index is missing/);
  assert.throws(() => expandJavaReplacement('$5', ['a', 'b']), /No group 5/);
});

test('②-c `${name}` 命名分组；`\\` 是字面量（上游 quoteReplacementJs 的净效果）', () => {
  assert.equal(expandJavaReplacement('${y}年', ['2026年', '2026'], { y: '2026' }), '2026年');
  assert.throws(() => expandJavaReplacement('${zz}', ['a'], { y: '1' }), /No group with name/);
  assert.equal(expandJavaReplacement('C:\\path\\x', ['m']), 'C:\\path\\x', '反斜杠原样输出');
});

/* -------------------------------------------------------------------------- */
/* JS 求值                                                                     */
/* -------------------------------------------------------------------------- */

test('③ 完成值语义：末句是表达式语句时取它的值（`new Function` 的 body-return 拿不到）', () => {
  assert.equal(ev('if (result.length > 2) "LONG"; else "SHORT"', 'abcd'), 'LONG');
  assert.equal(ev('if (result.length > 2) "LONG"; else "SHORT"', 'ab'), 'SHORT');
  // 真实规则里的写法：分支是「裸表达式」而不是 return
  assert.equal(ev('if (result == "章") "章 "; else result = "第".concat(result, "章 ")', '章'), '章 ');
  assert.equal(ev('R = result; R == "a" ? "A" : "?"', 'a'), 'A');
});

test('④-b ★★ 脚本自己声明的 `function` / `var` 必须**可见且可调用**', () => {
  // 真因（`#257` 实测）：`with` 的对象环境插在**最内层**，而 `function`/`var` 声明进的是
  // **变量环境**（比 `with` 更靠外）⇒ 旧实现（`with (s) { return eval(src) }`）里
  // `has` 恒真的 Proxy 会把脚本**自己声明的每一个名字**都 shadow 成 `undefined`。
  // 真实症状：用户库里**启用中**的 `'#04 星号修复#JS'` 脚本自己写了 `function M(x){…}`，
  // 求值时报 `M is not a function` ⇒ 整条规则被跳过。
  assert.equal(ev('function M(){ return "M-ok" } ; typeof M + ":" + M()', 'x'), 'function:M-ok');
  assert.equal(ev('function f(){ return result } ; f()', 'ab'), 'ab', '函数体内要能读到绑定');
  assert.equal(ev('var v = 7; String(v)', 'x'), '7');
  assert.equal(ev('const c = 8; String(c)', 'x'), '8');
  assert.equal(ev('let l = 9; String(l)', 'x'), '9');
  // ★ 但「声明可见」**不能**靠把 `has` 改成「只认自有属性」来换：
  //   那样「不声明就赋值」会**漏到 globalThis**（上游 ④ 的 per-match 隔离就没了）。
  assert.equal(ev('var v2 = 1; q4b = 2; String(v2) + ":" + typeof q4b', 'x'), '1:number');
  assert.ok(!Object.prototype.hasOwnProperty.call(globalThis, 'q4b'), '隐式赋值仍不得漏到 globalThis');
  // 声明本身也不得跨匹配残留（IIFE 的函数环境每次调用都是新的）
  assert.equal(ev('var w = 1; String(typeof w)', 'x'), 'number');
  assert.equal(ev('String(typeof w)', 'x'), 'undefined', '上一个匹配里声明的 w 不能留到这一个');
});

test('④ 宽松模式：不声明就赋值（`zk = {...}`）不能抛 ReferenceError', () => {
  assert.doesNotThrow(() => ev('zk = { a: "1" }; zk[result]', 'a'));
  assert.equal(ev('zk = { a: "1" }; zk[result]', 'a'), '1');
});

test('⑤ ★ per-match 全新作用域 + 不污染 globalThis', () => {
  // 同一个脚本连续两次求值 ⇒ 第二次看不到第一次的赋值（上游每个匹配一份 ScriptBindings）
  assert.equal(ev('c = (typeof c === "number" ? c : 0) + 1; String(c)', 'x'), '1');
  assert.equal(ev('c = (typeof c === "number" ? c : 0) + 1; String(c)', 'x'), '1');
  assert.ok(!Object.prototype.hasOwnProperty.call(globalThis, 'zkZZProbe'), '不得往 globalThis 上挂东西');
  ev('zkZZProbe = 1; result', 'x');
  assert.ok(!Object.prototype.hasOwnProperty.call(globalThis, 'zkZZProbe'), '求值后也不得残留');
});

test('⑤-b globalThis 上的东西仍可读（Math / JSON / String…）', () => {
  assert.equal(ev('String.fromCharCode(65)', 'x'), 'A');
  assert.equal(ev('JSON.stringify([1,2])', 'x'), '[1,2]');
  assert.equal(ev('Math.max(1,5)', 'x'), '5');
});

test('⑥ ★ `java` 实例「每条规则一次」⇒ 同一规则的多个匹配共享 put/get', () => {
  const evalOne = createJsEvaluator(R); // = 一条规则
  const script = 'java.put("n", String(Number(java.get("n") || 0) + 1)); java.get("n")';
  assert.equal(evalOne(script, { match: 'a', groups: ['a'] }), '1');
  assert.equal(evalOne(script, { match: 'a', groups: ['a'] }), '2', '同一规则的下一个匹配要能读到上次 put');
  const other = createJsEvaluator({ ruleId: 2, ruleName: 'other' });
  assert.equal(other(script, { match: 'a', groups: ['a'] }), '1', '换一条规则 = 新实例 ⇒ 变量不串味');
});

test('⑥-b 未实现的 java 加解密族：**抛带说明的错误**（不做假实现）', () => {
  assert.throws(() => ev('java.md5Encode(result)', 'x'), /java\.md5Encode 在 Web 端未实现/);
  assert.throws(() => ev('java.createSymmetricCrypto("AES/ECB/PKCS5Padding", "k", "iv")', 'x'), /未实现/);
  assert.throws(() => ev('java.t2s(result)', 'x'), /简繁词典/);
  assert.equal(ev('java.log("hi")', 'x'), 'hi', 'log 是真的（返回入参）');
});

test('⑦ 脚本返回 undefined / null ⇒ 插入字面量 `null`（上游 Kotlin Any?.toString()）', () => {
  assert.equal(ev('var a = 1;', 'x'), 'null');
  assert.equal(ev('null', 'x'), 'null');
  assert.equal(ev('', 'x'), 'null');
});

test('⑧ 脚本抛错 ⇒ 求值器抛错（由 applyReplaceRules 吞掉并留痕）', () => {
  assert.throws(() => ev('zzz.qqq(1)', 'x'), /Cannot read|not a function|is not defined/);
  assert.throws(() => ev('throw new Error("boom")', 'x'), /boom/);
});

/* -------------------------------------------------------------------------- */
/* 与真实用户规则对齐                                                            */
/* -------------------------------------------------------------------------- */

test('② ★★ 用户规则「一个目录」的结尾 `"第".concat("$1","章 ")` 必须展开成真分组', () => {
  const script =
    '@js:\nif(result.startsWith("章"))"章 "\nelse if(result.startsWith("第"))""\nelse\nresult="第".concat("$1","章 ")';
  const out = applyReplaceRules('12章 风起', [
    rule({ id: 1, name: '一个目录', pattern: '^(\\d+)章', replacement: script }),
  ]);
  // result=`12章` ⇒ 两个 startsWith 都不中 ⇒ 走 else ⇒ JS 产出 `第$1章 ` ⇒ 再展开 `$1`=`12`
  assert.equal(out.text, '第12章  风起');
  assert.ok(!out.text.includes('$1'), '绝不能把字面量 $1 留在正文里（那是最难发现的静默错误）');
  /**
   * ★★ **防空转（这条最关键）**：`used` 证明「这条规则**真的跑了**」——
   * 若脚本报错被跳过、或 JS 根本没跑起来，`text` 会是**原样**（`12章 风起`），
   * 而一个只看 `text` 的断言在别的输入下可能恰好撞上期望值 ⇒ 就成了假通过。
   */
  assert.deepEqual(out.used, [1], '必须真的执行了这条规则（否则上面那行可能假通过）');

  // 反向对照：同一条规则、`result` 以「章」开头 ⇒ 走另一分支（`"章 "`），用来证明分支真的在跑
  const out2 = applyReplaceRules('章五 起', [
    rule({ id: 1, name: '一个目录', pattern: '^章.', replacement: script }),
  ]);
  assert.equal(out2.text, '章  起');
  assert.deepEqual(out2.used, [1], '分支二也必须证明跑过');
});

test('★ 真实规则「#04 星号修复#JS」的函数声明骨架（旧实现整条报 `M is not a function`）', () => {
  // 这条是**库里启用中**的规则，脚本自带 `function M(x)` / `function N(x,y)`，
  // 并且靠「不声明就赋值」（`R=result`、`z=/…/`）+「三元链当末句、分号省掉」——
  // 一个用例同时钉死 ③ 完成值 / ④ 宽松+per-match / ④-b 声明可见 三件事。
  const src = [
    'R=result;',
    'function M(x) {return R.search(x)==-1?false:true};',
    'function N(x,y) {return R.replace(y?y:z,x)};',
    '//🎈替换ꁘꁘ',
    'if ( M("ꁘ") ) {',
    '\tz=/ꁘ+/;',
    '\tM(/ꁘꁘꁘ/)?R:',
    '\tM(/[四秦山]ꁘꁘ[遍通及]/)?N("川普"):',
    '\tM(/ꁘꁘ/) ? N("他妈") : R',
    '}',
    '//🎈替换pinyin',
    'else if ( M(/[a-zA-Z6]/) ) {',
    '\tz=/[^\\n\\u4e00-\\u9fcc]+/;',
    '\tM(/SB/i)?N("傻逼"):',
    '\tM(/NB/i)?N("牛逼"):',
    '\tR',
    '}',
    '//🎈替换汉字',
    'else {',
    '\tM("孛力")?"勃":',
    '\tM("扌喿")?"操":',
    '\tR',
    '}',
  ].join('\n');
  assert.equal(ev(src, '他ꁘꁘ的'), '他他妈的', 'ꁘ 分支：z=/ꁘ+/ 逐分支重建');
  assert.equal(ev(src, '好像有个SB在这'), '好像有个傻逼在这', 'pinyin 分支');
  assert.equal(ev(src, '孛力'), '勃', '汉字分支：M 收字符串也要能用；返回的是**字面量**（整段匹配被换掉）');
  assert.equal(ev(src, '正常正文'), '正常正文', '三个分支都没命中 ⇒ 原样返回 result');
});

test('★ 真实规则「🌈全角字符转半角」（逐字符 JS，全替换）', () => {
  const out = applyReplaceRules('ＡＢＣ　１２３', [
    rule({
      id: 2,
      name: '🌈全角字符转半角',
      pattern: '[Ａ-Ｚａ-ｚ０-９]',
      replacement: '@js:\nresult=String.fromCharCode(result.charCodeAt()-65248)',
    }),
  ]);
  assert.equal(out.text, 'ABC　123');
  assert.deepEqual(out.used, [2]);
});

test('★ 真实规则「🌈修正html代码」（脚本内建映射表 + 输出里带真换行）', () => {
  const out = applyReplaceRules('甲<BR>乙&amp;丙', [
    rule({
      id: 3,
      name: '🌈修正html代码',
      pattern: '&#8226;|\\<BR\\>|&#13434;|&amp;',
      replacement: "@js:\nzk = {\n'<BR>': '\\n',\n'&#8226;': '•',\n'&#13434;': '㑺',\n'&amp;': '&'\n};\nzk[result]",
      scopeTitle: true,
    }),
  ]);
  assert.equal(out.text, '甲\n乙&丙');
});

test('★ 真实规则「🌈认定为词语的处理」（只替换一次，且删掉 `~`/换行）', () => {
  const out = applyReplaceRules('教~师来了', [
    rule({ id: 4, name: '🌈认定为词语的处理', pattern: '教[~\\n]师', replacement: "@js:\nresult.replace(/\\r?\\n\\s{0,8}|[~]/,'')" }),
  ]);
  assert.equal(out.text, '教师来了');
});

/* -------------------------------------------------------------------------- */
/* 与 applyReplaceRules 的接线                                                  */
/* -------------------------------------------------------------------------- */

test('⑧-b 某条 @js: 规则出错 ⇒ 只跳过它、正文保持原样、必须留痕', () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown) => warns.push(String(m));
  let out;
  try {
    out = applyReplaceRules('正文abc', [rule({ id: 77, name: '坏规则', pattern: 'abc', replacement: '@js:zzz.nope()' })]);
  } finally {
    console.warn = orig;
  }
  assert.equal(out.text, '正文abc', '报错 ⇒ 本次不生效，正文不得被改写');
  assert.deepEqual(out.used, []);
  assert.ok(warns.some((w) => w.includes('坏规则')), `必须点名留痕，实际：${JSON.stringify(warns)}`);
});

test('⑨ 分组**存在但未参与匹配** ⇒ 插 `null`（Android 行为；**不是**空串）', () => {
  assert.equal(expandJavaReplacement('“$2”', ['ab', 'a', 'null']), '“null”');
  // 交替分支 `(x)|(y)`：命中 x 时第 2 组**存在但未参与**（JS 给 undefined ⇒ 归一成 'null'）
  const out = applyReplaceRules('x', [
    rule({ id: 5, name: 'null组', pattern: '(x)|(y)', replacement: '[$1|$2]' }),
  ]);
  assert.equal(out.text, '[x|null]', 'Android 语义：未参与的分组是字面量 null（不是空串）');
  assert.deepEqual(out.used, [5]);
  /**
   * ★ 对照：**真正越界**的组号（`$9`，分组表里根本没这个）**不是** `null`，而是**抛错** ——
   * Java 抛 `IndexOutOfBoundsException` ⇒ 上游 catch 后该条不生效。
   */
  const out2 = applyReplaceRules('x', [
    rule({ id: 6, name: '越界组', pattern: '(x)', replacement: '[$9]' }),
  ]);
  assert.equal(out2.text, 'x', '越界组号 ⇒ 该条本次不生效，正文原样');
  assert.deepEqual(out2.used, []);
});

test('⑩ `isRegex=false` 时**不求值 JS**（上游走字面替换，@js: 原样插入）+ 留痕', () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown) => warns.push(String(m));
  let out;
  try {
    out = applyReplaceRules('正文abc', [
      rule({ id: 8, name: '非正则js', pattern: 'abc', replacement: '@js:result', isRegex: false }),
    ]);
  } finally {
    console.warn = orig;
  }
  assert.equal(out.text, '正文@js:result', '照抄上游：字面插入');
  assert.ok(warns.some((w) => w.includes('没勾「正则」')), `必须留痕，实际：${JSON.stringify(warns)}`);
});

test('⑪ `parseReplaceCallbackArgs` 能认出 offset / 整体串 / 命名分组对象', () => {
  assert.deepEqual(parseReplaceCallbackArgs(['ab', 'a', 3, 'xaby']), {
    match: 'ab',
    groups: ['ab', 'a'],
    named: undefined,
  });
  assert.deepEqual(parseReplaceCallbackArgs(['ab', 'a', 3, 'xaby', { g: 'a' }]), {
    match: 'ab',
    groups: ['ab', 'a'],
    named: { g: 'a' },
  });
  // 未参与的可选分组（JS 给 undefined）⇒ 归一成 'null'
  assert.deepEqual(parseReplaceCallbackArgs(['b', undefined, 0, 'b']), {
    match: 'b',
    groups: ['b', 'null'],
    named: undefined,
  });
});

test('⑫ 前缀工具函数', () => {
  assert.equal(isJsReplacement('@js:1'), true);
  assert.equal(isJsReplacement('js:1'), false);
  assert.equal(jsScriptOf('@js:abc'), 'abc');
  assert.equal(jsScriptOf('@js:'), '');
});
