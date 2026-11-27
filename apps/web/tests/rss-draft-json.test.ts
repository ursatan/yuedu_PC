/**
 * `#460` 新建 RSS 订阅源的**类型保真**锁。
 *
 * ## 用户原话（2026-10-15）
 * 「我在规则工坊新建 RSS 源，生成的 JSON 和导入的『源仓库(官方纯净)』的 JSON 不一样：
 *   我设置了源类型 0，但生成的 JSON 没有这项数据，并且 true/false 变成了字符串；
 *   而源仓库直接是值。比对 legado 书源/订阅源，看新建源生成的 JSON 与正式源 JSON 差别：
 *   数据项、数据值、数据顺序等。」
 *
 * ## 为什么这不是「观感问题」
 * `packages/engine-rss/src/model/rss-source.ts` 的编译按**严格类型**读：
 *   · `singleUrl: raw.singleUrl === true` ⇒ 字符串 `"true"` 得 **false**（能力位失效 ⇒
 *     网页型源不再当「一篇文章」直接打开）；
 *   · `articleStyle: typeof raw.articleStyle === 'number' ? … : 0`、`type` 同理
 *     ⇒ 字符串 `"2"` **静默回落 0**（不报错）。
 *
 * 两处接线各锁一半：① 草稿模板给足「有默认值字段 + 正确类型」（`stores/sources.ts`）；
 * ② 表单 setter 对契约里的布尔/数字字段**与键是否存在无关**地归一（`WorkshopEditor.vue`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
const SOURCES = read('src/stores/sources.ts');
const EDITOR = read('src/WorkshopEditor.vue');

/** 剥掉注释（分支的说明注释里就写着 `ruleArticles: ''` 之类的示例，会让「键序」断言命中它） */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 只取 `startDraft` 里 `kind === 'rss'` 那个分支（避免误伤 maccms/legado 的模板） */
const rssBranch = ((): string => {
  const i = SOURCES.indexOf("kind === 'rss'");
  assert.ok(i > 0, '找不到 RSS 草稿分支（实现位置变了，本锁要跟着改）');
  // 该分支止于 legado 兜底分支（`\n      : {`）—— 按行首缩进定位，别用 `: {`（分支内部的 `raw: {` 会误命中）
  const end = SOURCES.indexOf('\n      : {', i);
  assert.ok(end > i, '找不到 RSS 分支的结束位置');
  return stripComments(SOURCES.slice(i, end));
})();

/** legado 兜底分支（`startDraft` 的最后一个 `: {` 起到 `};` 为止） */
const legadoBranch = ((): string => {
  const i = SOURCES.lastIndexOf('\n      : {');
  assert.ok(i > 0, '找不到 legado 兜底分支（实现位置变了，本锁要跟着改）');
  const end = SOURCES.indexOf('};', i);
  assert.ok(end > i, '找不到 legado 分支的结束位置');
  return stripComments(SOURCES.slice(i, end));
})();

