/**
 * `#480` **目录章节循环微基准** —— 定位「爱淘小说（优++）detail 7.2s（1310 章）」的时间构成。
 * 分段：① getElements 一次 · ② 每章 new AnalyzeRule+setContent（构造+装内容）·
 * ③ 每章 getString('$.title')（JSON 求值）· ④ 每章 getString('@js:…')（JS 求值，桩）。
 * 跑法：node --import tsx tmp/bench-toc.mts
 */
import { AnalyzeRule, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const N = 1310;
const chapters = Array.from({ length: N }, (_, i) => ({
  title: `第${i + 1}章 测试章节标题`,
  cid: `cid_${100000 + i}`,
  bid: 'lc_110593',
  words: 3400 + i,
  modifiedOn: '2026-10-15 15:46',
}));
const content = { data: { chapterList: chapters } };
const BASE = 'http://tybook.taoyuewenhua.net/tf/chapter_list';

/** 爱淘真实 chapterUrl 脚本形态（{{}} 插值 + md5 桩） */
const JS_URL_RULE = `@js:
time=Date.now();
sign=java.md5Encode("appid=mibook&bid={{$.bid}}&cid={{$.cid}}&t="+time).toUpperCase();
"https://tybook.taoyuewenhua.net/tf/chapter_content?cid={{$.cid}}&sign="+sign;`;

const makeEnv = (): unknown =>
  ({
    baseUrl: BASE,
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
    jsEval: async (code: string, b: Record<string, unknown>) => {
      // 桩：模拟「插值 + java.md5Encode」的最低成本（真实在 Rhino/worker）
      const r = code
        .replace(/\{\{\$\.(\w+)\}\}/g, (_m, k) => String((b['result'] as Record<string, unknown>)?.[k] ?? ''))
        .replace(/java\.md5Encode\((.*?)\)\.toUpperCase\(\)/gs, () => 'A1B2C3D4E5F6'.repeat(2));
      // 取最后一行字符串字面量
      const lines = r.split('\n').map((l: string) => l.trim()).filter(Boolean);
      return (lines.at(-1) ?? '').replaceAll('"', '');
    },
    jsEvalSync: () => 'ok',
    toAbsolute: (u: string) => u,
  }) as never;

const env = makeEnv();
const t = (ms: number, n: number) => `${ms}ms 总 / ${(ms / n).toFixed(3)}ms 每章`;

// ① getElements 一次
{
  const t0 = performance.now();
  const ca = new AnalyzeRule(env as never).setContent(content, BASE);
  const els = await ca.getElements('$.data.chapterList');
  const ms = performance.now() - t0;
  console.log(`① getElements 一次（${els.length} 章）：`, t(ms, N));
}
// ② 构造 + setContent（不含 getString）
{
  const els = await new AnalyzeRule(env as never).setContent(content, BASE).getElements('$.data.chapterList');
  const t0 = performance.now();
  for (const el of els) new AnalyzeRule(env as never).setContent(el, BASE);
  const ms = performance.now() - t0;
  console.log(`② 每章 new AnalyzeRule + setContent：`, t(ms, N));
}
// ③ 构造 + setContent + getString('$.title')
{
  const els = await new AnalyzeRule(env as never).setContent(content, BASE).getElements('$.data.chapterList');
  const t0 = performance.now();
  let n = 0;
  for (const el of els) {
    const ea = new AnalyzeRule(env as never).setContent(el, BASE);
    const s = await ea.getString('$.title');
    if (s) n++;
  }
  const ms = performance.now() - t0;
  console.log(`③ 每章构造+setContent+getString('$.title')（非空 ${n}）：`, t(ms, N));
}
// ④ 再加 getString(JS URL 规则)
{
  const els = await new AnalyzeRule(env as never).setContent(content, BASE).getElements('$.data.chapterList');
  const t0 = performance.now();
  let n = 0;
  for (const el of els) {
    const ea = new AnalyzeRule(env as never).setContent(el, BASE);
    await ea.getString('$.title');
    const u = await ea.getString(JS_URL_RULE);
    if (u.startsWith('https://')) n++;
  }
  const ms = performance.now() - t0;
  console.log(`④ 每章 title + JS 签名 URL（合法 ${n}）：`, t(ms, N));
}
