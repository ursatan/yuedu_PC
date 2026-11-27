/**
 * `#317` RSS source 桩的 **bean 属性形态** 回归锁。
 *
 * 上游 Rhino 把 Java bean getter 暴露成同名属性 ⇒ 源脚本 `source.variable` **等价于**
 * `source.getVariable()`，且未设置时是**空串**（`BaseSource.kt:337`
 * `CacheManager.get(...) ?: ""`）。本仓桩此前只有方法 ⇒ `source.variable` 是
 * `undefined` ⇒ `String(source.variable) || "默认"` 的**防空写法**失效
 * （`String(undefined)` = `"undefined"` 是 truthy）。
 * 语料实证：`24凹凸`/`凹凸吧` 搜索分类 `wd={{String(source.variable) || "美女"}}`
 * 被渲染成 `wd=undefined`。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs0 from 'node:fs';
import os0 from 'node:os';
import path0 from 'node:path';

import { createTraceSink, createVariableStore, type EngineContext } from '@yuedu/core';

import { makeRssEnv } from './env';
import { compileRssSource, type RssSourceRaw } from './model/rss-source';

/**
 * `#732` 测试隔离：镜像默认写到 `<cwd>/data/jslib-mirror`，而「必须发网络」的断言
 * （`#381`/`#708`）依赖「镜像未命中」。若不隔离，第一次跑会把响应回写进仓库目录，
 * 第二次跑就全部命中镜像 ⇒ 断言 `calls === 2` 变成 `0`（假失败）。
 */
if (!process.env['YUEDU_JSLIB_MIRROR_DIR']) {
  const mirrorTmp = fs0.mkdtempSync(path0.join(os0.tmpdir(), 'rss-mirror-suite-732-'));
  process.env['YUEDU_JSLIB_MIRROR_DIR'] = mirrorTmp;
  after(() => fs0.rmSync(mirrorTmp, { recursive: true, force: true }));
}

function makeCtx(): EngineContext {
  return {
    reqId: 't',
    sourceId: 'fake.test',
    signal: new AbortController().signal,
    http: { async request() { return { status: 200, headers: {}, body: '', url: '' }; } },
    sandbox: { async eval<T = unknown>() { return undefined as T; } },
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: { async get() { return null; }, async set() {}, async delete() {} },
    toastSink: [],
  } as unknown as EngineContext;
}

const rule = compileRssSource({ sourceUrl: 'https://www.24ao.cc', sourceName: '24凹凸' } as RssSourceRaw);
const ctx = makeCtx();
const env = makeRssEnv(ctx, rule, rule.sourceUrl);
const stub = env.sourceData as Record<string, unknown>;

test('bean 属性 `source.variable` 未设置时是空串（不是 undefined），且与方法同值', () => {
  assert.equal(stub['variable'], '');
  assert.equal(stub['variable'], (stub['getVariable'] as () => string)());
});

test('bean 属性保持活性：setVariable 之后再读是新值', () => {
  (stub['setVariable'] as (v: unknown) => void)('美女');
  assert.equal(stub['variable'], '美女');
});

test('脚本级判据：`String(source.variable) || "默认"` 在未设置时取到默认值（防空写法不被 undefined 吃掉）', async () => {
  const out = await env.jsEval('String(source.variable) || "美女"', {
    source: stub,
    baseUrl: rule.sourceUrl,
    page: 1,
    key: '',
    result: '',
  });
  assert.equal(out, '美女');
});

test('对偶：变量有值时取变量本身（防空转 —— 证明不是恒取默认）', async () => {
  (stub['setVariable'] as (v: unknown) => void)('汉服');
  const out = await env.jsEval('String(source.variable) || "美女"', {
    source: stub,
    baseUrl: rule.sourceUrl,
    page: 1,
    key: '',
    result: '',
  });
  assert.equal(out, '汉服');
});

/* ===== `#381`：jsLib 异步预下载（prime）——映射表/单 URL 走 ctx.http，绕开 curl 子进程 ===== */

import { primeJsLib, __jsLibCacheForTest } from './env';
import { resolveJsLibText } from '@yuedu/core';

