/**
 * `#403` 回归锁：`{{}}` 占位符内容以 `@` / `$.` / `$[` / `//` 开头 = **源规则**（非 JS）。
 *
 * ## 用户报障原文（RSS 订阅源 秀人集v26）
 * ```
 * Unexpected end of input｜出现在 yuedu-rule.js:8
 * | tag: `<h3>{{@@h1@text
 * ```
 * 源 `ruleContent`（整段 `@js:`）在反引号模板串里写 `{{@@h1@text##\[.*?\]}}`。
 *
 * ## 真因（两步）
 *  ① 本仓 `placeEval` **一律 jsEval** ⇒ `@@h1@text##\[.*?\]` 当作 JS 求值 = 语法错
 *     ⇒ `resolvePlaceholders` 捕获后**保留原文**（Legado 同款：frv 为空不替换）；
 *  ② 残留的 `{{...##...}}` 里的 `##` 被 `splitClean` 的**扁平兜底**切开 —— 脚本在 `##` 处被截断
 *     ⇒ 「Unexpected end of input」（反引号模板串未闭合）。实测截断点与用户片段逐字一致。
 *
 * ## 上游语义（逐行核对）
 *  · `AnalyzeRule.kt:795-799`：`makeUpRule` 里 `if (isRule(ruleParam[i])) getString(...) else evalJS(...)`；
 *  · `AnalyzeRule.kt:837-842`：`isRule = startsWith('@') || startsWith("$.") || startsWith("$[") || startsWith("//")`
 *    （`@` 开头规定为规则 —— JS 首个字符不可能是 `@`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzeRule } from '../selector/analyze';
import { resolveUrl } from '../net';
import { createVariableStore } from '../store';

const HTML = '<html><body><h1>标题甲</h1><div class="jianjie"><p>简介一</p><p>p2</p></div></body></html>';

/** 记录喂给 jsEval 的脚本文本；`n` → 7（对偶：普通 JS 占位符仍走 jsEval） */
function makeEnv(seen: string[]) {
  return {
    baseUrl: 'https://api.test/',
    variables: createVariableStore(),
    jsEval: async (code: string) => {
      seen.push(code);
      if (/^\s*n\s*$/.test(code)) return 7;
      return `OUT:${code}`;
    },
    jsEvalSync: (code: string) => {
      seen.push(code);
      return `OUT:${code}`;
    },
    toAbsolute: (u: string) => resolveUrl('https://api.test/', u),
  } as never;
}

test('#403：{{@@rule}} 按规则求值（不再当 JS）—— 模板串内 ## 替换不再截断脚本', async () => {
  const seen: string[] = [];
  // 复刻真源形态：@js: + 反引号模板串内的 {{@@h1@text##\[.*?\]}}
  const rule = '@js:\nlet s = `<h3>{{@@h1@text##\\[.*?\\]}}</h3>`;\ns';
  const out = await new AnalyzeRule(makeEnv(seen))
    .setContent(HTML, 'https://api.test/')
    .getString(rule);

  const script = seen.find((c) => c.includes('let s'));
  assert.ok(script, `脚本必须被执行；实际 jsEval 收到 ${JSON.stringify(seen)}`);
  // 关键：占位符已按规则求值 ⇒ 脚本里不再残留 {{ 与 ##
  assert.ok(!script.includes('{{'), `占位符必须被替换掉，不得残留：${JSON.stringify(script)}`);
  assert.ok(!script.includes('##'), `## 不得残留（残留会被 splitClean 切开截断）：${JSON.stringify(script)}`);
  assert.ok(script.includes('标题甲'), `必须求值出 h1 文本：${JSON.stringify(script)}`);
  // 且脚本语法必须成立（旧实现这里就是「Unexpected end of input」）
  assert.doesNotThrow(() => new Function(script), `脚本必须能解析：${JSON.stringify(script)}`);
  assert.equal(out, 'OUT:' + script);
});

test('#403 对偶：非规则形态的 {{n}} 仍走 jsEval（不被误当规则）', async () => {
  const seen: string[] = [];
  const out = await new AnalyzeRule(makeEnv(seen))
    .setContent(HTML, 'https://api.test/')
    .getString('@js:\nlet k={{n}};k');
  const script = seen.find((c) => c.includes('let k'));
  assert.ok(script, '脚本必须被执行');
  assert.ok(script.includes('let k=7;'), `数字占位符仍走 jsEval：${JSON.stringify(script)}`);
  assert.equal(out, 'OUT:' + script);
});

test('#403 对偶：{{baseUrl}} 这类 JS 标识符占位符仍走 jsEval（isRule=false）', async () => {
  const seen: string[] = [];
  await new AnalyzeRule(makeEnv(seen))
    .setContent(HTML, 'https://api.test/')
    .getString('@js:\nlet u="{{baseUrl}}";u');
  // baseUrl 由 bindings 提供（makeEnv 的 env 里没有 baseUrl 绑定 ⇒ jsEval 收到的是被求值器处理过的文本）
  const script = seen.find((c) => c.includes('let u'));
  assert.ok(script, `脚本必须被执行；seen=${JSON.stringify(seen)}`);
  assert.ok(!script.includes('{{baseUrl}}'), '占位符必须被处理（替换或置空），不得原样保留');
});
