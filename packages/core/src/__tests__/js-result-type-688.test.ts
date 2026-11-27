/**
 * `#688` **同一条含 JS 段的规则，两条路径给 JS 的 `result` 类型不同** —— 橙果短剧正文实测。
 *
 * 规则（源里原样）：`script[id="__NUXT_DATA__"]` + `<js>result.match(…m3u8…)</js>`
 * - **取值路径**（content / getString）：`result` 是脚本文本 ⇒ 正常解出 m3u8；
 * - **取元素路径**（列表字段 / getElements）：`result` 是元素集合 ⇒ `result.match is not a function`。
 *
 * 后者此前被归因表当成「引擎能力缺口 / 未实现 API」（因为规则里有 `not a function`），
 * 会把人引去翻 `capability-inventory` 找不存在的缺口。`#688` 把它拆成 `JS_RUNTIME`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { makeProbeEnv } from '../diag/probe';
import { diagnoseFailure } from '../diag/diagnose';

const NUXT =
  '<html><body><script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">'
  + '[["ShallowReactive",1],{"media":2},"https:\\u002F\\u002Fhls.example.cn\\u002Fv\\u002F8960412.m3u8?auth_key=1-2-0-3&v=3"]'
  + '</script></body></html>';

/** 源里的原样规则（`</js>` 必须闭合 —— 少写 `/` 会让整条退化成纯选择器，见 Y-①） */
const RULE = 'script[id="__NUXT_DATA__"]\n<js>\n'
  + ' const matches = result.match(/https:(?:\\\\u002F|\\/){2}[^"]+?\\.m3u8(?:\\?[^"]*)?/g) || [];\n'
  + 'result=matches[0]?.replace(/\\\\u002F/g, "/") || "";\n'
  + 'result\n  </js>';

const mk = () => {
  const { env } = makeProbeEnv({ content: NUXT, baseUrl: 'https://x/play/1', vars: {} } as never);
  return new AnalyzeRule(env).setContent(NUXT, 'https://x/play/1');
};

test('Z-① 取值路径：原样规则解出 m3u8（正文/播放链接就是这条路）', async () => {
  const v = await mk().getString(RULE);
  assert.equal(v, 'https://hls.example.cn/v/8960412.m3u8?auth_key=1-2-0-3&v=3');
  assert.deepEqual(await mk().getStringList(RULE), [v]);
});

test('Z-② 结尾少写 `/`（`<js>` 而非 `</js>`）⇒ 整条退化成纯选择器，静默 0 命中', async () => {
  const broken = RULE.replace('</js>', '<js>');
  assert.equal(await mk().getString(broken), '', '这是用户实际踩到的坑：JS 段没闭合');
});

test('Z-③ 取元素路径：`result` 是元素集合 ⇒ `result.match` 抛错（与上游一致）', async () => {
  await assert.rejects(() => mk().getElements(RULE), /is not a function/);
});

test('Z-④ 这个错归 `JS_RUNTIME`（规则类型用错），不是 `UNSUPPORTED`（引擎缺 API）', () => {
  const d = diagnoseFailure({ error: 'result.match is not a function｜运行期 1:24' });
  assert.equal(d?.code, 'JS_RUNTIME');
  assert.match(d?.title ?? '', /JS/);
  assert.match(String(d?.next?.join(' ')), /String\(result\)|textContent|取值字段|查看器/);
  // 引擎真的缺 API 时仍归 UNSUPPORTED
  assert.equal(diagnoseFailure({ error: 'doc.selectFirst is not a function' })?.code, 'UNSUPPORTED');
});

test('Z-⑤ 加固写法：先统一成字符串，两条路径都不炸', async () => {
  const safe = 'script[id="__NUXT_DATA__"]\n<js>\n'
    + 'const h = typeof result === "string" ? result : (Array.isArray(result) ? result.map(x => x.textContent ?? "").join("") : String(result ?? ""));\n'
    + 'const m = h.match(/https:(?:\\\\u002F|\\/){2}[^"]+?\\.m3u8(?:\\?[^"]*)?/g) || [];\n'
    + 'm[0]?.replace(/\\\\u002F/g, "/") || ""\n</js>';
  assert.equal(await mk().getString(safe), 'https://hls.example.cn/v/8960412.m3u8?auth_key=1-2-0-3&v=3');
  await assert.doesNotReject(() => mk().getElements(safe), '取元素路径不再抛类型错');
});
