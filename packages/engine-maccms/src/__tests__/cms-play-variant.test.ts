/**
 * CMS 播放串**字段变体**与 0 集兜底的回归锁（2026-09-26）。
 *
 * ## 背景（用户实测：「大地资源：没有解析到选集」）
 * 该站 API（`https://dadiapi.com/feifei2/`）**不是标准 AppleCMS**：
 *   · `?ac=detail&ids=<id>` 是**精简版** ⇒ 只回
 *     `{vod_id, vod_name, list_name, vod_play:"dadim3u8"}`（**没有集串**）
 *   · `?ac=videolist&ids=<id>` 才回完整项，集地址在 **`vod_url`**（不是 `vod_play_url`）：
 *     `vod_play = "dadim3u8"`、`vod_url = "在线播放$https://v202510.ddcdnbf.com/…/index.m3u8"`
 *
 * 于是引擎按 `vod_play_from`/`vod_play_url` 解析 ⇒ **0 章** ⇒ 前端「没有解析到选集」。
 *
 * 本测试锁两件事：
 *   ① `normalizeCmsPlayFields`：`vod_url` 变体 → 标准字段（**只在 vod_play_url 为空时**，
 *      且要求含 `$`，避免把「详情页 URL」当集串）；
 *   ② `detail` 在 0 集时**改用列表端点**（`ac=videolist&ids=`）再取一次；
 *      且正常源（detail 就有集串）**不会多打这一次请求**。
 *
 * ⚠️ 本文件必须用 CRLF 行尾（与同目录其它测试一致）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpClient,
} from '@yuedu/core';
import { MacCmsEngine } from '../engine';
import { normalizeCmsPlayFields } from '../normalize';
import type { CmsVod } from '../model/cms-source';

const SOURCE = { name: '变体站', api: 'https://api.variant.test/feifei2/' };
const engine = new MacCmsEngine();

/** 记录每次请求的 URL，便于断言「有没有多打一次」 */
function spyHttp(map: Record<string, unknown>, seen: string[]): HttpClient {
  return {
    async request(url: string) {
      seen.push(url);
      for (const key of Object.keys(map)) {
        if (url.includes(key)) {
          const v = map[key];
          return { status: 200, headers: {}, body: typeof v === 'string' ? v : JSON.stringify(v), url };
        }
      }
      throw new Error(`no mock for ${url}`);
    },
  };
}
function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 'cms-variant',
    sourceId: 'test',
    signal: new AbortController().signal,
    http,
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

test('normalizeCmsPlayFields：vod_url 变体 → 补成 vod_play_url，线路名取 vod_play', () => {
  const v = normalizeCmsPlayFields({
    vod_id: '250796',
    vod_name: '示例',
    vod_play: 'dadim3u8',
    vod_url: '在线播放$https://cdn.test/a/index.m3u8',
  } as CmsVod);
  assert.equal(v.vod_play_url, '在线播放$https://cdn.test/a/index.m3u8', '集串要落到 vod_play_url');
  assert.equal(v.vod_play_from, 'dadim3u8', '线路名取 vod_play（该变体用它当线路标记）');
});

test('normalizeCmsPlayFields：已有 vod_play_url 时不动（不覆盖标准源）', () => {
  const v = normalizeCmsPlayFields({
    vod_id: '1',
    vod_play_from: 'l1',
    vod_play_url: '第1集$https://cdn.test/x.m3u8',
    vod_url: '这是详情页地址不是集串$',
  } as CmsVod);
  assert.equal(v.vod_play_url, '第1集$https://cdn.test/x.m3u8', '标准字段优先，绝不能被 vod_url 顶掉');
  assert.equal(v.vod_play_from, 'l1');
});

test('normalizeCmsPlayFields：vod_url 不含 $ 时不认（避免把普通 URL 当集串）', () => {
  const v = normalizeCmsPlayFields({ vod_id: '1', vod_url: 'https://cdn.test/only-a-url.m3u8' } as CmsVod);
  assert.equal(v.vod_play_url, undefined, '没有 `集名$地址` 形态就不能当集串');
});

test('detail：detail 端点只有精简版 ⇒ 自动用 ac=videolist&ids 兜底并把选集补全', async () => {
  const seen: string[] = [];
  const http = spyHttp(
    {
      // 精简版：**没有** vod_play_url / vod_url（大地资源的真实形态）
      'ac=detail': { status: 200, data: [{ vod_id: '250796', vod_name: '斗罗大陆', list_name: '日韩精品', vod_play: 'dadim3u8' }] },
      // 列表端点：完整项，集地址在 vod_url
      'ac=videolist': {
        status: 200,
        data: [{ vod_id: '250796', vod_name: '斗罗大陆', vod_play: 'dadim3u8', vod_url: '正片$https://v202510.ddcdnbf.com/20260112/NFMC0iJV/index.m3u8' }],
      },
    },
    seen,
  );
  const d = await engine.detail(engine.compile(SOURCE).rule!, { action: 'detail', id: JSON.stringify({ vod_id: '250796' }) }, makeCtx(http));
  assert.equal(d.chapters?.length, 1, `应兜底拿到 1 集（实际 ${d.chapters?.length}）`);
  assert.equal(d.chapters?.[0]?.title, '正片');
  assert.equal(
    (d.chapters?.[0]?.payload as { raw?: string })?.raw,
    'https://v202510.ddcdnbf.com/20260112/NFMC0iJV/index.m3u8',
    '选集 payload 的 raw 必须是播放直链（play 动作靠它）',
  );
  assert.ok(seen.some((u) => u.includes('ac=videolist')), '必须真的用了列表端点兜底');
});

test('detail：detail 已有集串时不走兜底（不多打一次请求）', async () => {
  const seen: string[] = [];
  const http = spyHttp(
    {
      'ac=detail': {
        status: 200,
        data: [{ vod_id: '9', vod_name: '正常源', vod_play_from: 'l1', vod_play_url: '第1集$https://cdn.test/a.m3u8#第2集$https://cdn.test/b.m3u8' }],
      },
    },
    seen,
  );
  const d = await engine.detail(engine.compile(SOURCE).rule!, { action: 'detail', id: JSON.stringify({ vod_id: '9' }) }, makeCtx(http));
  assert.equal(d.chapters?.length, 2);
  assert.equal(seen.length, 1, `正常源只该请求 1 次（实际 ${seen.length} 次：${seen.join(' , ')}）`);
});
