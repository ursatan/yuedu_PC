/**
 * `#310` 源门控真值表（`utils/source-gate.ts`）—— **四个入口共用的唯一判据**。
 *
 * ## 为什么值得锁
 * 「这个源该不该出现在某个列表里 / 该不该给搜索按钮」这句话此前在源管理页、发现页、
 * 聚合搜索、换源搜索**各写过一遍**，四处口径已经漂移（聚合搜索**漏了 `hasSearch`**）。
 * 漂移的表现是「同一个源在不同页面时有时无」，而且**没有任何一处能解释为什么**（`#247` 的老坑）。
 *
 * ## 两层必须分开（本文件的核心断言）
 *  · **能力门** `hasSearch`/`hasExplore` = 源里**有没有这条规则**（服务端算好的事实）；
 *  · **用户开关** `searchEnabled`/`exploreEnabled` = 用户**要不要**用。
 * 两者正交 —— 必须能分别断言，否则「改了开关」和「源本来没规则」在 UI 上长得一模一样。
 *
 * ## 用户口径（2026-10-07 需求 ③，逐条落到断言）
 * 「禁用 ⇒ 源不可用、发现/搜索都不可用，且**不可更改设置**；启用后可以改发现/搜索是否禁用；
 *  没有相应规则的 ⇒ 滑块**自动禁用态**；有规则了可以自主禁用启用。」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canExplore,
  canSearch,
  exploreSwitchEnabled,
  exploreUsable,
  hasExploreSwitch,
  searchSwitchEnabled,
  searchUsable,
} from '../src/utils/source-gate';

/** 造一个源（默认：启用 + 能搜 + 能发现 + 两个开关都开） */
function src(over: {
  kind?: string;
  enabled?: boolean;
  searchEnabled?: boolean;
  exploreEnabled?: boolean;
  hasSearch?: boolean;
  hasExplore?: boolean;
} = {}) {
  const { kind = 'legado', enabled = true, searchEnabled = true, exploreEnabled = true, hasSearch = true, hasExplore = true } = over;
  return { kind, state: { enabled, searchEnabled, exploreEnabled }, hasSearch, hasExplore };
}

/* ------------------------------------------------------ 能力门（事实） */

test('能力门：`hasSearch`/`hasExplore` 缺省视为「有」（老响应不带该字段时不能把入口全掐掉）', () => {
  // 老 bundle 的响应没有这两个字段 ⇒ 必须按「有」处理，否则一次前端优先发布会让
  // 全部源的搜索/发现入口一起消失（`#293` 同口径）
  const noCaps = { kind: 'legado', state: { enabled: true, searchEnabled: true, exploreEnabled: true } };
  assert.equal(canSearch(noCaps), true);
  assert.equal(canExplore(noCaps), true);
  // 对偶：字段显式为 false 时必须判否 —— 证明上面不是「恒真」
  assert.equal(canSearch({ ...noCaps, hasSearch: false }), false);
  assert.equal(canExplore({ ...noCaps, hasExplore: false }), false);
  assert.equal(searchUsable(src({ hasSearch: false })), false);
});

/* ------------------------------------------------------ searchUsable */

test('searchUsable：源禁用 ⇒ 无论开关怎么设都不能搜（用户口径「禁用，源不可用」）', () => {
  assert.equal(searchUsable(src({ enabled: false, searchEnabled: true, hasSearch: true })), false);
});

test('searchUsable：启用 + 用户没禁用 + 有规则 ⇒ 能搜', () => {
  assert.equal(searchUsable(src()), true);
});

test('searchUsable：没有搜索规则 ⇒ 不能搜（就算用户开关是开的）', () => {
  assert.equal(searchUsable(src({ hasSearch: false })), false, '没有规则时「能搜」是假的 ⇒ 入口不该出现');
});

test('searchUsable：用户自己禁用搜索 ⇒ 不能搜（有规则也不给）', () => {
  assert.equal(searchUsable(src({ searchEnabled: false })), false);
});

test('searchUsable【对偶】：四条独立条件各掐一次，且互不掩盖（防空转）', () => {
  // 每一项单独为「否」都必须让它变成 false —— 若某条被短路吃掉，这条会失败
  assert.equal(searchUsable(src()), true, '基线为真，否则下面四条没有意义');
  assert.equal(searchUsable(src({ enabled: false })), false);
  assert.equal(searchUsable(src({ searchEnabled: false })), false);
  assert.equal(searchUsable(src({ hasSearch: false })), false);
  // 三者同时为真才为真（真值表最后一行）
  assert.equal(searchUsable(src({ enabled: true, searchEnabled: true, hasSearch: true })), true);
});

/* ------------------------------------------------------ exploreUsable */

test('exploreUsable · legado：源禁用 / 用户禁用发现 / 没有 exploreUrl 任一 ⇒ 不进发现页', () => {
  assert.equal(exploreUsable(src({ enabled: false })), false);
  assert.equal(exploreUsable(src({ exploreEnabled: false })), false);
  assert.equal(exploreUsable(src({ hasExplore: false })), false);
  assert.equal(exploreUsable(src()), true, '基线');
});

test('exploreUsable【用户需求①】：rss **不读** `exploreEnabled`（它没有那个开关）', () => {
  // 真值脏了也不能让源消失 —— 否则没有开关能把它恢复回来
  assert.equal(exploreUsable(src({ kind: 'rss', exploreEnabled: false })), true);
  // 对偶：同样输入下 legado 必须 false（证明这条分支真的按 kind 分岔了）
  assert.equal(exploreUsable(src({ kind: 'legado', exploreEnabled: false })), false);
  // rss 仍受「源禁用」与「能力门」约束
  assert.equal(exploreUsable(src({ kind: 'rss', enabled: false })), false);
  assert.equal(exploreUsable(src({ kind: 'rss', hasExplore: false })), false);
});

test('exploreUsable：源禁用优先级最高（能力门通过也不放行）', () => {
  assert.equal(exploreUsable(src({ kind: 'rss', enabled: false, hasExplore: true })), false);
});

/* ------------------------------------------------------ 滑块可见性 */

test('hasExploreSwitch：**只有 rss 没有发现滑块**（上游 RssSource 无 enabledExplore）', () => {
  assert.equal(hasExploreSwitch('rss'), false);
  assert.equal(hasExploreSwitch('legado'), true);
  assert.equal(hasExploreSwitch('maccms'), true);
  assert.equal(hasExploreSwitch('demo'), true);
});

test('exploreSwitchEnabled：滑块在「源启用 + 有规则 + 有滑块」时才是可交互态', () => {
  assert.equal(exploreSwitchEnabled(src()), true);
  assert.equal(exploreSwitchEnabled(src({ enabled: false })), false, '源禁用 ⇒ 滑块不可改设置（用户口径）');
  assert.equal(exploreSwitchEnabled(src({ hasExplore: false })), false, '没有规则 ⇒ 滑块呈自动禁用态');
  assert.equal(exploreSwitchEnabled(src({ kind: 'rss' })), false, 'rss 没有这个滑块');
});

test('searchSwitchEnabled：滑块在「源启用 + 有搜索规则」时才是可交互态', () => {
  assert.equal(searchSwitchEnabled(src()), true);
  assert.equal(searchSwitchEnabled(src({ enabled: false })), false);
  assert.equal(searchSwitchEnabled(src({ hasSearch: false })), false);
});
