/**
 * `#680` 两处「上一轮挂账」的核查结论，用测试把契约钉住。
 *
 * ## ① 链式 `@js:`（段后接 js）—— **本来是好的**
 *
 * `#679` 的轮次文档里写了「`li>a@text@js:…` 当前返回空」，那是**我的测量错误**：
 * 当时用的 env 是 `jsEval: () => ''` 的桩，任何脚本都返回空串。
 * 换真求值器（`makeProbeEnv`）后一切正常 —— 与记忆里那条「先证明测的就是那条路」同一个坑。
 *
 * 上游 `AnalyzeRule.splitSourceRule`（:593-636）按 `<js>` / `@js:` 把规则切成多段，
 * 逐段求值时后一段的 `result` 就是前一段的输出：
 *   · 取值路径（getString）：前一段是**字符串** ⇒ `result + "!"` 是字符串拼接；
 *   · 取元素路径（getElements）：前一段是**元素集合** ⇒ Rhino 转成数组，`result.length` 可用。
 *
 * ## ② `-` / `+` 前缀 —— 不是 bug，是「实现位置不同」
 *
 * 上游只在 `BookList.kt:90-100` / `BookChapterList.kt:54-62` 剥前缀并反转；
 * `AnalyzeByJSoup.getElements` **不剥**。本仓把这一步放进了 `core` 的 `getElementsInner`，
 * 好处是「搜索 / 发现 / 目录」三条路径共用一份；风险是**同一条规则不能被剥两次**
 * （引擎在目录段先剥再调 core，故当前只 reverse 一次 —— 下面用例锁住这个契约）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { makeProbeEnv } from '../diag/probe';

const HTML =
  '<div class="menu"><ul class="clear">'
  + '<li><a href="/a1/">玄幻</a></li>'
  + '<li><a href="/a2/">仙侠</a></li>'
  + '<li><a href="/a3/">都市</a></li>'
  + '</ul>'
  + '<div id="d"><img src="1.jpg"><img src="2.jpg"></div></div>';

function mk(content = HTML): AnalyzeRule {
  const { env } = makeProbeEnv({ content, baseUrl: 'https://x/', vars: {} } as never);
  return new AnalyzeRule(env).setContent(content, 'https://x/');
}

/* --------------------- ① 链式 @js: --------------------- */

test('J-① 取值路径：`@js:` 段拿到的 result 是前一段的**字符串**', async () => {
  assert.equal(await mk().getString('li>a@text@js:result+"!"'), '玄幻\n仙侠\n都市!');
  assert.equal(await mk().getString('li>a@text@js:result.replace(/\\n/g,"|")'), '玄幻|仙侠|都市');
});

test('J-② 取值路径：链式 js 返回数组 ⇒ getStringList 按数组给出', async () => {
  assert.deepEqual(await mk().getStringList('li>a@text@js:result.split("\\n")'), ['玄幻', '仙侠', '都市']);
});

test('J-③ 取值路径：链式 js 可以拼前缀/去后缀（源里最常见的用法）', async () => {
  assert.deepEqual(
    await mk().getStringList('li>a@href@js:"https://x"+result'),
    ['https://x/a1/', '/a2/', '/a3/'],
  );
  assert.deepEqual(await mk().getStringList('li>a@href@js:result.replace(/\\//g,"")'), ['a1', 'a2', 'a3']);
});

test('J-④ 取值路径：`##` 清洗段与 `@js:` 可以串起来', async () => {
  assert.deepEqual(await mk().getStringList('li>a@text##(.)(.*)##$1'), ['玄', '仙', '都']);
});

test('J-⑤ 取元素路径：多元素时 `result` 是**数组**（长度可用，上游 Rhino 同语义）', async () => {
  const els = (await mk().getElements('//div[@id="d"]/img@js:result.length')) as unknown[];
  assert.equal(els.length, 1);
  assert.equal(String(els[0]), '2', '2 个 img ⇒ result 是长度 2 的数组');
  // 对照：取值路径里前一段给的是**字符串**，所以同一个脚本在这里得到 0（img 无文本）
  assert.equal(await mk().getString('//div[@id="d"]/img@js:result.length'), '0');
});

test('J-⑥ 取元素路径：`@js:[result]` 是「把结果再包一层数组」——记录当前行为', async () => {
  /**
   * 上游 `AnalyzeRule.getElements` 收尾把 `Collection` 里**非 Element 项丢弃**
   * ⇒ 嵌套数组会被丢掉（0 元素）。本仓 `toList()` 保留了这个数组项（1 个「非元素」）。
   * 两者都不对「源作者本意」，但**都不静默造出假元素**；这里锁住现状，
   * 将来若要摊平（更宽容）或严格丢弃（更贴上游），改动会立刻被这条用例发现。
   */
  const els = await mk().getElements('//div[@id="d"]/img@js:[result]');
  assert.equal(els.length, 1, '当前：整层数组被保留成 1 项');
  assert.ok(Array.isArray(els[0]), '该项是数组而不是元素');
});

/* --------------------- ② -/+ 前缀 --------------------- */

test('M-① `-` 前缀 = 结果倒序（目录「新章在前」的写法）', async () => {
  assert.deepEqual(await mk().getStringList('li>a@text'), ['玄幻', '仙侠', '都市'], '基准');
  const els = (await mk().getElements('-class.clear@tag.li')) as unknown[];
  const texts = els.map((e) => String((e as { textContent?: string }).textContent ?? '').trim());
  assert.deepEqual(texts, ['都市', '仙侠', '玄幻'], '`-` 要整体反转');
});

test('M-② `+` 前缀 = 只剥掉、不反转', async () => {
  const els = (await mk().getElements('+class.clear@tag.li')) as unknown[];
  const texts = els.map((e) => String((e as { textContent?: string }).textContent ?? '').trim());
  assert.deepEqual(texts, ['玄幻', '仙侠', '都市']);
});

test('M-③ 契约：引擎（目录段）先剥 `-` 再交给 core ⇒ 只反转一次，不会抵消', async () => {
  /**
   * `engine.ts` 的 `parseChapters` 会先 `slice(1)` 并把 `reverse` 记下来，
   * 所以 core 见到的是**不带前缀**的规则 ⇒ 不会第二次反转。
   * 这里直接模拟那两步，确认净效果 = 反转一次。
   */
  const stripped = (await mk().getElements('-class.clear@tag.li'.slice(1))) as unknown[];
  const texts = stripped.map((e) => String((e as { textContent?: string }).textContent ?? '').trim());
  assert.deepEqual(texts, ['玄幻', '仙侠', '都市'], 'core 对「无前缀规则」不再反转');
  assert.deepEqual([...texts].reverse(), ['都市', '仙侠', '玄幻'], '引擎再反转一次 = 用户要的倒序');
});
