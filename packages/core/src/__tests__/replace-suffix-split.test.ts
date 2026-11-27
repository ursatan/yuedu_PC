/**
 * 规则尾部的 `##替换##` 段（Legado `SourceRule.makeUpMode` :820-831）——**真实语料回归锁**。
 *
 * 背景（用户实测的「10 个源 detail 全挂」）：
 * 语料里有 8 个源共用一条「最新章节/章节名清洗」规则，形态是
 *     `{{...}}\n@js:result.replace(...)...\n##(章)([^\s]+)(\s·)##$1 $2$3`
 * 其中 JS 里的正则含**转义括号**：`[\\(\\{（｛【]`。旧的 splitClean 只按括号配平判断，
 * 把 `\(`/`\{` 当成真括号 → 深度 +2 再也回不来 → `##` 永不切分 → 替换段被当 JS 求值
 * → `RULE_PARSE@parse:Invalid or unexpected token`（detail 整条挂掉）。
 *
 * 本文件用**语料原文**（脚本从 data/sources/book-482 精确取出，避免手抄走样）锁三件事：
 *  ① `splitClean` 必须切出替换段；② 转义/字符类/字符串字面量里的括号不算分组；
 *  ③ 端到端求值不再抛语法错，且替换真的生效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnalyzeRule, createJsEvaluator, createVariableStore } from '../index';
import type { AnalyzeEnv } from '../index';
import { splitClean } from '../selector/rule-analyzer';

/** 语料原文（源名 → [字段, 规则串]） */
const CORPUS: Record<string, { field: string; rule: string }> = {
  "📂精武小说": { field: "ruleBookInfo.lastChapter", rule: "{{@@[property$=chapter_name]@content}}･{{@@[property$=update_time]@content##\\s.*}}\n@js:result\n.replace(\"••\",\"\")\n.replace(/^(\\d+).第/,'第')\n.replace(/^(正文|VIP章节|最新章节)?(\\s+|_)|[\\(\\{（｛【].*[求含理更谢乐发推票盟补加字Kk\\/].*/g,'')\n.replace(/^(\\d+)[、．]第.+章/,'第$1章')\n.replace(/^(\\d+)、\\d+、/,'第$1章 ')\n.replace(/^(\\d+)、\\d+/,'第$1章')\n.replace(/^(第.+章)\\s?\\d+/,'$1')\n.replace(/^(\\d+)、/,'第$1章 ')\n.replace(/^(第.+章)\\s?第.+章/,'$1')\n.replace(/第\\s(.+)\\s章/,'第$1章')\n.replace(/.*(chapter|Chapter)\\s?(\\d+)\\s?/,'$1 $2 ')\n.replace(/\\(.+\\)/,'')\n.replace(/\\[|。/,'')\n.replace(/第([零一二两三四五六七八九十百千]+)章/g,java.toNumChapter(result))\n##(章)([^\\s]+)(\\s·)##$1 $2$3" },
  "⚡📂努努书坊": { field: "ruleBookInfo.lastChapter", rule: "{{@@[property$=chapter_name]@content}}\n@js:result\n.replace(\"••\",\"\")\n.replace(/^(\\d+).第/,'第')\n.replace(/^(正文|VIP章节|最新章节)?(\\s+|_)|[\\(\\{（｛【].*[求含理更谢乐发推票盟补加字Kk\\/].*/g,'')\n.replace(/^(\\d+)[、．]第.+章/,'第$1章')\n.replace(/^(\\d+)、\\d+、/,'第$1章 ')\n.replace(/^(\\d+)、\\d+/,'第$1章')\n.replace(/^(第.+章)\\s?\\d+/,'$1')\n.replace(/^(\\d+)、/,'第$1章 ')\n.replace(/^(第.+章)\\s?第.+章/,'$1')\n.replace(/第\\s(.+)\\s章/,'第$1章')\n.replace(/.*(chapter|Chapter)\\s?(\\d+)\\s?/,'$1 $2 ')\n.replace(/\\(.+\\)/,'')\n.replace(/\\[|。/,'')\n.replace(/第([零一二两三四五六七八九十百千]+)章/g,java.toNumChapter(result))\n##(章)([^\\s]+)(\\s·)##$1 $2$3" },
  "⚡📂书荒小说": { field: "ruleToc.chapterName", rule: "text\n@js:result\n.replace(\"••\",\"\")\n.replace(/^(\\d+).第/,'第')\n.replace(/^(正文|VIP章节|最新章节)?(\\s+|_)|[\\(\\{（｛【].*[求含理更谢乐发推票盟补加字Kk\\/].*/g,'')\n.replace(/^(\\d+)[、．]第.+章/,'第$1章')\n.replace(/^(\\d+)、\\d+、/,'第$1章 ')\n.replace(/^(\\d+)、\\d+/,'第$1章')\n.replace(/^(第.+章)\\s?\\d+/,'$1')\n.replace(/^(\\d+)、/,'第$1章 ')\n.replace(/^(第.+章)\\s?第.+章/,'$1')\n.replace(/第\\s(.+)\\s章/,'第$1章')\n.replace(/.*(chapter|Chapter)\\s?(\\d+)\\s?/,'$1 $2 ')\n.replace(/\\(.+\\)/,'')\n.replace(/\\[|。/,'')\n.replace(/第([零一二两三四五六七八九十百千]+)章/g,java.toNumChapter(result))\n##(章)([^\\s]+)(\\s·)##$1 $2$3" },
  "📂顶点小说#6": { field: "ruleBookInfo.lastChapter", rule: "{{$.lastChapter.chapterName##正文卷.|正文.|VIP卷.|默认卷.|卷_|VIP章节.|免费章节.|章节目录.|最新章节.|[\\(（【].*?[求含理更谢乐发推票盟补加字].*?[】）\\)]}}•{{$..decTime}}\n@js:result\n.replace(\"••\",\"\")\n.replace(/^(\\d+).第/,'第')\n.replace(/^(\\d+)[、．]第.+章/,'第$1章')\n.replace(/^(\\d+)、\\d+、/,'第$1章 ')\n.replace(/^(\\d+)、\\d+/,'第$1章')\n.replace(/^(第.+章)\\s?\\d+/,'$1')\n.replace(/^(\\d+)、/,'第$1章 ')\n.replace(/^(第.+章)\\s?第.+章/,'$1')\n.replace(/第\\s(.+)\\s章/,'第$1章')\n.replace(/.*(chapter|Chapter)\\s?(\\d+)\\s?/,'$1 $2 ')\n.replace(/\\(.+\\)/,'')\n.replace(/\\[|。/,'')\n.replace(/第([零一二两三四五六七八九十百千]+)章/g,java.toNumChapter(result))\n##(章)([^\\s]+)(\\s·)##$1 $2$3" },
};