test('#381 prime：映射表形态的两个 URL 都经 ctx.http 预下载进缓存（resolveJsLibText 随后命中）', async () => {
  const fetched: string[] = [];
  const jsA = 'function A() { return "a"; }';
  const jsB = 'function B() { return "b"; }';
  const ctx2 = makeCtx();
  (ctx2 as unknown as { http: { request: unknown } }).http = {
    request: async (u: string) => {
      fetched.push(u);
      return { status: 200, headers: {}, body: u.includes('a.js') ? jsA : jsB, url: u };
    },
  };
  const raw = {
    sourceUrl: 'https://t.test',
    sourceName: '映射表源',
    jsLib: JSON.stringify({ 源A: 'https://t.test/a.js', 通用: 'https://t.test/b.js' }),
  };
  const rule2 = compileRssSource(raw as RssSourceRaw);
  await primeJsLib(ctx2, rule2);
  assert.deepEqual(
    fetched.sort(),
    ['https://t.test/a.js', 'https://t.test/b.js'],
    '映射表的所有 value 都必须被预下载（含中文路径会 encodeURI）',
  );
  // prime 之后同步 resolveJsLibText 必须能拿到两库源码（引擎的 resolveJsLib 同一缓存语义）
  const out = resolveJsLibText(String(raw.jsLib), (u) => (fetched.includes(u) ? (u.includes('a.js') ? jsA : jsB) : null));
  assert.ok(out?.includes('function A') && out?.includes('function B'), 'prime 后同步面必须命中缓存');
});

test('#381 prime：中文路径 URL 会 encodeURI（curl/undici 都要求合法 URL）', async () => {
  const fetched: string[] = [];
  const ctx2 = makeCtx();
  (ctx2 as unknown as { http: { request: unknown } }).http = {
    request: async (u: string) => {
      fetched.push(u);
      return { status: 200, headers: {}, body: 'x', url: u };
    },
  };
  const raw = { sourceUrl: 'https://t.test', sourceName: '中文路径源', jsLib: '{"剧迷":"https://t.test/dy/js/剧迷/jsLib.js"}' };
  const rule2 = compileRssSource(raw as RssSourceRaw);
  await primeJsLib(ctx2, rule2);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0], 'https://t.test/dy/js/%E5%89%A7%E8%BF%B7/jsLib.js', '非 ASCII 路径必须被编码');
});

test('#381 prime：HTTP 非 2xx 不进缓存且留痕（warnOnce），resolve 面回落无 jsLib', async () => {
  const ctx2 = makeCtx();
  (ctx2 as unknown as { http: { request: unknown } }).http = {
    request: async () => ({ status: 404, headers: {}, body: 'nope', url: 'x' }),
  };
  const raw = { sourceUrl: 'https://t.test', sourceName: '404 源', jsLib: '{"k":"https://t.test/miss.js"}' };
  const rule2 = compileRssSource(raw as RssSourceRaw);
  await primeJsLib(ctx2, rule2); // 不得抛
  const out = resolveJsLibText(String(raw.jsLib), () => null);
  assert.equal(out, undefined, '未命中缓存 ⇒ 无 jsLib（引擎按无 jsLib 处理并留痕）');
});

/* ══ `#708`：外链脚本取数的重试 / 持久缓存 / 并发去重 / 失败负缓存 ══
 *
 * 为什么这四条必须钉死：Movieffm（qyyuapi 系）的外链主机**慢且抖**（实测 jsLib 4~9s、
 * common.js 25~40s、偶发整段挂死）。旧实现 `ctx.http` 默认 12s + 不重试 ⇒ 首次必死；
 * 一次用户操作里 home/category 并发 prime 同一 URL ⇒ 叠出 6 次超时 ⇒ 同域名熔断 40s
 * ⇒ 后续 sortUrl/loginUrl 全被误伤（用户日志 `[net-guard] 域名熔断 … 还需 33s`）。
 * 下面四条分别锁「重试」「跨进程持久」「并发去重」「失败负缓存」——任何一条回退，都会
 * 让这个站点重新回到「浏览器能下载、引擎全超时」的形态。
 */
import { createHash } from 'node:crypto';

import { SCRIPT_FETCH_POLICY } from '@yuedu/core';

test('#708 prime：首次超时第 2 次成功（重试生效，不再「一次判死」）', async () => {
  const url = 'https://t708.test/retry.js';
  const body = 'function RetryOk() { return "ok"; }';
  let calls = 0;
  const ctx2 = makeCtx();
  (ctx2 as unknown as { http: { request: unknown } }).http = {
    request: async (u: string) => {
      calls++;
      if (calls === 1) throw new Error(`请求超时（>${SCRIPT_FETCH_POLICY.perAttemptMs}ms）`);
      return { status: 200, headers: {}, body, url: u };
    },
  };
  const raw = { sourceUrl: 'https://t708.test', sourceName: '重试源', jsLib: JSON.stringify({ k: url }) };
  const rule2 = compileRssSource(raw as RssSourceRaw);
  await primeJsLib(ctx2, rule2);
  assert.equal(calls, 2, '第一次超时后必须再试一次（旧实现：单次 12s 即判死）');
  // 第二次 prime 必须命中内存缓存（不再发网络）
  await primeJsLib(ctx2, rule2);
  assert.equal(calls, 2, '成功结果必须留在进程内缓存，重复 prime 不再请求');
});

