/**
 * `#252` **正则折算 + 灾难性删除护栏**的回归锁（用户真实规则实测：第 9 章 1089 字曾只剩 120 字）。
 *
 * 每组都配**防空转断言**：
 * · 「不再吞字」必须同时证明「该规则**本来会**吞字」（ASCII `\w` 语义下确实匹配得到）；
 * · 「护栏拦住」必须同时证明「小删除**不**被拦」（否则就是一刀切禁用，等于净化全废）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileAndroidRegex } from '../src/utils/regex-android';
import { applyReplaceRules } from '../src/utils/replace-rules';
import { emptyGlobalReaderPrefs, type ReadStyle, type ReplaceRule } from '@yuedu/core/contract';

const ZH = '秦江觉得不可思议，又瞧了瞧舞台上跳舞的姑娘，也没看出来是个国色天香。';

function compile(p: string, isRegex = true) {
  const r = compileAndroidRegex(p, isRegex);
  assert.ok(r.re, `应当能编译：${p} —— ${r.notes.join('；')}`);
  return r;
}

test('① \\w 按 Unicode 解释（Android/ICU 语义）：中文算词字符', () => {
  // 用户库里的真实写法：行尾垃圾清理。ASCII \\w 下中文「不是词字符」⇒ 整段被当垃圾吃掉。
  const p = '(?<=\\n)[^\\w「」…●]+$';
  const text = '第一行。\n' + ZH;
  const uni = compile(p);
  const ascii = new RegExp(p, 'g');
  // ★ 防空转：先证明「ASCII 语义下这条确实会吞字」—— 否则「Unicode 版不吞字」毫无意义
  assert.ok(ascii.test(text), '防空转：ASCII \\w 下该规则必须能匹配（这正是 bug 现场）');
  // 剩下只有第一行（lookbehind 不消费 \\n ⇒ 换行本身保留）—— 用户实测第 9 章 1089 字只剩 120 字就是这个
  assert.equal(text.replace(ascii, ''), '第一行。\n', 'ASCII 语义下整段中文被吃掉');
  // 正确行为：Unicode \\w 下中文是词字符 ⇒ 只吃真正的标点尾巴
  assert.ok(!uni.re!.test(text), 'Unicode \\w 下不该把中文当垃圾');
});

test('② Java 内联标志 (?i)/(?m)/(?s) 转成 JS flags', () => {
  const ci = compile('(?i)abc');
  assert.ok(ci.re!.test('ABC'), '(?i) ⇒ 忽略大小写');

  const ml = compile('(?m)^x');
  assert.ok(ml.re!.test('a\nx'), '(?m) ⇒ ^ 匹配行首');

  const dot = compile('(?s)a.b');
  assert.ok(dot.re!.test('a\nb'), '(?s) ⇒ . 匹配换行');

  // ★ 防空转：不带标志时 ^ 只匹配串首（证明上面那条的 m 真的加上了，不是碰巧通过）
  const noMl = compile('^x');
  assert.ok(!noMl.re!.test('a\nx'), '防空转：没有 (?m) 时 ^ 不该匹配第二行行首');
});

test('③ u 模式下的非法身份转义（\\– \\× 这类）不会让整条规则失效', () => {
  const r = compile('(?i)\\–|\\×|\\ꁘ');
  assert.ok(r.re, 'ICU 里合法、JS u 模式下非法的转义必须被折算掉');
  assert.ok(r.re!.test('–'), '折算后仍能匹配原字符');
  // ★ 防空转：SyntaxCharacter 的转义（\\[ ）必须保留，不能顺手去掉反斜杠
  const br = compile('\\[\\d+\\]');
  assert.ok(br.re!.test('[123]'), '\\[ 必须仍是字面方括号');
});

test('④ 中间出现的内联标志：去掉并留痕（不静默）', () => {
  const r = compileAndroidRegex('a|(?m)^b');
  assert.ok(r.re, '不能因为中间的标志就整条编译失败');
  assert.ok(r.notes.some((n) => n.includes('中间出现的内联标志')), '必须留痕说明语义差异');
});

test('⑤ 护栏：单条规则吞掉大半正文 ⇒ 本次不采用（保留原文）', () => {
  const rule: ReplaceRule = {
    id: 1, name: '吞字规则', group: null, pattern: '[\\s\\S]+', replacement: '',
    scope: null, scopeTitle: false, scopeSource: false, scopeContent: true, excludeScope: null,
    isEnabled: true, isRegex: true, timeoutMillisecond: 3000, order: 1,
  };
  const long = ZH.repeat(20);
  const out = applyReplaceRules(long, [rule], { trimLines: true });
  assert.equal(out.text.length, long.length, '★ 灾难性删除必须被拦下（正文保持原样）');
  assert.equal(out.used.length, 0, '被拦下的规则不算「生效」');
});

test('⑥ 防空转：护栏**不**拦正常的少量删除（否则净化等于全废）', () => {
  const rule: ReplaceRule = {
    id: 2, name: '删广告', group: null, pattern: '本章完', replacement: '',
    scope: null, scopeTitle: false, scopeSource: false, scopeContent: true, excludeScope: null,
    isEnabled: true, isRegex: true, timeoutMillisecond: 3000, order: 1,
  };
  const text = ZH + '\n本章完\n' + ZH;
  const out = applyReplaceRules(text, [rule], { trimLines: true });
  assert.ok(out.text.length < text.length, '★ 小删除必须照常生效（护栏不能一刀切）');
  assert.equal(out.used.length, 1);
});

test('⑦ 编译失败的规则：不改动正文、且不抛异常', () => {
  const rule: ReplaceRule = {
    id: 3, name: '坏正则', group: null, pattern: '([a-', replacement: '',
    scope: null, scopeTitle: false, scopeSource: false, scopeContent: true, excludeScope: null,
    isEnabled: true, isRegex: true, timeoutMillisecond: 3000, order: 1,
  };
  const out = applyReplaceRules(ZH, [rule], { trimLines: true });
  assert.equal(out.text, ZH, '坏规则不该动正文');
});

/** 用契约默认值造一条完整规则（避免测试里漏字段导致类型漂移） */
test('⑧ 字面替换（isRegex=false）仍走 split/join，不受折算影响', () => {
  const rule: ReplaceRule = {
    ...(emptyGlobalReaderPrefs() as unknown as object),
    id: 4, name: '字面', group: null, pattern: '国色天香', replacement: '天香国色',
    scope: null, scopeTitle: false, scopeSource: false, scopeContent: true, excludeScope: null,
    isEnabled: true, isRegex: false, timeoutMillisecond: 3000, order: 1,
  } as unknown as ReplaceRule;
  const out = applyReplaceRules(ZH + ZH, [rule], {});
  assert.ok(out.text.includes('天香国色'), '字面替换照常工作');
});

