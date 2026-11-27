/**
 * **备选直链下发**的回归锁（2026-09-25）。
 *
 * ## 为什么要有
 * 用户问「传给播放器的时候，没有把所有媒体地址发过去？」—— 确实没有：此前
 * `extractFromRaw` 只取 `cands[0]`。而候选排序是**启发式**（标签 → 播放器变量 →
 * 规则字面量 → 裸扩展名 URL → 任意绝对 URL），真实播放页上常有广告位/预告/多线路，
 * **排序必然有取错的时候**；能判定「这条真放不出来」的只有前端的媒体元素 error 事件。
 *
 * 所以服务端该做的是**把候选交出去**（`media.url` + `media.alternatives`），
 * 前端按序尝试、成功即停。本测试逐条锁住这个契约。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';

import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';

const BASE = 'https://media.test';

function makeCtx(): EngineContext {
  return {
    reqId: 'media-alt',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>play</body></html>', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

/** 视频源（type=4）：`content` 规则直接产出给定 HTML（JS 字面量，避免选择器依赖） */
function makeRule(html: string) {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '备选直链测试',
    bookSourceType: 4,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#l li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: `@js:${JSON.stringify(html)}` },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

async function mediaOf(html: string): Promise<{ url?: string; format?: string; alternatives?: string[] }> {
  const c = (await new LegadoEngine().content(
    makeRule(html),
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/play/1`, title: '第1集' }) },
    makeCtx(),
  )) as unknown as { media?: { url?: string; format?: string; alternatives?: string[] } };
  return c.media ?? {};
}

test('多候选时：主地址 + 全部备选都要下发（按可信度顺序）', async () => {
  const m = await mediaOf(
    `<html><body><script>var player_aaaa={"file":"https://cdn.test/hls/a.m3u8","url_next":"https://cdn.test/hls/b.m3u8"};</script></body></html>`,
  );
  assert.equal(m.url, 'https://cdn.test/hls/a.m3u8', '主地址应是最高可信度的那条');
  assert.deepEqual(
    m.alternatives,
    ['https://cdn.test/hls/b.m3u8'],
    '其它候选必须作为备选下发 —— 否则取错一条就彻底放不了（前端才有资格判定「真放不出来」）',
  );
});

test('备选必须去重（与主地址重复的候选不应出现）', async () => {
  const m = await mediaOf(
    `<html><body>
       <video src="https://cdn.test/only.m3u8"></video>
       <script>var p={"file":"https://cdn.test/only.m3u8"};</script>
     </body></html>`,
  );
  assert.equal(m.url, 'https://cdn.test/only.m3u8');
  assert.ok(
    !m.alternatives?.includes('https://cdn.test/only.m3u8'),
    `重复候选只会让前端白试一次，必须去重（实际 ${JSON.stringify(m.alternatives)}）`,
  );
});

test('只有一个候选时不带 alternatives 字段（不产生空数组噪音）', async () => {
  const m = await mediaOf(`<html><body><video src="https://cdn.test/single.mp4"></video></body></html>`);
  assert.equal(m.url, 'https://cdn.test/single.mp4');
  assert.equal(m.alternatives, undefined, '单候选时不该出现 alternatives（保持响应形状稳定可断言）');
});

test('备选同样要解析相对地址（否则备选是「看起来能播、实际缺域名」的地址）', async () => {
  const m = await mediaOf(
    `<html><body><script>var player_aaaa={"file":"/hls/main.m3u8","url_next":"/hls/backup.m3u8"};</script></body></html>`,
  );
  assert.equal(m.url, `${BASE}/hls/main.m3u8`);
  assert.deepEqual(m.alternatives, [`${BASE}/hls/backup.m3u8`], '备选也要按 base 解析成绝对地址');
});
