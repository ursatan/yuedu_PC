/**
 * `B6` 书源体检口径锁：五态判定、质量分推导、`dead` 3 天跳过与落库。
 *
 * 判错的方向都有用户可见后果：把 `degraded` 判成 `broken` ⇒ 好源被压到最底；
 * `dead` 不落 `deadUntil` ⇒ 坏源每次体检/搜索都再撞一次；质量分越界 ⇒ 排序结果翻转。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SOURCE_DEAD_SKIP_MS } from '@yuedu/core';
import type { VerifyOutcome } from '@yuedu/facade';
import { computeSourceHealth, createSourceHealthStore } from '../source-health';

function outcome(patch: Partial<VerifyOutcome>): VerifyOutcome {
  return { ok: true, message: '通过', respondTime: 500, stages: {}, ...patch };
}

const NOW = 1_700_000_000_000;

test('五态 · ok：全通过且不慢', () => {
  const h = computeSourceHealth(outcome({ stages: { domain: { ok: true }, search: { ok: true } } }), null, NOW);
  assert.equal(h.state, 'ok');
  assert.equal(h.quality, 100);
  assert.equal(h.consecutiveFailures, 0);
  assert.equal(h.deadUntil, undefined);
});

test('五态 · slow：全通过但响应 ≥ 2500ms（扣 15 分）', () => {
  const h = computeSourceHealth(
    outcome({ respondTime: 2600, stages: { domain: { ok: true }, search: { ok: true } } }),
    null,
    NOW,
  );
  assert.equal(h.state, 'slow');
  assert.equal(h.quality, 85);
});

test('五态 · degraded：搜索通过、正文失败（核心可用，扣正文 6 分）', () => {
  const h = computeSourceHealth(
    outcome({
      ok: false,
      message: '正文为空',
      respondTime: 800,
      stages: { domain: { ok: true }, search: { ok: true }, info: { ok: true }, toc: { ok: true }, content: { ok: false, error: '空' } },
    }),
    null,
    NOW,
  );
  assert.equal(h.state, 'degraded');
  assert.equal(h.quality, 64);
  assert.equal(h.consecutiveFailures, 1);
});

test('五态 · broken：搜索（核心）失败', () => {
  const h = computeSourceHealth(
    outcome({ ok: false, message: '搜索 0 条', stages: { domain: { ok: true }, search: { ok: false, error: '0 条' } } }),
    null,
    NOW,
  );
  assert.equal(h.state, 'broken');
  assert.equal(h.quality, 35);
});

test('五态 · dead：域名不可达立刻判死，并落 3 天跳过截止时间', () => {
  const h = computeSourceHealth(
    outcome({ ok: false, message: 'ENOTFOUND', stages: { domain: { ok: false, error: 'ENOTFOUND' } } }),
    null,
    NOW,
  );
  assert.equal(h.state, 'dead');
  assert.equal(h.quality, 0);
  assert.equal(h.deadUntil, NOW + SOURCE_DEAD_SKIP_MS);
  assert.match(String(h.message), /域名不可达/);
});

test('五态 · dead：连续失败第 3 次才判死（前两次仍是 broken，避免误杀）', () => {
  const broken = outcome({ ok: false, message: '超时', stages: { domain: { ok: true }, search: { ok: false } } });
  const first = computeSourceHealth(broken, null, NOW);
  const second = computeSourceHealth(broken, first, NOW + 1000);
  const third = computeSourceHealth(broken, second, NOW + 2000);
  assert.equal(first.state, 'broken');
  assert.equal(second.state, 'broken');
  assert.equal(second.quality, 35);
  assert.equal(third.state, 'dead');
  assert.equal(third.deadUntil, NOW + 2000 + SOURCE_DEAD_SKIP_MS);
});

test('五态 · 连续失败在通过一次后清零（复检恢复不会被旧计数拖死）', () => {
  const broken = outcome({ ok: false, stages: { domain: { ok: true }, search: { ok: false } } });
  const okOutcome = outcome({ stages: { domain: { ok: true }, search: { ok: true } } });
  const first = computeSourceHealth(broken, null, NOW);
  const second = computeSourceHealth(broken, first, NOW + 1000);
  const recovered = computeSourceHealth(okOutcome, second, NOW + 2000);
  assert.equal(recovered.state, 'ok');
  assert.equal(recovered.consecutiveFailures, 0);
  // 恢复后再失败一次，计数从 1 重新开始（不是接着 3 直接判死）
  const again = computeSourceHealth(broken, recovered, NOW + 3000);
  assert.equal(again.state, 'broken');
  assert.equal(again.consecutiveFailures, 1);
});

test('落库 · 写入可重载；`dead` 跳过期内 active，过期后自动释放', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-health-'));
  try {
    const file = path.join(dir, 'source-health.json');
    const store = createSourceHealthStore(file);
    store.apply(
      'dead-src',
      outcome({ ok: false, message: '503', stages: { domain: { ok: false, error: '503' } } }),
      NOW,
    );
    store.apply('ok-src', outcome({ stages: { domain: { ok: true }, search: { ok: true } } }), NOW);

    assert.equal(store.isDeadActive('dead-src', NOW + 1000), true);
    assert.equal(store.isDeadActive('ok-src', NOW + 1000), false);
    assert.equal(store.isDeadActive('missing', NOW), false);
    assert.equal(store.isDeadActive('dead-src', NOW + SOURCE_DEAD_SKIP_MS + 1), false, '3 天后过期');

    // 重新从磁盘加载（模拟服务端重启）
    const reloaded = createSourceHealthStore(file);
    assert.equal(reloaded.get('dead-src')?.state, 'dead');
    assert.equal(reloaded.get('dead-src')?.quality, 0);
    assert.equal(reloaded.get('ok-src')?.quality, 100);
    assert.deepEqual(
      reloaded.list().map((it) => it.id),
      ['dead-src', 'ok-src'],
    );

    reloaded.remove('ok-src');
    assert.equal(createSourceHealthStore(file).get('ok-src'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('落库 · 损坏文件不抛错，从空表开始', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-health-'));
  try {
    const file = path.join(dir, 'source-health.json');
    fs.writeFileSync(file, '{broken json', 'utf-8');
    const store = createSourceHealthStore(file);
    assert.equal(store.list().length, 0);
    store.apply('a', outcome({}), NOW);
    const reloaded = createSourceHealthStore(file);
    assert.equal(reloaded.get('a')?.state, 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