test('#708 prime：持久层命中（jslib:<md5>）⇒ 完全不走网络', async () => {
  const url = 'https://t708.test/store.js';
  const body = 'function FromStore() { return 1; }';
  const key = 'jslib:' + createHash('md5').update(url, 'utf-8').digest('hex');
  let calls = 0;
  const ctx2 = makeCtx();
  (ctx2 as unknown as { storage: unknown }).storage = {
    async get(k: string) {
      return k === key ? body : null;
    },
    async set() {},
    async delete() {},
  };
  (ctx2 as unknown as { http: { request: unknown } }).http = {
    request: async () => {
      calls++;
      throw new Error('持久层已命中，不应发网络');
    },
  };
  const raw = { sourceUrl: 'https://t708.test', sourceName: '持久源', jsLib: JSON.stringify({ k: url }) };
  const rule2 = compileRssSource(raw as RssSourceRaw);
  await primeJsLib(ctx2, rule2);
  await primeJsLib(ctx2, rule2);
  assert.equal(calls, 0, '磁盘缓存（与 engine-legado 共用的 jslib:<md5>）命中时必须零网络');
});

test('#708 prime：并发 prime 同一 URL ⇒ 只发一次网络（在飞去重）', async () => {
  const url = 'https://t708.test/dedup.js';
  let calls = 0;
  const ctx2 = makeCtx();
  (ctx2 as unknown as { http: { request: unknown } }).http = {
    request: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return { status: 200, headers: {}, body: 'function D() { return 1; }', url };
    },
  };
  const raw = { sourceUrl: 'https://t708.test', sourceName: '并发源', jsLib: JSON.stringify({ k: url }) };
  const rule2 = compileRssSource(raw as RssSourceRaw);
  // home/category 并发入口的真实形态：两个 prime 同时打同一 URL
  await Promise.all([primeJsLib(ctx2, rule2), primeJsLib(ctx2, rule2)]);
  assert.equal(calls, 1, '同一 URL 的并发 prime 必须共享一次网络请求（否则叠出 6 次超时 ⇒ 熔断误伤）');
});

test('#708 prime：失败后 5 分钟内不再重试（负缓存挡住「一次行动反复打死站」）', async () => {
  const url = 'https://t708.test/dead.js';
  let calls = 0;
  const ctx2 = makeCtx();
  (ctx2 as unknown as { http: { request: unknown } }).http = {
    request: async () => {
      calls++;
      // 404 + 空体 = 确定性失败：fetchScriptTextRetry 只尝试 1 次
      return { status: 404, headers: {}, body: '', url };
    },
  };
  const raw = { sourceUrl: 'https://t708.test', sourceName: '死站源', jsLib: JSON.stringify({ k: url }) };
  const rule2 = compileRssSource(raw as RssSourceRaw);
  await primeJsLib(ctx2, rule2);
  assert.equal(calls, 1, '404 是确定性失败，不做无谓重试');
  await primeJsLib(ctx2, rule2);
  assert.equal(calls, 1, '失败负缓存（5 分钟）内不得再打同一个死站');
});