/* ===================== `#259` 词边界：ICU 的 `\b`/`\B` 是 Unicode 的 =====================
 * ★★ 本组每条都必须**同时**给出「原生 JS（ASCII 语义）」的结果作对照。
 *    否则「折算后不匹配」这种断言什么都证明不了 —— 它可能本来就那样（`#257` 的教训：
 *    「目标现象消失了」不等于「是我的改动让它消失的」）。
 * ★ 另外每条都要换一个**新的** RegExp：编译结果是带 `g` 的，同一个对象连续 `test`
 *    会因 `lastIndex` 残留而漂移（第二次从上次命中处往后搜）—— 那会让断言时对时错。
 */
test('⑨ \\b 是 Unicode 词边界：中文也算词字符（与 JS 默认相反）', () => {
  // 防空转：**原生 JS** 在「a中b」里把「中」当**非**词字符 ⇒ a|中 与 中|b 都成了边界
  assert.equal('a中b'.replace(/\b中\b/gu, 'X'), 'aXb', '防空转：JS 默认反而**会**匹配到「中」');
  // ★ ICU 语义：a / 中 / b 全是词字符 ⇒ 中间没有任何边界
  assert.equal('a中b'.replace(compile('\\b中\\b').re!, 'X'), 'a中b', '★ ICU 下不该匹配');
  // 空格是非词字符 ⇒ 两侧成边界，该匹配的还是要匹配
  assert.equal('a 中 b'.replace(compile('\\b中\\b').re!, 'X'), 'a X b', '空格两侧是边界');
  assert.ok(compile('\\b中\\b').notes.some((n) => n.includes('词边界')), '折算必须留痕（不静默）');
});

test('⑩ 用户库真实写法 `，\\b`（`#19`/`#25`「拆分长句」的核心，共出现 ~135 次）', () => {
  const text = '，下一句话';
  // 防空转：JS 默认下逗号后紧跟汉字**不成立**（汉字不是词字符）⇒ 这两条规则本来基本失效
  assert.ok(!new RegExp('，\\b', 'gu').test(text), '防空转：JS 默认下「，汉」不是边界');
  assert.ok(compile('，\\b').re!.test(text), '★ ICU 下逗号（非词）| 汉字（词）是边界 ⇒ 能匹配');
  // 西文那侧两种语义一致（不能因为折算把原本对的弄坏）
  assert.ok(compile('，\\b').re!.test('，abc'), '逗号 + 西文字母：两种语义下都成立');
});

