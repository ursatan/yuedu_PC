/**
 * `#208` 阅读进度（远端形态 + 只前进不后退）单测。
 *
 * 对照上游 `BookProgress.kt` 与 `AppWebDav.kt:308-337`。
 * ★ 防空转约定：每个「拒绝/回落」用例旁都有能通过的对照。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bookProgressOf,
  isProgressAhead,
  mergeBookProgress,
  parseBookProgress,
  sameProgress,
  type BookProgress,
} from '../book-progress';

function p(over: Partial<BookProgress> = {}): BookProgress {
  return {
    name: '书名',
    author: '作者',
    durChapterIndex: 3,
    durChapterPos: 10,
    durChapterTime: 1000,
    durChapterTitle: '第三章',
    ...over,
  };
}

test('#208 bookProgressOf：从书架记录投影出 6 字段（title 空 → null）', () => {
  const out = bookProgressOf({
    name: '甲',
    author: '乙',
    durChapterIndex: 2,
    durChapterPos: 5,
    durChapterTime: 99,
    durChapterTitle: null,
  });
  assert.deepEqual(out, {
    name: '甲',
    author: '乙',
    durChapterIndex: 2,
    durChapterPos: 5,
    durChapterTime: 99,
    durChapterTitle: null,
  });
  assert.equal(Object.keys(out).length, 6, '恰 6 字段（对齐上游 BookProgress）');
});

test('#208 parseBookProgress：合法 json 解得出；任一处不对 ⇒ null（不做「尽力修复」）', () => {
  const good = parseBookProgress(JSON.stringify(p()));
  assert.ok(good);
  if (good) assert.equal(good.durChapterIndex, 3);

  // 对照：前提是「同一段文本只是换个坏法」⇒ 必须都拒
  const bads: string[] = [
    '',
    '   ',
    'not json',
    '[1,2]',
    'null',
    JSON.stringify({ ...p(), name: 1 }), // 名字不是字符串
    JSON.stringify({ ...p(), author: undefined }), // 缺作者
    JSON.stringify({ ...p(), durChapterIndex: '3' }), // 索引是字符串
    JSON.stringify({ ...p(), durChapterPos: Number.NaN }),
  ];
  for (const b of bads) assert.equal(parseBookProgress(b), null, b);

  // durChapterTitle 缺失/非字符串 ⇒ 按 null 处理（上游可空）
  const noTitle = parseBookProgress(JSON.stringify({ ...p(), durChapterTitle: undefined }));
  assert.equal(noTitle?.durChapterTitle, null);
});

test('#208 isProgressAhead：只看 (index, pos)，时间不参与', () => {
  assert.equal(isProgressAhead(p({ durChapterIndex: 4 }), p({ durChapterIndex: 3 })), true, '章节更远');
  assert.equal(
    isProgressAhead(p({ durChapterIndex: 3, durChapterPos: 11 }), p({ durChapterIndex: 3, durChapterPos: 10 })),
    true,
    '同章但位置更远',
  );
  // 三组「不前进」
  assert.equal(isProgressAhead(p({ durChapterIndex: 3, durChapterPos: 10 }), p({ durChapterIndex: 3, durChapterPos: 10 })), false, '完全相同');
  assert.equal(isProgressAhead(p({ durChapterIndex: 2 }), p({ durChapterIndex: 3 })), false, '章节更靠前');
  assert.equal(
    isProgressAhead(p({ durChapterIndex: 3, durChapterPos: 5 }), p({ durChapterIndex: 3, durChapterPos: 10 })),
    false,
    '同章但位置更靠前',
  );
  // ★ 时间大不算更远（避免「本地先读了后面又翻回去」被误判）
  assert.equal(isProgressAhead(p({ durChapterTime: 99999 }), p({ durChapterTime: 1 })), false);
});

test('#208 mergeBookProgress：远端更远 ⇒ 采用远端（且时间取较新的那个）', () => {
  const local = p({ durChapterIndex: 3, durChapterPos: 10, durChapterTime: 1000 });
  const remote = p({ durChapterIndex: 5, durChapterPos: 2, durChapterTime: 500 });
  const out = mergeBookProgress(local, remote);
  assert.equal(out.adoptedRemote, true);
  assert.equal(out.changed, true);
  assert.equal(out.progress.durChapterIndex, 5);
  assert.equal(out.progress.durChapterPos, 2);
  assert.equal(out.progress.durChapterTime, 1000, '时间取两侧较新的，别把本地时间倒退');
});

test('#208 mergeBookProgress：本地不落后 ⇒ 原样保留（不写库），远端随后被上传带齐', () => {
  const local = p({ durChapterIndex: 9, durChapterPos: 1, durChapterTime: 100 });
  const remote = p({ durChapterIndex: 2, durChapterPos: 2, durChapterTime: 900 });
  const out = mergeBookProgress(local, remote);
  assert.equal(out.adoptedRemote, false);
  assert.equal(out.changed, false);
  assert.deepEqual(out.progress, local);

  // 对照：完全一致也不算改动
  const same = mergeBookProgress(p(), p());
  assert.equal(same.changed, false);
  assert.equal(same.adoptedRemote, false);
});

test('#208 sameProgress：只比 (index, pos, title)，时间不算', () => {
  assert.equal(sameProgress(p(), p({ durChapterTime: 42 })), true);
  assert.equal(sameProgress(p(), p({ durChapterPos: 11 })), false);
  assert.equal(sameProgress(p(), p({ durChapterTitle: null })), false);
});
