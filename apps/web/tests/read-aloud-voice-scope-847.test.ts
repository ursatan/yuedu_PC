/**
 * `#847` 音色语言筛选回归：
 *  · 默认/非法值 → 仅中文；
 *  · `zh` / `all` 过滤正确；
 *  · 已选音色被筛掉时能被识别（不能当成未选）；列表未加载/ID 失效不算被筛掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VOICE_SCOPE,
  filterVoicesByScope,
  isChineseVoiceLang,
  isVoiceFilteredOut,
  normalizeVoiceScope,
} from '../src/utils/read-aloud-core';

const VOICES = [
  { id: 'zh-cn', name: '中文（大陆）', lang: 'zh-CN' },
  { id: 'zh-tw', name: '中文（台湾）', lang: 'zh-TW' },
  { id: 'en-us', name: 'English', lang: 'en-US' },
  { id: 'ja-jp', name: '日本語', lang: 'ja-JP' },
  { id: 'yue-hk', name: '粤语', lang: 'yue-HK' },
];

test('中文语言码识别：zh / cmn / yue，排除 en/ja/空串', () => {
  for (const lang of ['zh', 'zh-CN', 'ZH_hk', 'cmn-Hans-CN', 'yue-HK']) {
    assert.equal(isChineseVoiceLang(lang), true, lang);
  }
  for (const lang of ['en-US', 'ja-JP', 'zhu', '', '  ']) {
    assert.equal(isChineseVoiceLang(lang), false, JSON.stringify(lang));
  }
});

test('默认/非法筛选值回落「仅中文」', () => {
  assert.equal(DEFAULT_VOICE_SCOPE, 'zh');
  assert.equal(normalizeVoiceScope(null), 'zh');
  assert.equal(normalizeVoiceScope(''), 'zh');
  assert.equal(normalizeVoiceScope('bogus'), 'zh');
  assert.equal(normalizeVoiceScope('all'), 'all');
});

test('按档位过滤：zh 只留中文，all 原样', () => {
  assert.deepEqual(filterVoicesByScope(VOICES, 'zh').map((v) => v.id), ['zh-cn', 'zh-tw', 'yue-hk']);
  assert.equal(filterVoicesByScope(VOICES, 'all').length, VOICES.length);
});

test('已选音色被筛掉：识别为「已选但在筛选外」', () => {
  assert.equal(isVoiceFilteredOut(VOICES, 'en-us', 'zh'), true);
  assert.equal(isVoiceFilteredOut(VOICES, 'ja-jp', 'zh'), true);
  assert.equal(isVoiceFilteredOut(VOICES, 'zh-cn', 'zh'), false);
  assert.equal(isVoiceFilteredOut(VOICES, 'en-us', 'all'), false);
});

test('未选 / 音色列表未加载 / ID 失效：都不算「被筛掉」', () => {
  assert.equal(isVoiceFilteredOut(VOICES, null, 'zh'), false);
  assert.equal(isVoiceFilteredOut(VOICES, '', 'zh'), false);
  assert.equal(isVoiceFilteredOut([], 'en-us', 'zh'), false);
  assert.equal(isVoiceFilteredOut(VOICES, 'gone', 'zh'), false);
});
