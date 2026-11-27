/**
 * `#614` `java.queryTTF / queryBase64TTF / replaceFont` 的**接线**测试（L1 + worker 宿主 RPC）
 *
 * 算法层已在 `font-614.test.ts` 验过；这一层要验的是「接线语义」：
 *  ① 三种入参形态（base64 / 字节 / url）都通，且 url 走的是**二进制**通路（不能被 utf-8 解码毁掉）；
 *  ② 缓存按**入参**算键（上游 `data.toByteArray()`）⇒ 第二次 `queryTTF(url)` 不再发请求；
 *  ③ worker 侧拿到的是句柄 `{__ttfId}`，`replaceFont` 能按句柄取回真对象（跨 RPC 的协议）；
 *  ④ 坏入参要**说清**是「既不是 URL 也不是 base64」，而不是静默返回。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator, createJsEvaluator, hostRpc } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { TTF_CORRECT, TTF_OBFUSCATED, b64 } from './fixtures/ttf-fixture';

const CORRECT_B64 = b64(TTF_CORRECT);
const OBF_B64 = b64(TTF_OBFUSCATED);

/** L1 求值器（`syncFetch` 打桩；`bytes` 只在 `binary` 请求时回） */
function l1(syncFetch?: (req: { binary?: boolean; url: string }) => unknown) {
  return createJsEvaluator({
    variables: createVariableStore(),
    ...(syncFetch
      ? {
          syncFetch: (req: { binary?: boolean; url: string }) =>
            syncFetch(req) as { status: number; headers: Record<string, string>; setCookie: string[]; body: string },
        }
      : {}),
  } as never);
}

test('#614 L1：base64 入参 → replaceFont 还原文字（上游 `queryBase64TTF` 用法）', () => {
  const ev = l1();
  const out = ev(
    `(function(){
       var err = java.queryBase64TTF(${JSON.stringify(OBF_B64)});
       var corr = java.queryTTF(${JSON.stringify(CORRECT_B64)});
       return java.replaceFont('一丁', err, corr, false);
     })()`,
    {},
  );
  assert.equal(String(out), '丁一');
});

test('#614 L1：filter=true 删掉错误字体里没有轮廓的字符', () => {
  const ev = l1();
  const out = ev(
    `java.replaceFont('一X丁', java.queryTTF(${JSON.stringify(OBF_B64)}), java.queryTTF(${JSON.stringify(CORRECT_B64)}), true)`,
    {},
  );
  assert.equal(String(out), '丁一');
});

test('#614 L1：url 入参走**二进制**通路，且第二次命中缓存不再发请求', () => {
  const seen: Array<{ url: string; binary?: boolean }> = [];
  const ev = l1((req) => {
    seen.push({ url: req.url, ...(req.binary ? { binary: true } : {}) });
    // 关键：只回 bytes、不回 body（文本通路拿到的是空串 ⇒ 若实现错走文本，解析会失败）
    return { status: 200, headers: {}, setCookie: [], body: '', bytes: TTF_CORRECT };
  });
  const out = ev(
    `(function(){
       var a = java.queryTTF('https://cdn.example/font.ttf');
       var b = java.queryTTF('https://cdn.example/font.ttf');
       return String(a.numGlyphs) + '/' + String(b.numGlyphs);
     })()`,
    {},
  );
  assert.equal(String(out), '3/3', '两次都拿到了字体（第二次来自缓存）');
  assert.equal(seen.length, 1, '同一 url 第二次不该再发请求（缓存键按入参算，上游语义）');
  assert.equal(seen[0]!.binary, true, '字体必须走二进制通路（utf-8 解码会毁字节）');
});

test('#614 L1：字节入参（Uint8Array）也支持', () => {
  const ev = l1();
  // 用 base64 解码出字节再传（模拟源脚本从 ArrayBuffer/ByteArray 拿到的场景）
  const out = ev(
    `(function(){
       var bytes = java.base64DecodeToByteArray(${JSON.stringify(OBF_B64)});
       return java.replaceFont('一丁', java.queryTTF(bytes), java.queryTTF(${JSON.stringify(CORRECT_B64)}), false);
     })()`,
    {},
  );
  assert.equal(String(out), '丁一');
});

test('#614 L1：坏入参说清原因（既不是 URL 也不是 base64）', () => {
  const ev = l1();
  assert.throws(() => ev(`java.queryTTF('这不是字体也不是地址!!!')`, {}), /既不是 http\(s\) 地址也不是 base64/);
  // 空串 ⇒ 上游语义 return null（不抛）
  assert.equal(String(ev(`String(java.queryTTF(''))`, {})), 'null');
});

test('#614 worker 协议：queryTTF 回句柄，replaceFont 按句柄取回（宿主 RPC）', async () => {
  // worker 里不能拿带方法的对象 ⇒ 宿主返回 {__ttfId}；这里直接验这条协议
  const h1 = (await hostRpc(undefined, 'queryTTF', { data: OBF_B64, useCache: true })) as { __ttfId?: string };
  const h2 = (await hostRpc(undefined, 'queryBase64TTF', { data: CORRECT_B64 })) as { __ttfId?: string };
  assert.match(String(h1?.__ttfId), /^ttf\d+$/, '必须回句柄');
  assert.match(String(h2?.__ttfId), /^ttf\d+$/);
  assert.notEqual(h1.__ttfId, h2.__ttfId, '两只字体必须是不同句柄');

  const text = await hostRpc(undefined, 'replaceFont', {
    text: '一丁',
    errId: h1.__ttfId,
    corrId: h2.__ttfId,
    filter: false,
  });
  assert.equal(String(text), '丁一');

  // 句柄不存在（被淘汰/没传）⇒ 同上游「字体为 null ⇒ 原样返回」，不抛
  assert.equal(
    String(await hostRpc(undefined, 'replaceFont', { text: '一丁', errId: 'ttfX', corrId: 'ttfY', filter: true })),
    '一丁',
  );
});

test('#614 worker 真跑：句柄协议在 worker 线程里也成立（否则该源进 worker 就静默失效）', async () => {
  const variables = createVariableStore();
  const raw = createWorkerSandboxPool();
  let evals = 0;
  const pool = new Proxy(raw as unknown as Record<string, unknown>, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => {
          evals += 1;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ReturnType<typeof createWorkerSandboxPool>;

  const ev = createHybridJsEvaluator({
    variables,
    pool,
    // `java.ajax` 触发 worker 路由（与既有 worker 用例同一手法）
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  } as never);
  const out = await Promise.resolve(
    ev(
      `java.ajax('https://h.test/x');
       java.replaceFont('一丁', java.queryBase64TTF(${JSON.stringify(OBF_B64)}), java.queryTTF(${JSON.stringify(CORRECT_B64)}), false)`,
      {},
    ),
  );
  assert.equal(String(out), '丁一');
  assert.ok(evals > 0, '必须真走 worker 池（否则测的是 L1，等于空转）');
});
