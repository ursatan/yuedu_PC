/**
 * M4 worker 池沙箱测试 —— 覆盖：
 *  1. 基本表达式求值
 *  2. 结果约定（result 赋值 / 单表达式）
 *  3. bindings 注入（key / page / $ / baseUrl）
 *  4. java 桩（base64 / md5）
 *  5. 硬超时：死循环脚本被 terminate，且池自动补位可继续服务
 *  6. 并发：超过池大小的并行求值全部完成（FIFO 排队）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';

test('sandbox: 单表达式直接返回值', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  assert.equal(await pool.eval<number>({ code: '1+2' }), 3);
  assert.equal(await pool.eval<string>({ code: "'a'+'b'" }), 'ab');
});

test('sandbox: 语句脚本返回 result 变量（对齐 Legado）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const r = await pool.eval<string>({ code: 'result = "x" + 1;' });
  assert.equal(r, 'x1');
});

test('sandbox: bindings 注入（key/page/baseUrl/$）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const r = await pool.eval<string>({
    code: 'key + "-" + page + "-" + baseUrl',
    bindings: { key: '剑来', page: 3, baseUrl: 'https://x.com/' },
  });
  assert.equal(r, '剑来-3-https://x.com/');
});

test('sandbox: java 桩 base64/md5 在 worker 内可用', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  assert.equal(await pool.eval<string>({ code: 'java.base64Encode("ab")' }), 'YWI=');
  assert.equal(await pool.eval<string>({ code: 'java.md5Encode("a")' }), '0cc175b9c0f1b6a831c399e269772661');
});

test('sandbox: 硬超时 terminate 死循环脚本，池补位后继续可用', async () => {
  const pool = createWorkerSandboxPool({ size: 1, defaultTimeoutMs: 300 });
  await assert.rejects(
    () => pool.eval({ code: 'while(true){}', timeoutMs: 300 }),
    (e: Error) => e.name === 'EngineError' || /TIMEOUT|timeout/i.test(e.message),
  );
  // 池已补位：下一个求值正常
  // ⚠️ 必须显式给足超时：池的 defaultTimeoutMs=300 是给死循环用的，
  //    全量并行跑测试时 CPU 抖动会让 40+2 也超过 300ms → 误报（曾在整轮套件里偶发失败）
  assert.equal(await pool.eval<number>({ code: '40+2', timeoutMs: 10_000 }), 42);
});

test('sandbox: 并发超过池大小仍全部完成（排队）', async () => {
  const pool = createWorkerSandboxPool({ size: 2 });
  const jobs = Array.from({ length: 8 }, (_, i) => pool.eval<number>({ code: `1+${i}` }));
  const out = await Promise.all(jobs);
  assert.deepEqual(out, Array.from({ length: 8 }, (_, i) => 1 + i));
});

test('sandbox: 脚本抛错时错误信息回传宿主', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  await assert.rejects(() => pool.eval({ code: 'throw new Error("boom")' }), /boom/);
});
