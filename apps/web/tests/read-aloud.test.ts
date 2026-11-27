/**
 * `#203` 朗读纯逻辑的回归锁（不碰 Web Speech API、不碰 DOM）。
 *
 * 为什么值得写：这些换算错了**不会报错** —— 只会表现成
 * 「语速旋钮拧了没反应」「暂停再继续从别的地方念起」「标点行被念出来」这类看起来像玄学的问题。
 * 每条期望值都对着上游出处（见 `read-aloud-core.ts` 头部那张表）。
 *
 * 浏览器侧（真 `speechSynthesis` → 真朗读 → 真续章）由 `scripts/probe-203-read-aloud.mjs` 验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SPEECH_RATE,
  SPEECH_RATE_MAX,
  TIMER_MAX_MIN,
  chapterStopReached,
  clampSpeechRate,
  isNotReadAloud,
  locateSentence,
  nextSpeakableIndex,
  prevSpeakableIndex,
  speechRateLabel,
  speechRateOf,
  splitSentences,
  timerLabel,
  timerMinutesLeft,
} from '../src/utils/read-aloud-core';

test('常量对齐上游出处', () => {
  // AppConfig.kt:398 / dialog_read_aloud.xml 的 android:max
  assert.equal(DEFAULT_SPEECH_RATE, 5);
  assert.equal(SPEECH_RATE_MAX, 45);
  assert.equal(TIMER_MAX_MIN, 180);
});

test('语速换算 = (v + 5) / 10，默认 5 ⇒ 1.0', () => {
  assert.equal(speechRateOf(5, false), 1);
  assert.equal(speechRateOf(0, false), 0.5);
  assert.equal(speechRateOf(45, false), 5);
  assert.equal(speechRateLabel(5, false), '1');
  assert.equal(speechRateLabel(15, false), '2');
  // 「跟随系统」⇒ 忽略用户值，固定 defaultSpeechRate ⇒ 恒 1.0
  assert.equal(speechRateOf(45, true), 1);
  assert.equal(speechRateLabel(45, true), '1');
});

test('语速值收进滑条范围（含非法输入）', () => {
  assert.equal(clampSpeechRate(-3), 0);
  assert.equal(clampSpeechRate(999), SPEECH_RATE_MAX);
  assert.equal(clampSpeechRate(7.6), 8);
  assert.equal(clampSpeechRate(Number.NaN), 0);
});

test('notReadAloud：整串只有空白/标点/符号才跳过（上游 AppPattern.kt:60）', () => {
  assert.equal(isNotReadAloud(''), true);
  assert.equal(isNotReadAloud('   '), true);
  assert.equal(isNotReadAloud('……'), true);
  assert.equal(isNotReadAloud('---'), true);
  assert.equal(isNotReadAloud('\n\n'), true);
  // ★ 反例（防空转）：有字就不能跳过
  assert.equal(isNotReadAloud('他'), false);
  assert.equal(isNotReadAloud('。他。'), false);
});

test('分句：区间首尾相接、不吞字符（否则高亮/滚动会静默漂移）', () => {
  const text = '第一句。第二句！\n第三句？';
  const list = splitSentences(text);
  assert.ok(list.length >= 3, `至少切出 3 句（实得 ${list.length}）`);
  assert.equal(list.map((s) => s.text).join(''), text, '拼回来必须等于原文');
  assert.equal(list[0]!.start, 0);
  assert.equal(list[list.length - 1]!.end, text.length);
  for (let i = 1; i < list.length; i += 1) {
    assert.equal(list[i]!.start, list[i - 1]!.end, `第 ${i} 句必须紧接上一句`);
  }
});

test('分句：空文本 ⇒ 空数组（不抛错）', () => {
  assert.deepEqual(splitSentences(''), []);
});

test('跳段：跳过全标点单元，到章尾返回 -1', () => {
  // ★ 用手搭的列表而不是真分句结果：`Intl.Segmenter` 会把 `……` 并进**下一句**，
  //   拿真分句当样本会变成「测的是切分器」而不是「测跳段」（第一版就这么假红过一次）。
  const list = [
    { text: '甲。', start: 0, end: 2 },
    { text: '\n', start: 2, end: 3 },
    { text: '……', start: 3, end: 5 },
    { text: '乙。', start: 5, end: 7 },
  ];
  assert.equal(nextSpeakableIndex(list, 0), 0);
  assert.equal(nextSpeakableIndex(list, 1), 3, '从纯标点/空白起 ⇒ 跳到下一个有字的单元');
  assert.equal(nextSpeakableIndex(list, 4), -1, '越过章尾 ⇒ -1（调用方据此换章）');
  assert.equal(prevSpeakableIndex(list, 2), 0, '反向也要跳过纯标点/空白');
  assert.equal(prevSpeakableIndex(list, 0), 0, '起点含自身（`from` 是闭区间）');
  assert.equal(prevSpeakableIndex(list, -5), -1, '负下标 ⇒ 无解');
  assert.equal(nextSpeakableIndex(list, -5), 0, '负下标按 0 处理');
});

test('分句结果里不含空单元（空单元会触发一次空朗读）', () => {
  for (const s of splitSentences('甲。……乙。\n\n丙')) assert.ok(s.text.length > 0, '不得有空单元');
});

test('定位：章内偏移 → 句子下标 + 句内偏移（断点续读靠它）', () => {
  const text = '第一句。第二句。第三句。';
  const list = splitSentences(text);
  const secondStart = list[1]!.start;
  assert.deepEqual(locateSentence(list, secondStart), { index: 1, innerPos: 0 });
  assert.deepEqual(locateSentence(list, secondStart + 1), { index: 1, innerPos: 1 });
  // 越界（> 全文）⇒ 落在最后一句末尾（不返回 null、不抛错）
  const tail = locateSentence(list, text.length + 999);
  assert.equal(tail.index, list.length - 1);
  assert.equal(tail.innerPos, list[list.length - 1]!.text.length);
  // 空列表
  assert.deepEqual(locateSentence([], 10), { index: -1, innerPos: 0 });
});

test('章节停：0 = 关闭（永不停）', () => {
  assert.equal(chapterStopReached(1, 0), false);
  assert.equal(chapterStopReached(999, 0), false);
  assert.equal(chapterStopReached(2, 3), false);
  assert.equal(chapterStopReached(3, 3), true);
  assert.equal(chapterStopReached(4, 3), true);
});

test('定时：剩余毫秒 → 分钟（向上取整）与文案', () => {
  assert.equal(timerMinutesLeft(0), 0);
  assert.equal(timerMinutesLeft(-100), 0);
  assert.equal(timerMinutesLeft(1), 1); // 向上取整
  assert.equal(timerMinutesLeft(60_000), 1);
  assert.equal(timerMinutesLeft(60_001), 2);
  assert.equal(timerLabel(0), '未设置');
  assert.equal(timerLabel(15), '15 分钟');
});
