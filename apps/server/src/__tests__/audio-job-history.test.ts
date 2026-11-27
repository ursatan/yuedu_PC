/**
 * 音频任务历史回归锁（B2 方案 2：只落失败/取消，7 天 / 200 条）。
 *
 * 为什么值得单测：
 *  · 「重启后仍能查到失败原因」只有落盘 + 重新读回才能证明；
 *  · 淘汰策略（TTL / 条数 / 同章去重）一旦写反，历史会静默变成「只有最近一条」或无限增长，
 *    而这类问题在运行面很难被发现（用户只是觉得「记录不全」）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AUDIO_JOB_HISTORY_MAX,
  AUDIO_JOB_HISTORY_TTL_MS,
  createAudioJobHistory,
  type AudioJobHistoryInput,
} from '../audio-job-history';

function withFile(fn: (file: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'yuedu-audio-history-'));
  try {
    fn(join(dir, 'audio-job-history.json'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function job(id: string, over: Partial<AudioJobHistoryInput> = {}): AudioJobHistoryInput {
  return {
    id,
    bookUrl: 'https://example.com/book',
    chapterUrl: `https://example.com/${id}.mp3`,
    title: `第 ${id} 章`,
    mode: 'manual',
    status: 'error',
    error: 'UPSTREAM_403',
    bytes: 0,
    totalBytes: 1024,
    startedAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

test('只落失败/取消：done / unsupported / queued 不写历史', () => {
  withFile((file) => {
    const h = createAudioJobHistory({ file, now: () => 10_000 });
    assert.equal(h.record(job('a', { status: 'done' })), null);
    assert.equal(h.record(job('b', { status: 'unsupported', error: '流式源不支持离线' })), null);
    assert.equal(h.record(job('c', { status: 'queued' })), null);
    assert.equal(h.list().length, 0);
    assert.equal(existsSync(file), false, '没有失败任务时不应该创建文件');

    const ok = h.record(job('d', { status: 'cancelled', error: '', updatedAt: 9000 }));
    assert.equal(ok?.status, 'cancelled');
    assert.equal(ok?.error, '已取消', '取消没有原因时补默认文案');
    assert.equal(h.list().length, 1);
  });
});

test('重启可见：新实例读回同一条失败原因', () => {
  withFile((file) => {
    const first = createAudioJobHistory({ file, now: () => 10_000 });
    first.record(job('a', { updatedAt: 9_000, error: 'UPSTREAM_403' }));
    first.record(job('b', { updatedAt: 9_500, status: 'cancelled', error: '已取消' }));

    // 文件确实落盘（重启不依赖内存）
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { jobs: Array<{ id: string }> };
    assert.deepEqual(raw.jobs.map((j) => j.id), ['b', 'a'], '按时间倒序落盘');

    // 新实例（模拟服务重启）
    const again = createAudioJobHistory({ file, now: () => 10_000 });
    const list = again.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, 'b');
    assert.equal(list[0]?.status, 'cancelled');
    assert.equal(list[1]?.id, 'a');
    assert.equal(list[1]?.error, 'UPSTREAM_403', '重启后仍能看到失败原因');
  });
});

test('同章去重：同一 id 只留最新一条（不会把历史挤成重复）', () => {
  withFile((file) => {
    let now = 1000;
    const h = createAudioJobHistory({ file, now: () => now });
    h.record(job('a', { updatedAt: 1000, error: 'UPSTREAM_500' }));
    now = 2000;
    h.record(job('a', { updatedAt: 2000, error: 'QUOTA' }));
    const list = h.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.error, 'QUOTA');
    assert.equal(list[0]?.updatedAt, 2000);
  });
});

test('7 天淘汰：加载与写入时都丢掉过期条目', () => {
  withFile((file) => {
    const now = 10 * AUDIO_JOB_HISTORY_TTL_MS;
    const h = createAudioJobHistory({ file, now: () => now });
    h.record(job('old', { updatedAt: now - AUDIO_JOB_HISTORY_TTL_MS - 1 }));
    h.record(job('edge', { updatedAt: now - AUDIO_JOB_HISTORY_TTL_MS }));
    h.record(job('fresh', { updatedAt: now - 60_000 }));
    assert.deepEqual(h.list().map((j) => j.id), ['fresh', 'edge'], '超过 7 天的丢弃，边界保留');

    // 重新加载同样按当前时间裁剪
    const again = createAudioJobHistory({ file, now: () => now });
    assert.deepEqual(again.list().map((j) => j.id), ['fresh', 'edge']);
  });
});

test('200 条上限：过量写入只留最近 200 条，且淘汰最旧', () => {
  withFile((file) => {
    const now = 1_000_000;
    const h = createAudioJobHistory({ file, now: () => now });
    const total = AUDIO_JOB_HISTORY_MAX + 50;
    for (let i = 0; i < total; i += 1) {
      h.record(job(`c${i}`, { updatedAt: now - total + i }));
    }
    const list = h.list();
    assert.equal(list.length, AUDIO_JOB_HISTORY_MAX);
    assert.equal(list[0]?.id, `c${total - 1}`, '最新一条在最前');
    assert.equal(list[list.length - 1]?.id, `c${total - AUDIO_JOB_HISTORY_MAX}`, '最旧的 50 条被淘汰');

    // 重启后仍然是 200 条（上限不依赖内存）
    const again = createAudioJobHistory({ file, now: () => now });
    assert.equal(again.list().length, AUDIO_JOB_HISTORY_MAX);
    assert.equal(again.list()[0]?.id, `c${total - 1}`);
  });
});

test('查询：按 bookUrl 精确过滤，limit 截断', () => {
  withFile((file) => {
    const h = createAudioJobHistory({ file, now: () => 5000 });
    h.record(job('a', { bookUrl: 'book-1', updatedAt: 1000 }));
    h.record(job('b', { bookUrl: 'book-1', updatedAt: 2000 }));
    h.record(job('c', { bookUrl: 'book-2', updatedAt: 3000 }));
    assert.deepEqual(h.list({ bookUrl: 'book-1' }).map((j) => j.id), ['b', 'a']);
    assert.deepEqual(h.list().map((j) => j.id), ['c', 'b', 'a']);
    assert.deepEqual(h.list({ limit: 2 }).map((j) => j.id), ['c', 'b']);
    assert.deepEqual(h.list({ bookUrl: 'book-2' }).map((j) => j.id), ['c']);
  });
});

test('坏文件/坏条目不影响启动：跳过并从空历史继续', () => {
  withFile((file) => {
    writeFileSync(file, '{ not json', 'utf8');
    const h = createAudioJobHistory({ file, now: () => 5000 });
    assert.equal(h.list().length, 0);

    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        jobs: [
          { id: 'good', status: 'error', error: 'IO', updatedAt: 4000 },
          { id: '', status: 'error', updatedAt: 4000 },
          { id: 'bad-status', status: 'done', updatedAt: 4000 },
          null,
        ],
      }),
      'utf8',
    );
    const again = createAudioJobHistory({ file, now: () => 5000 });
    assert.deepEqual(again.list().map((j) => j.id), ['good']);
  });
});
