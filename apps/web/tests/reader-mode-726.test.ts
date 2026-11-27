/**
 * `#726` 书籍正文阅读模式（B 窄口径）补齐的回归锁：
 *
 *  ① **净化规则作用于抽取文本**：`applyReaderModeText()` 入参是抽取原文，
 *     必须走与 `purify()` 同一套书级/全局判据；`readerModeRawParagraphs` 只存
 *     「关掉时要还原的引擎段落」，不能把净化结果写进去。
 *  ② **漫画/PDF 互斥**：文本化会把 `<img>` 变成 `[图]` 占位 ⇒ 图集章不能被抽成文本。
 *  ③ **书签文本锚定**：开关阅读模式会整体替换段落 ⇒ 偏移失效；`anchorRange()` 先本地窗口、
 *     再「整章唯一命中」兜底，保证书签仍指向同一段文字（多处命中则不动）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPinia, setActivePinia } from 'pinia';
import type { ReplaceRule } from '@yuedu/core/contract';

import { useReaderStore } from '../src/stores/reader';
import { useReplaceRulesStore } from '../src/stores/replaceRules';
import { canExtractBookHtml } from '../src/utils/reader-mode';
import { anchorRange, buildChapterText, bodyPosToPara } from '../src/utils/chapter-text';

/** 与 `replace-rules.test.ts` 同形的规则构造（默认：启用的非正则正文规则） */
function rule(p: Partial<ReplaceRule> & { id: number }): ReplaceRule {
  return {
    id: p.id,
    name: p.name ?? `r${p.id}`,
    group: p.group ?? null,
    pattern: p.pattern ?? '',
    replacement: p.replacement ?? '',
    scope: p.scope ?? null,
    scopeTitle: p.scopeTitle ?? false,
    scopeSource: p.scopeSource ?? false,
    scopeContent: p.scopeContent ?? true,
    excludeScope: p.excludeScope ?? null,
    isEnabled: p.isEnabled ?? true,
    isRegex: p.isRegex ?? false,
    timeoutMillisecond: p.timeoutMillisecond ?? 3000,
    order: p.order ?? 0,
  };
}

/** ★ Node 测试环境没有 localStorage ⇒ 装一个可编程的最小替身（同 `reader-toolbar.test.ts`） */
function stubStorage(): void {
  const map = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

/** 一条把「广告」二字删掉的全局正文规则 + 一个 HTML 章（引擎段落是还原目标） */
function setup(): ReturnType<typeof useReaderStore> {
  stubStorage();
  setActivePinia(createPinia());
  const r = useReaderStore();
  const rr = useReplaceRulesStore();
  rr.rules = [rule({ id: 1, pattern: '广告', replacement: '' })];
  r.patchPrefs({ replaceEnableDefault: true });
  // ★ pinia 把 setup store 里的 ref 解包成普通属性 ⇒ 从实例赋值不能写 `.value`
  r.detail = { title: '锁测试书', author: '作者', kind: 'book', chapters: [] } as never;
  r.chapter = {
    title: '第一章',
    paragraphs: ['原始甲', '原始乙'],
    html: '<article><p>原始甲</p><p>原始乙</p></article>',
  } as never;
  return r;
}

test('净化规则作用于阅读模式抽取文本（与 purify 同一判据，不另写一份）', () => {
  const r = setup();
  r.applyReaderModeText(['第一段', '第二段含广告词']);
  const ch = r.chapter!;
  assert.equal(ch.readerModeText, true);
  assert.deepEqual(ch.paragraphs, ['第一段', '第二段含词'], '抽取文本必须过净化规则');
  assert.deepEqual(
    ch.readerModeRawParagraphs,
    ['原始甲', '原始乙'],
    '备份只存「关掉要还原的引擎段落」，不能存抽取/净化结果',
  );
});

test('关闭阅读模式还原原文，且再次开启不会「净化两次」', () => {
  const r = setup();
  r.applyReaderModeText(['含广告的抽取段']);
  assert.deepEqual(r.chapter!.paragraphs, ['含的抽取段'], '开启后是净化过的抽取文本');

  r.applyReaderModeText(null);
  assert.deepEqual(r.chapter!.paragraphs, ['原始甲', '原始乙'], '还原必须是原文，不是净化文本');
  assert.equal(r.chapter!.readerModeText, false);
  assert.deepEqual(r.chapter!.readerModeRawParagraphs, ['原始甲', '原始乙']);

  // 再次开启：入参仍是「未净化抽取值」⇒ 结果与第一次一致（没有叠加净化）
  r.applyReaderModeText(['含广告的抽取段']);
  assert.deepEqual(r.chapter!.paragraphs, ['含的抽取段']);
});

test('漫画/PDF 章不抽段落（带 html 的图集章不被文本化成 [图]）', () => {
  const html = '<article><img src="a.jpg"><img src="b.jpg"></article>';
  assert.equal(canExtractBookHtml({ html }), true, '普通书籍 HTML 章可以抽');
  assert.equal(canExtractBookHtml({ html, isComic: true }), false, '图集章必须排除，否则只剩 [图] 占位');
  assert.equal(canExtractBookHtml({ html, isPdf: true }), false, 'PDF 章走版式阅读器');
  assert.equal(canExtractBookHtml({ html, webDoc: true }), false, '网页即正文仍走 iframe');
  assert.equal(canExtractBookHtml({}), false, '没有 html 的纯文本章无可抽内容');
});

test('阅读模式切换后书签仍指向同一段文本（唯一命中兜底）', () => {
  const oldParas = ['开头段', '这段话是书签所在', '结尾段'];
  const oldLayout = buildChapterText(oldParas);
  const pos = oldLayout.starts[1];
  const snippet = '这段话是书签所在';

  // 新正文 = 抽取结果：前面插了 400 字（超过 reanchor 的 ±256 窗口 ⇒ 必须走整章兜底）
  const newParas = [`插${'x'.repeat(400)}`, '开头段', snippet, '结尾段'];
  const newLayout = buildChapterText(newParas);
  const [s, e] = anchorRange(newLayout.text, pos, pos + snippet.length, snippet);

  assert.equal(newLayout.text.slice(s, e), snippet, '锚定后区间必须正好是原文');
  assert.equal(bodyPosToPara(newLayout, s).para, 2, '书签应落在同一个文本段（不是原偏移处的乱段）');
});

test('同名文本出现多处 ⇒ 不挪动（宁可略偏，也不悄悄移到另一处）', () => {
  const oldParas = ['第1章', '正文', '第1章'];
  const oldLayout = buildChapterText(oldParas);
  const pos = oldLayout.starts[2];
  const newParas = [`前插${'y'.repeat(400)}`, '第1章', '正文', '第1章'];
  const newLayout = buildChapterText(newParas);
  const [s] = anchorRange(newLayout.text, pos, pos + '第1章'.length, '第1章');
  assert.equal(s, pos, '多处命中时保持原偏移（不静默换到另一处相同句子上）');
});