const TAIL_REPLACE_REGEX = '(章)([^\\s]+)(\\s·)';
const TAIL_REPLACEMENT = '$1 $2$3';

test('真实语料：每条清洗规则都必须切出「替换段」（旧实现在 8 源上切不出来 → JS 语法错）', () => {
  assert.ok(Object.keys(CORPUS).length >= 4, '语料样本不足（应含 书荒小说/顶点小说#6/精武小说/努努书坊）');
  for (const [name, { field, rule }] of Object.entries(CORPUS)) {
    const c = splitClean(rule);
    assert.equal(c.replaceRegex, TAIL_REPLACE_REGEX, `${name} [${field}] 必须切出替换正则`);
    assert.equal(c.replacement, TAIL_REPLACEMENT, `${name} [${field}] 必须切出替换文本`);
    assert.equal(c.replaceFirst, false, `${name} [${field}] 三段式不是 replaceFirst`);
    assert.ok(!c.rule.includes(TAIL_REPLACE_REGEX), `${name} [${field}] 求值部分不得残留替换正则`);
    assert.ok(c.rule.includes('toNumChapter'), `${name} [${field}] JS 部分应完整保留`);
    // 头部（`{{...}}` 里）自带嵌套 `##` 的源（如 `{{$.x##正文卷.|…}}`）要等占位符先求值，
    // 那时内层 `##` 已消费；所以只在“头部没有嵌套 ##”的源上断言求值部分零残留。
    const head = rule.slice(0, rule.includes('@js:') ? rule.indexOf('@js:') : 0);
    if (!head.includes('##')) {
      assert.ok(!c.rule.includes('##'), `${name} [${field}] 求值部分不得残留 ##（残留就会当 JS 跑→语法错）`);
    }
  }
});

