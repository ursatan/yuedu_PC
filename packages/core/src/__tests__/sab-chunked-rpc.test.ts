/**
 * 回归锁：#105 —— **RPC 大结果分片回传**（> 单块 SAB 容量）。
 *
 * ## 背景
 *
 * worker 与宿主之间的同步 RPC 靠一块 SharedArrayBuffer 来回传值（worker 用 `Atomics.wait`
 * 阻塞等宿主回填）。SAB 是固定大小的，旧实现超限时**直接丢成错误**
 * `rpc result exceeds SAB` —— 真实后果是媒体源必然失败：
 * 实测 🔊枫叶音乐盒正文 `<js>var resp = java.get(clean, headers); …</js>`（音频 body > 4MB）
 * 报 `RULE_PARSE@parse | rpc result exceeds SAB`。
 *
 * ## 本测试锁住的行为
 *
 * 1. **超过容量**（5.2MB > 4MB）→ 分片回传，数据**完整、有序、不截断**（首/中/尾都校验）；
 * 2. **未超容量** → 仍走单片路径（同一份断言，确保分片没有把常规路径带坏）；
 * 3. 分片是**同一块 SAB 反复写 + 握手位交替**，不是新建通道 —— 因为 worker 正卡在
 *    `Atomics.wait` 里收不到 postMessage（见 `sabReply` 的注释）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

function countingPool(raw: ReturnType<typeof createWorkerSandboxPool>) {
  const st = { evals: 0 };
  const pool = new Proxy(raw as unknown as Record<string, unknown>, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => {
          st.evals++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ReturnType<typeof createWorkerSandboxPool>;
  return { pool, st };
}

const UNIT = 'ABCDEFGHIJ';
/** 造一个「有位置特征」的大 body：错位/截断都能被首中尾断言抓到（比只比 .length 强） */
function bigBody(units: number): string {
  return UNIT.repeat(units);
}
/** 脚本内只回传小结果（长度 + 首/中/尾片段），把分片严格限制在 `java.ajax` 这一次回传上 */
const PROBE = (url: string) =>
  `var r = String(java.ajax(${JSON.stringify(url)})); ` +
  'var mid = Math.floor(r.length / 2); ' +
  'JSON.stringify({n: r.length, head: r.slice(0, 10), mid: r.slice(mid, mid + 10), tail: r.slice(-10)})';

function assertIntact(raw: string, expected: string, label: string): void {
  const r = JSON.parse(raw) as { n: number; head: string; mid: string; tail: string };
  const mid = Math.floor(expected.length / 2);
  assert.equal(r.n, expected.length, `${label}: 长度必须一致（分片丢/重复都会在这里暴露）`);
  assert.equal(r.head, expected.slice(0, 10), `${label}: 首片内容`);
  assert.equal(r.mid, expected.slice(mid, mid + 10), `${label}: 中间片内容（错位会在这里暴露）`);
  assert.equal(r.tail, expected.slice(-10), `${label}: 尾片内容（末尾截断会在这里暴露）`);
}

test('#105 分片：5.2MB 的 java.ajax 回传必须完整（旧实现报 rpc result exceeds SAB）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const big = bigBody(520_000); // 5.2MB > SAB 4MB → 触发分片
  assert.ok(big.length > 4 * 1024 * 1024, '本用例必须真的超过单块 SAB 容量');
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    http: async () => ({ status: 200, headers: {}, body: big }),
  });
  try {
    const out = await Promise.resolve(ev(PROBE('https://h.test/big'), {}));
    assert.ok(st.evals > 0, '必须真的走 worker 池（否则是 L1 空转）');
    assertIntact(String(out), big, '分片回传');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});

test('#105 分片：未超容量仍走单片路径（分片不得带坏常规路径）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const small = bigBody(50_000); // 500KB ≪ 4MB → 单片
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    http: async () => ({ status: 200, headers: {}, body: small }),
  });
  try {
    const out = await Promise.resolve(ev(PROBE('https://h.test/small'), {}));
    assert.ok(st.evals > 0, '必须真的走 worker 池');
    assertIntact(String(out), small, '单片回传');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});

test('#105 分片：连续两次大回传互不污染（握手位与片号必须复位）', async () => {
  const { pool } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const a = bigBody(430_000); // 4.3MB
  const b = bigBody(610_000); // 6.1MB（片数不同，能暴露「总片数没复位」这类错）
  let n = 0;
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    http: async () => ({ status: 200, headers: {}, body: n++ === 0 ? a : b }),
  });
  try {
    assertIntact(String(await Promise.resolve(ev(PROBE('https://h.test/1'), {}))), a, '第一次大回传');
    assertIntact(String(await Promise.resolve(ev(PROBE('https://h.test/2'), {}))), b, '第二次大回传');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});
