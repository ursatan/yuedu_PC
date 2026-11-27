/**
 * `#312`：源格式归属识别的唯一实现（`isLegadoBookSource`）。
 *
 * 这一组用例的**正题**是「纯发现源必须被认」；**对偶**是「MacCMS / ZYFun 必须仍不认」
 * ——只有同时满足这两条，才能说明我不是「把判据放宽到什么都认」。
 *
 * 上游依据（逐字）：`BookSourceImport.kt:122-126` 的 `requireBookSourceUrl()` ——
 * **只要 `bookSourceUrl` 非空就是书源**，不看有没有规则字段；
 * 官方测试 `BookSourceImportTest.kt` 里 `{"bookSourceUrl":"…","bookSourceName":"One"}`
 * （**没有任何规则字段**）判**有效**，`{"bookSourceName":"Missing URL"}` 判「不是书源」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLegadoBookSource } from '../contract/source-kind';

test('#312：纯发现源（只有 exploreUrl，无搜索侧规则）必须被认作书源', () => {
  // 这正是 `#310` 探针撞出来的形态：源只有发现能力
  assert.equal(
    isLegadoBookSource({
      bookSourceUrl: 'https://example.com',
      bookSourceName: '无搜索源',
      exploreUrl: 'https://example.com/list?page={{page}}',
      ruleExplore: { bookList: '.item' },
    }),
    true,
    '只有发现规则也必须是 Legado 书源（上游只要求主键）',
  );
});

test('#312：上游官方用例 —— 只有主键 + 名字（无任何规则字段）也判有效', () => {
  assert.equal(
    isLegadoBookSource({ bookSourceUrl: 'https://example.com/one', bookSourceName: 'One' }),
    true,
    'BookSourceImportTest 里这条是有效书源',
  );
  assert.equal(
    isLegadoBookSource({ bookSourceName: 'Missing URL' }),
    false,
    'BookSourceImportTest 里这条判「不是书源」（缺主键）',
  );
});

test('#312：主键为「空串 / 纯空白 / 非字符串」一律不算（上游 isNullOrBlank 语义）', () => {
  assert.equal(isLegadoBookSource({ bookSourceUrl: '' }), false, '空串');
  assert.equal(isLegadoBookSource({ bookSourceUrl: '   ' }), false, '纯空白');
  assert.equal(isLegadoBookSource({ bookSourceUrl: 123 }), false, '非字符串');
  assert.equal(isLegadoBookSource({}), false, '无主键');
});

test('#312：非对象输入不炸也不认', () => {
  assert.equal(isLegadoBookSource(null), false);
  assert.equal(isLegadoBookSource(undefined), false);
  assert.equal(isLegadoBookSource('https://example.com'), false, '字符串');
  assert.equal(isLegadoBookSource([{ bookSourceUrl: 'https://example.com' }]), false, '数组不是单条源');
});

test('#312 对偶①：MacCMS 源（apiUrl，无主键）必须仍**不**被认作书源', () => {
  assert.equal(isLegadoBookSource({ apiUrl: 'https://api.example.com', name: '某影视' }), false, 'MacCMS 归 maccms 引擎');
});

test('#312 对偶②：ZYFun 源（rule，无主键）必须仍**不**被认作书源', () => {
  assert.equal(isLegadoBookSource({ rule: 'zyfun-rule-text', name: '某源' }), false, 'ZYFun 归自己的引擎');
});

test('#312 对偶③：主键 + apiUrl 共存时**必须认书源**（防「谁都不认」，判据漂移的实例）', () => {
  // 旧实现在这里返回 false（`apiUrl` 排他），而 `looksMaccms` 又因「有 bookSourceUrl」返回 false
  // ⇒ 两个识别函数同时不认 ⇒ 源被静默丢弃。现在两边口径统一为「有主键即书源」。
  assert.equal(
    isLegadoBookSource({ bookSourceUrl: 'https://example.com', apiUrl: 'https://api.example.com' }),
    true,
    '有主键就是书源 —— 不许因为同时存在 apiUrl 而造出「谁都不认」的源',
  );
});