test('⑪ \\B 同样按 ICU 解释（用户库 `#09` 的 `(?<=\\B[”＂]\\n)`）', () => {
  const p = '(?<=\\B[”＂]\\n)';
  const text = '他道“好吧”\n下一段';
  // 防空转：JS 默认下「好」是非词字符 ⇒ 非词|非词 ⇒ **不是**边界 ⇒ \B 成立 ⇒ 会匹配
  assert.ok(new RegExp(p, 'gu').test(text), '防空转：JS 默认下 \B 成立');
  // ★ ICU 语义：「好」是词字符而「”」不是 ⇒ 那是**边界** ⇒ \B 不成立
  assert.ok(!compile(p).re!.test(text), '★ ICU 下 `好|”` 是边界 ⇒ \\B 不该成立');
});

test('⑫ 用户库 `#11` 的 `\\b(?=[汉字])`：换行后的汉字前是边界', () => {
  const p = '\\b(?=[\\u4e00-\\u9fcc])';
  // 防空转：JS 默认下 `\\n|汉` 不是边界（汉字非词）
  assert.ok(!new RegExp(p, 'gu').test('\n汉'), '防空转：JS 默认下不成立');
  assert.ok(compile(p).re!.test('\n汉'), '★ ICU 下 \\n（非词）| 汉（词）是边界');
});

test('⑬ 字符类内的 `\\b` 是**退格字符**，不能折算成断言', () => {
  const r = compile('[\\b]');
  assert.ok(r.re!.test('\u0008'), '类内的 \\b 仍是退格字符 U+0008');
  // 防空转：若被误折成零宽断言，`[\b]` 要么语法错误、要么匹配空串 —— 两种都会让这条红
  assert.ok(!compile('[\\b]').re!.test('a'), '不能匹配普通字符');
  assert.ok(r.notes.some((n) => n.includes('退格')), '留痕说明类内没折算');
});

test('⑭ `\\b{...}`（Java 9+ 字素簇边界）不折算，只留痕', () => {
  const r = compileAndroidRegex('\\b{g}');
  assert.ok(r.notes.some((n) => n.includes('字素簇')), '必须留痕说明本仓不支持');
});

test('⑮ 行首 / 行尾 / 相邻非词字符都算边界（负向断言覆盖「没有字符」的情形）', () => {
  assert.equal('书'.replace(compile('\\b书\\b').re!, 'X'), 'X', '整串就是一个字 ⇒ 两侧都是边界');
  assert.equal('《书》'.replace(compile('\\b书\\b').re!, 'X'), '《X》', '书名号是非词字符 ⇒ 两侧成边界');
  // ★ 防空转的另一面：前后都是汉字时**没有**边界
  assert.equal('图书'.replace(compile('\\b书\\b').re!, 'X'), '图书', '★ 汉字夹汉字：ICU 下无边界');
  // ★★ 行首/行尾的负向断言：`\B` 在「串首紧邻词字符」处**不成立**（那里是边界）。
  //    这一条正好能区分两种语义 —— JS 默认下汉字是非词字符 ⇒ `\B` 反而成立。
  assert.equal('书'.replace(/\B书/gu, 'X'), 'X', '防空转：JS 默认下串首的 \\B 成立（汉字被当成非词）');
  assert.equal('书'.replace(compile('\\B书').re!, 'X'), '书', '★ ICU 下「串首 | 书」是边界 ⇒ \\B 不成立');
});

test('⑯ 字符类内的 `\\B`（大写）：JS u 模式下非法 ⇒ 回退 + 留痕，绝不静默变成字面字母 B', () => {
  // ⑬ 覆盖的是 `[\b]`（退格字符，JS 与 ICU 同义）；这里补**大写**的 `[\B]` —— 它在字符类里没有对应语义。
  //   实测：`new RegExp('[\\B]', 'u')` 抛 `Invalid escape`；不带 u 则是 Annex B 身份转义 ⇒ 字面字母 B。
  const r = compileAndroidRegex('[\\B]');
  assert.ok(r.re, '回退后仍能编译（否则整条规则静默失效）');
  assert.ok(!r.flags.includes('u'), '回退版本必须去掉 u 标志（带 u 时 `[\\B]` 是非法转义）');
  assert.ok(r.notes.some((n) => n.includes('\\B')), '必须留痕说明「语义不可信」');
  // ★ 防空转：回退版真的匹配到字面字母 B —— 这个「能跑但语义是错的」结果，正是留痕不可省的原因。
  //    断言它，才不会哪天有人把 `[\B]` 顺手"修"成静默通过。
  assert.ok(r.re!.test('B'), '回退版实际匹配字面字母 B（语义是错的）');
});
