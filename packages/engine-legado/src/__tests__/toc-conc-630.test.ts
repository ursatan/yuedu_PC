/**
 * `#630` 目录并发「按路由选档」的回归锁（纯函数，无网络）。
 *
 * 2026-10-26c **默认已回退**：不开自适应时并发固定 4（`#509` 的结论），
 * `YUEDU_TOC_CONC=auto` 才探测。下面的断言同时锁住「回退」和「开关可用」两件事 ——
 * 只锁自适应会把「默认值被悄悄改回去」放过，那正是用户这次踩的坑。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOC_ADAPT_MIN_CHAPTERS,
  TOC_CONC_HARD_MAX,
  TOC_CONC_L1,
  TOC_CONC_WORKER_DEFAULT,
  parseConcMode,
  parseMaxWorkerConc,
  resolveTocConc,
} from '../model/toc-concurrency';

test('#630 默认（未设 env）⇒ 固定 conc=4，绝不自适应', () => {
  for (const raw of [undefined, '', '   ', '0', 'abc', '-3']) {
    const mode = parseConcMode(raw);
    assert.equal(mode.kind, 'fixed', `raw=${String(raw)} 应回落固定模式`);
    assert.equal(resolveTocConc({ mode, chapters: 1612 }).conc, TOC_CONC_L1);
  }
});

test('#630 显式 YUEDU_TOC_CONC=auto 才进入自适应', () => {
  assert.equal(parseConcMode('auto').kind, 'auto');
  assert.equal(parseConcMode('AUTO').kind, 'auto');
  assert.equal(parseConcMode(' auto ').kind, 'auto');
});

test('#630 显式数字 ⇒ 固定该值（调优/回退通道）', () => {
  const m = parseConcMode('8');
  assert.equal(m.kind, 'fixed');
  assert.equal(resolveTocConc({ mode: m, chapters: 1612 }).conc, 8);
  const m2 = parseConcMode('2.9');
  assert.equal(m2.kind === 'fixed' ? m2.conc : -1, 2);
});

test('#630 auto + 短目录不探测，用 4', () => {
  const d = resolveTocConc({ mode: { kind: 'auto' }, chapters: TOC_ADAPT_MIN_CHAPTERS - 1, probe: { l1: 0, worker: 5 } });
  assert.equal(d.route, 'short');
  assert.equal(d.conc, TOC_CONC_L1);
});

test('#630 auto + worker 路由（worker 涨、L1 没涨）⇒ 上限档 16', () => {
  const d = resolveTocConc({ mode: { kind: 'auto' }, chapters: 1612, probe: { l1: 0, worker: 6 } });
  assert.equal(d.route, 'worker');
  assert.equal(d.conc, TOC_CONC_WORKER_DEFAULT);
});

test('#630 auto + L1 路由 ⇒ 保持 4（混合也算 L1，最保守）', () => {
  assert.equal(resolveTocConc({ mode: { kind: 'auto' }, chapters: 1612, probe: { l1: 6, worker: 0 } }).conc, TOC_CONC_L1);
  assert.equal(resolveTocConc({ mode: { kind: 'auto' }, chapters: 1612, probe: { l1: 1, worker: 5 } }).conc, TOC_CONC_L1);
});

test('#630 auto + 拿不到统计 / 探测章无 JS 求值 ⇒ 4', () => {
  assert.equal(resolveTocConc({ mode: { kind: 'auto' }, chapters: 1612 }).route, 'unknown');
  assert.equal(resolveTocConc({ mode: { kind: 'auto' }, chapters: 1612 }).conc, TOC_CONC_L1);
  const none = resolveTocConc({ mode: { kind: 'auto' }, chapters: 1612, probe: { l1: 0, worker: 0 } });
  assert.equal(none.route, 'unknown');
  assert.equal(none.conc, TOC_CONC_L1);
});

test('#630 YUEDU_TOC_CONC_MAX 覆盖 worker 档，并 clamp 到 1~64', () => {
  const mode = { kind: 'auto' as const };
  assert.equal(resolveTocConc({ mode, chapters: 1612, probe: { l1: 0, worker: 1 }, maxWorkerConc: '8' }).conc, 8);
  assert.equal(resolveTocConc({ mode, chapters: 1612, probe: { l1: 0, worker: 1 }, maxWorkerConc: '999' }).conc, TOC_CONC_HARD_MAX);
  assert.equal(resolveTocConc({ mode, chapters: 1612, probe: { l1: 0, worker: 1 }, maxWorkerConc: '0' }).conc, TOC_CONC_WORKER_DEFAULT);
  assert.equal(parseMaxWorkerConc('abc'), TOC_CONC_WORKER_DEFAULT);
  assert.equal(parseMaxWorkerConc(undefined), TOC_CONC_WORKER_DEFAULT);
  assert.equal(parseMaxWorkerConc('2.7'), 2);
});