/* ══ `#732` 外链脚本镜像：**网络优先 → 镜像兜底 → 连续失败提示手动下载** ══
 *
 * 顺序是用户 2026-11-02 **反转**后的语义（早先「镜像优先」会挡住站点的新版本）：
 *  - 每次先走网络；成功 ⇒ 用网络内容 + 回写镜像（成功时**不读**镜像）；
 *  - 失败（超时 / 空响应 / 非 2xx / 连接错误）⇒ 才用 `data/jslib-mirror/<host>/<path…>` 兜底；
 *  - 两者都失败 ⇒ 明确失败（缓存里没有该库）+ 同一 URL 连续失败到阈值只提示一次「请手动下载」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readJsMirror,
  writeJsMirror,
  listJsMirrorHints,
  noteJsMirrorFailure,
  jsMirrorAbsPath,
  __resetJsMirrorWarningsForTest,
} from '@yuedu/core';

function withMirrorDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const prevDir = process.env['YUEDU_JSLIB_MIRROR_DIR'];
  const prevOn = process.env['YUEDU_JSLIB_MIRROR'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-mirror-732-'));
  process.env['YUEDU_JSLIB_MIRROR_DIR'] = dir;
  delete process.env['YUEDU_JSLIB_MIRROR'];
  __resetJsMirrorWarningsForTest();
  const restore = () => {
    if (prevDir === undefined) delete process.env['YUEDU_JSLIB_MIRROR_DIR'];
    else process.env['YUEDU_JSLIB_MIRROR_DIR'] = prevDir;
    if (prevOn === undefined) delete process.env['YUEDU_JSLIB_MIRROR'];
    else process.env['YUEDU_JSLIB_MIRROR'] = prevOn;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const out = fn(dir);
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return Promise.resolve(out);
  } catch (e) {
    restore();
    throw e;
  }
}

/** 让某个源只依赖一个 jsLib URL（prime 的入口） */
function ruleWithJsLib(url: string, name = '镜像源') {
  const raw = { sourceUrl: 'https://t732.test', sourceName: name, jsLib: JSON.stringify({ k: url }) };
  return compileRssSource(raw as RssSourceRaw);
}

/** 把 ctx.http 换成「恒成功」或「恒失败」的桩（只关心 prime 的取数顺序） */
function stubHttp(ctx: unknown, handler: (u: string) => Promise<unknown>): void {
  (ctx as { http: { request: unknown } }).http = { request: handler };
}

test('#732 prime：网络成功 ⇒ 用网络内容，并回写镜像（内容 + meta 一致）', async () => {
  await withMirrorDir(async (dir) => {
    const url = 'https://t732.test/network-first.js';
    const body = 'function FromNetwork() { return 1; }\n';
    let calls = 0;
    const ctx2 = makeCtx();
    stubHttp(ctx2, async (u) => {
      calls++;
      return { status: 200, headers: {}, body, url: u };
    });
    const rule2 = ruleWithJsLib(url, '网络优先源');
    assert.equal(readJsMirror(url), null, '前置：镜像必须未命中');
    await primeJsLib(ctx2, rule2);
    assert.equal(calls, 1, '网络优先：必须先发请求');
    assert.equal(__jsLibCacheForTest().get(url), body, '必须用网络内容');
    assert.equal(readJsMirror(url)?.text, body, '网络成功必须回写镜像');
    const abs = path.join(dir, 't732.test', 'network-first.js');
    const meta = JSON.parse(fs.readFileSync(`${abs}.meta.json`, 'utf-8')) as {
      url: string;
      bytes: number;
      sha256: string;
      fetchedAt: string;
    };
    assert.equal(meta.url, url);
    assert.equal(meta.bytes, Buffer.byteLength(body, 'utf-8'));
    assert.equal(meta.sha256, createHash('sha256').update(body, 'utf-8').digest('hex'));
  });
});

test('#732 prime：网络成功但镜像已存在 ⇒ 仍用网络内容，并覆盖旧镜像', async () => {
  await withMirrorDir(async () => {
    const url = 'https://t732.test/stale-mirror.js';
    const stale = 'function Stale() { return 0; }\n';
    const fresh = 'function Fresh() { return 1; }\n';
    writeJsMirror(url, stale, 'manual');
    assert.equal(readJsMirror(url)?.text, stale, '前置：镜像里是旧版本');
    let calls = 0;
    const ctx2 = makeCtx();
    stubHttp(ctx2, async (u) => {
      calls++;
      return { status: 200, headers: {}, body: fresh, url: u };
    });
    const rule2 = ruleWithJsLib(url, '旧镜像源');
    await primeJsLib(ctx2, rule2);
    assert.equal(calls, 1, '镜像存在也必须发请求');
    assert.equal(__jsLibCacheForTest().get(url), fresh, '必须用网络内容，不能返回旧镜像');
    assert.equal(readJsMirror(url)?.text, fresh, '网络成功必须覆盖旧镜像');
  });
});

test('#732 prime：网络失败 + 镜像命中 ⇒ 镜像兜底（且不催用户下载）', async () => {
  await withMirrorDir(async () => {
    const url = 'https://t732.test/fallback-hit.js';
    const mirrorText = 'function FromMirror() { return "mirror"; }\n';
    writeJsMirror(url, mirrorText, 'manual');
    const ctx2 = makeCtx();
    stubHttp(ctx2, async () => {
      throw new Error('请求超时（>12000ms）');
    });
    const rule2 = ruleWithJsLib(url, '兜底源');
    await primeJsLib(ctx2, rule2);
    assert.equal(__jsLibCacheForTest().get(url), mirrorText, '网络失败必须用镜像内容继续');
    assert.deepEqual(listJsMirrorHints(), [], '兜底成功 ⇒ 不应提示「请手动下载」');
  });
});