test('#460 新建 RSS 草稿：默认值字段齐（含源类型 type）且类型正确', () => {
  // 有默认值的字段都要在（否则用户不填就「没这项数据」）
  for (const [key, val] of [
    ['sourceUrl', "''"],
    ['enabledCookieJar', 'true'],
    ['singleUrl', 'false'],
    ['articleStyle', '0'],
    ['ruleArticles', "''"],
    ['enableJs', 'true'],
    ['loadWithBaseUrl', 'true'],
    ['showWebLog', 'false'],
    ['lastUpdateTime', '0'],
    ['customOrder', '0'],
    ['type', '0'],
    ['cacheFirst', 'false'],
  ] as const) {
    assert.match(rssBranch, new RegExp(`${key}:\\s*${val.replace("'", "'")}(,|\\s|\\})`), `草稿缺少或类型不对：${key}: ${val}`);
  }
  // 值必须是**真**布尔/数字 —— 不得出现 `"true"` / `'true'` / `"0"` 这类字符串字面量
  assert.doesNotMatch(rssBranch, /:\s*(['"])(true|false|0|1)\1/, '值不得被写成字符串字面量');
});

test('#460 草稿的键序 = 上游 RssSource 主构造器序（数据顺序也要对得上）', () => {
  const order = ['sourceUrl', 'sourceName', 'enabled', 'enabledCookieJar', 'singleUrl', 'articleStyle', 'ruleArticles', 'enableJs', 'loadWithBaseUrl', 'showWebLog', 'lastUpdateTime', 'customOrder', 'type', 'preload', 'cacheFirst'];
  let at = -1;
  for (const k of order) {
    const i = rssBranch.indexOf(`${k}:`);
    assert.ok(i >= 0, `草稿缺少契约字段 ${k}`);
    assert.ok(i > at, `字段序与契约不符：${k} 出现在前一个字段之前`);
    at = i;
  }
});

test('#461 新建 legado 草稿：字段集 / 值类型 / 键序 = 上游 BookSource.kt 主构造器', () => {
  // 非 null 默认值字段都要在、且类型正确（`BookSource.kt:34-103`）
  for (const [key, val] of [
    ['bookSourceUrl', "''"],
    ['bookSourceType', '0'],
    ['customOrder', '0'],
    ['enabled', 'true'],
    ['enabledExplore', 'true'],
    ['enabledCookieJar', 'true'],
    ['lastUpdateTime', '0'],
    ['weight', '0'],
    ['eventListener', 'false'],
    ['customButton', 'false'],
  ] as const) {
    assert.match(legadoBranch, new RegExp(`${key}:\\s*${val}(,|\\s|\\})`), `legado 草稿缺少或类型不对：${key}`);
  }
  assert.match(legadoBranch, /ruleSearch:\s*\{\}/, 'detect 判据靠 ruleSearch（空对象也得在）');
  assert.doesNotMatch(legadoBranch, /:\s*(['"])(true|false|0|1)\1/, '值不得写成字符串字面量');
  // ⚠️ respondTime 是**运行期度量**（响应耗时），不是源作者字段 ⇒ 刻意不收
  assert.doesNotMatch(legadoBranch, /respondTime/, '不得把运行期度量 respondTime 塞进新建源');

  // 键序 = 上游主构造器序（只取「非 null 默认值」的那批）
  const order = ['bookSourceUrl', 'bookSourceName', 'bookSourceType', 'customOrder', 'enabled', 'enabledExplore', 'enabledCookieJar', 'lastUpdateTime', 'weight', 'eventListener', 'customButton', 'ruleSearch'];
  let at = -1;
  for (const k of order) {
    const i = legadoBranch.indexOf(`${k}:`);
    assert.ok(i >= 0, `legado 草稿缺少契约字段 ${k}`);
    assert.ok(i > at, `字段序与上游主构造器不符：${k} 出现在前一个字段之前`);
    at = i;
  }
});

test('#460 表单 setter：契约里的布尔/数字字段与「键是否存在」无关地归一', () => {
  // ② 的那张表必须在，且要覆盖 RSS 的 10 个字段 + 书源的 4 个
  for (const k of ['singleUrl', 'enableJs', 'loadWithBaseUrl', 'showWebLog', 'cacheFirst', 'preload', 'articleStyle', 'type', 'customOrder', 'lastUpdateTime', 'enabled', 'enabledCookieJar', 'weight', 'bookSourceType']) {
    assert.match(EDITOR, new RegExp(`${k}:\\s*'(boolean|number)'`), `TYPED_FIELDS 缺 ${k}`);
  }
  // 取值必须查表（而不是只看当前值）
  assert.match(EDITOR, /TYPED_FIELDS\[path\]/, 'setter 必须查 TYPED_FIELDS（否则新建源仍会被写成字符串）');
  // ⚠️ `concurrentRate` 上游是 String，**不得**被当成数字归一
  assert.doesNotMatch(EDITOR, /concurrentRate:\s*'number'/, 'concurrentRate 是字符串字段（"1000/5"），不可归一成数字');
});
