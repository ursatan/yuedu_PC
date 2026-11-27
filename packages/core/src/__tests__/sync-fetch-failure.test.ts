/**
 * `#159` 回归锁：`curlSyncFetch` 的失败**必须分类**（spawn 级 vs 退出码级）。
 *
 * 背景：两类失败原来共用「静默 `body=''`」⇒ **「本机起不了 curl」伪装成「站点返回空」**。
 * 我据此把 ⚡Linpx 的失败误判成引擎缺陷（真因是本环境 spawn 恒 EBUSY）。
 * 判据来自 Node 文档 `execFileSync()` 的官方示例：以 `err.code` **是否有值**区分
 * 「spawn 失败」与「进程跑了但非零退出」。
 *
 * 这里用**合成错误对象**测纯函数 —— 不能靠真的去 spawn（本机可能起不来、别的机器能起来，
 * 那样测试会随环境红绿）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySyncFetchFailure } from '../selector/js';

/** (a) spawn 失败的真实形态（本机 2026-09-29 实测 + 文档示例） */
const spawnFailure = Object.assign(new Error('spawnSync curl EBUSY'), {
  code: 'EBUSY',
  errno: -4082,
  syscall: 'spawnSync curl',
  status: null,
  signal: null,
  stdout: undefined,
  stderr: undefined,
});

/** (b) 进程跑了、非零退出（例：curl `--max-time` 超时 = 28；文档示例走 else 分支） */
const exitFailure = Object.assign(new Error('Command failed: curl …'), {
  status: 28,
  signal: null,
  stdout: Buffer.from(''),
  stderr: Buffer.from('curl: (28) Operation timed out'),
});

test('spawn 失败（有 code）→ spawn', () => {
  assert.equal(classifySyncFetchFailure(spawnFailure), 'spawn');
});

test('非零退出（无 code、有 status）→ exit', () => {
  assert.equal(classifySyncFetchFailure(exitFailure), 'exit');
});

test('★ 两类必须**分得开**（防空转：这条红了说明分类已经退化成「永远同一类」）', () => {
  assert.notEqual(classifySyncFetchFailure(spawnFailure), classifySyncFetchFailure(exitFailure));
});

test('其它 spawn 级错误码同样归 spawn（ENOENT / EACCES）', () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    assert.equal(classifySyncFetchFailure({ code, status: null }), 'spawn', `${code} 应归 spawn`);
  }
});

test('边界：空串 code / 无 code / 非对象 一律当 exit（宁可少报，不要误报）', () => {
  assert.equal(classifySyncFetchFailure({ code: '', status: 1 }), 'exit');
  assert.equal(classifySyncFetchFailure({ code: undefined, status: 1 }), 'exit');
  assert.equal(classifySyncFetchFailure(new Error('plain')), 'exit');
  assert.equal(classifySyncFetchFailure(undefined), 'exit');
  assert.equal(classifySyncFetchFailure(null), 'exit');
  assert.equal(classifySyncFetchFailure('boom'), 'exit');
});