test('#732 prime：网络失败 + 无镜像 ⇒ 明确失败；连续 3 次只提示一次，第 4 次不再提示', async () => {
  await withMirrorDir(async () => {
    const url = 'https://t732.test/both-fail.js';
    const ctx2 = makeCtx();
    stubHttp(ctx2, async () => {
      throw new Error('请求超时（>12000ms）');
    });
    const rule2 = ruleWithJsLib(url, '双失败源');
    for (let i = 0; i < 3; i++) await primeJsLib(ctx2, rule2);
    assert.equal(__jsLibCacheForTest().has(url), false, '失败不能返回内容（也不得返回空串）');
    const hints1 = listJsMirrorHints();
    assert.equal(hints1.length, 1, '达到阈值（3 次）必须提示一次');
    assert.equal(hints1[0]?.url, url);
    assert.equal(hints1[0]?.fails, 3);
    assert.ok(hints1[0]?.notifiedAt);
    const firstNotifiedAt = hints1[0]?.notifiedAt;
    await primeJsLib(ctx2, rule2); // 第 4 次
    const hints2 = listJsMirrorHints();
    assert.equal(hints2.length, 1, '同一 URL 只提示一次');
    assert.equal(hints2[0]?.notifiedAt, firstNotifiedAt, '第 4 次不得刷新提示时间（不重复打扰）');
  });
});

test('#732 提示：不同 URL 独立计数；路径按 URL 映射成绝对路径（Windows 反斜杠）', () => {
  return withMirrorDir(async () => {
    const u1 = 'https://t732.test/dy/js/Movieffm/loginUrl.js';
    const u2 = 'https://t732.test/js/common.js';
    assert.equal(noteJsMirrorFailure(u1, '请求超时（>12000ms）')?.url, undefined);
    noteJsMirrorFailure(u1, '请求超时（>12000ms）');
    assert.equal(listJsMirrorHints().length, 0, '未到阈值（3）不得提示');
    const h1 = noteJsMirrorFailure(u1, '请求超时（>12000ms）');
    assert.equal(h1?.url, u1);
    assert.equal(jsMirrorAbsPath(u1), path.join(process.env['YUEDU_JSLIB_MIRROR_DIR'] ?? '', 't732.test', 'dy', 'js', 'Movieffm', 'loginUrl.js'));
    assert.match(h1?.text ?? '', /loginUrl\.js/);
    assert.match(h1?.text ?? '', /浏览器下载后按此路径保存，重启服务生效/);
    if (process.platform === 'win32') assert.ok((h1?.absPath ?? '').includes('\\'), 'Windows 绝对路径要用反斜杠');
    assert.equal(noteJsMirrorFailure(u1, '请求超时（>12000ms）'), null, '已提示过 ⇒ 第 4 次不再提示');
    // 另一个 URL 各自独立计数
    noteJsMirrorFailure(u2, '连接错误');
    noteJsMirrorFailure(u2, '连接错误');
    assert.equal(listJsMirrorHints().length, 1, 'u2 还没到阈值');
    assert.equal(noteJsMirrorFailure(u2, '连接错误')?.url, u2);
    assert.equal(listJsMirrorHints().length, 2, '不同 URL 各自独立提示');
  });
});

test('#732 prime：镜像损坏（与 meta 不一致）⇒ 视为未命中，网络成功则重写修复', async () => {
  await withMirrorDir(async (dir) => {
    const url = 'https://t732.test/corrupt.js';
    const good = 'function Good() { return 1; }\n';
    const body = 'function Fresh() { return 2; }\n';
    writeJsMirror(url, good, 'manual');
    const abs = path.join(dir, 't732.test', 'corrupt.js');
    fs.writeFileSync(abs, `${good}// tampered\n`, 'utf-8');
    assert.equal(readJsMirror(url), null, '前置：损坏镜像必须按未命中');
    let calls = 0;
    const ctx2 = makeCtx();
    stubHttp(ctx2, async (u) => {
      calls++;
      return { status: 200, headers: {}, body, url: u };
    });
    const rule2 = ruleWithJsLib(url, '损坏源');
    await primeJsLib(ctx2, rule2);
    assert.equal(calls, 1, '损坏镜像必须视为未命中 ⇒ 回源');
    assert.equal(readJsMirror(url)?.text, body, '回源成功后必须用新内容修复镜像');
  });
});