function makeEnv(): AnalyzeEnv {
  const variables = createVariableStore();
  return { baseUrl: 'https://x.com/', variables, jsEval: createJsEvaluator({ variables }) };
}

/**
 * 端到端：把语料里那条清洗规则的 `@js:` 段接到一个 JSON 字段上求值。
 * 旧实现会在 JS 解析阶段抛 `Invalid or unexpected token`（替换段被当成 JS 的一部分）。
 * 期望值来自实测（`tmp/probe-clean.mts`），并且**分「匹配/不匹配」两种输入**：
 * 替换正则是 `(章)([^\s]+)(\s·)`，所以 `第1章剑来 ·上` 命中、`第1章 剑来·上` 本就不命中（不是缺陷）。
 */
test('端到端：语料清洗规则经 AnalyzeRule 求值不抛语法错，且尾部替换真的生效', async () => {
  const rule = CORPUS['⚡📂书荒小说']!.rule.replace(/^text\n/, '$.chapterName\n');
  const run = async (chapterName: string): Promise<string> => {
    const env = makeEnv();
    const r = new AnalyzeRule(env).setContent(JSON.stringify({ chapterName }));
    return r.getString(rule);
  };
  // 命中：`章剑来 ·` → `章 剑来 ·`
  assert.equal(await run('第1章剑来 ·上'), '第1章 剑来 ·上', '尾部 ##替换## 必须生效');
  // 不命中：正则要求「章 + 非空白 + 空白 + ·」，此输入不满足 → 原样（同样不得抛错）
  assert.equal(await run('第1章 剑来·上'), '第1章 剑来·上', '不匹配时不得改动、也不得抛错');
  // JS 段本身的清洗照常生效
  assert.equal(await run('正文 第一章'), '第1章', 'JS 段清洗应正常');
});

test('切分边界：转义括号 / 字符类里的括号 / 字符串字面量里的括号都不算分组', () => {
  // ① 转义括号（就是踩坑的那条正则的片段）
  assert.equal(splitClean('.replace(/[\\(\\{]/g,"")##a|b##X').replaceRegex, 'a|b');
  // ② 字符类里未转义的 ( ：/[(]/ 里的 ( 是字面量
  assert.equal(splitClean('.replace(/[(]/g,"")##a##X').replaceRegex, 'a');
  // ③ 字符串字面量里的 ( ：.replace("(","") 未配平，但那是字符串
  assert.equal(splitClean('.replace("(","")##a##X').replaceRegex, 'a');
  // ④ 未闭合引号 → 扫描器放弃 → 回退 Legado 扁平切分（保证不漏切）
  const fallback = splitClean('.replace("a##x##y');
  assert.equal(fallback.replaceRegex, 'x');
  assert.equal(fallback.replacement, 'y');
});

test('JS 段里字符类中的 ## 不得触发扁平切分（软件库-岚揍云 ruleArticles）', () => {
  // 语料原文第 64 行：`[^##]` 是正则字符类，不是 Legado 的替换分隔符。
  // 旧实现扫描器（正确地）不切，但「无顶层 ## ⇒ 扁平兜底」又把它从 `[^` 处切开
  // ⇒ `Invalid regular expression: missing /`。
  const line = 'mat = baseUrl.match(/^(.*?\\.com)[^##]*\\/(.+)$/)';
  const c = splitClean(line);
  assert.equal(c.rule, line, '整行必须原样保留（不得被 ## 截断）');
  assert.equal(c.replaceRegex, '', '不得误切出替换正则');
  assert.equal(c.replacement, '', '不得误切出替换文本');
  // 截断后的 `[^` 会直接编不过；这里锁住「切完仍可编译」
  assert.doesNotThrow(() => new Function(c.rule), '切分结果必须是合法 JS');
});

test('切分边界：第 4 段 = replaceFirst；无替换段时原样返回', () => {
  const four = splitClean('$.title##a##b##');
  assert.equal(four.rule, '$.title');
  assert.equal(four.replaceRegex, 'a');
  assert.equal(four.replacement, 'b');
  assert.equal(four.replaceFirst, true);

  const plain = splitClean('$.title');
  assert.equal(plain.rule, '$.title');
  assert.equal(plain.replaceRegex, '');
  assert.equal(plain.replaceFirst, false);
});
