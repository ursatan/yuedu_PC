/**
 * Phase 0.1：含 `java.ajax` 的脚本路由进 **worker 池**，且 `source` / `infoMap` 语义不变。
 *
 * 为什么必须有这组测试：
 *  · 动机——L1 的 `java.ajax` 用 `execFileSync` **同步阻塞 Node 事件循环**，并发一高就雪崩
 *    （实测探针并发 2→10：发现链正文通过率 27%→4%）。worker 内的同步 RPC 只阻塞 worker 线程；
 *  · 障碍——worker 的 bindings 必须可结构化克隆，而 `source`（Proxy+方法）与 `infoMap`（Proxy over Map）不可克隆；
 *  · 解法——传纯快照描述符（`SOURCE_FIELDS_KEY` / `INFOMAP_ENTRIES_KEY` / `INFOMAP_RAW_KEY`），
 *    worker 侧重建成 RPC 活对象，**读写全部回流宿主那一份**（否则「切分组后分类不变」会复发）。
 *
 * 断言的是**宿主侧的真实状态**（源变量、infoMap Map），不是 worker 里的副本 —— 这才能证明回流生效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator, makeInfoMapBinding } from '../selector/js';
import { SOURCE_FIELDS_KEY, INFOMAP_ENTRIES_KEY, INFOMAP_RAW_KEY } from '../selector/types';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

test('worker 池：java.ajax 走注入 HTTP，source/infoMap 写入回流宿主', async () => {
  const vars = createVariableStore();
  const pool = createWorkerSandboxPool({ size: 1 });

  // 宿主侧的「真」source 桩（对齐 engine.makeSourceStub 的形状）
  const liveSource: Record<string, unknown> = {
    bookSourceName: '测试源',
    key: 'https://src.test',
    getKey: () => 'https://src.test',
    getVariable: () => (vars.get('sourceVariable') as string | undefined) ?? '{}',
    setVariable: (v: unknown) => { vars.set('sourceVariable', String(v)); },
    getComment: () => '注释',
    getLoginInfoMap: () => new Map<string, string>([['账号', 'u1']]),
  };
  // 宿主侧的「真」infoMap（持久 Map）
  const rawMap = new Map<string, string>([['频道', '默认']]);

  const httpCalls: string[] = [];
  const ev = createHybridJsEvaluator({
    variables: vars,
    pool,
    http: async (r) => { httpCalls.push(r.url); return { status: 200, headers: {}, body: '{"ok":1}' }; },
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;

  const code = [
    'java.ajax("https://api.test/x");',
    'source.setVariable(JSON.stringify({ shunt: 2 }));',
    "infoMap['频道'] = '男生频道';",
    "infoMap.put('二', 'v2');",
    // 这里刻意只用 infoMap 的方括号/get/keys —— 若脚本在 `$`/`result` 这类**宿主 DOM 绑定**
    // 上调 DOM 方法，才必须留在 L1（不可克隆）；脚本自己在 org.jsoup 上建 DOM 已能进 worker
    // （见 jsoup-worker-bridge.test.ts）。
    "JSON.stringify({ v: source.getVariable(), k: source.getKey(), n: source.bookSourceName, m: infoMap['频道'], g: infoMap.get('频道'), nk: Object.keys(infoMap).length, ks: infoMap.keys.join(','), login: source.getLoginInfoMap().get('账号') });",
  ].join('\n');

  const out = String(await Promise.resolve(ev(code, {
    source: liveSource,
    [SOURCE_FIELDS_KEY]: { bookSourceName: '测试源', key: 'https://src.test' },
    infoMap: makeInfoMapBinding(rawMap),
    [INFOMAP_RAW_KEY]: rawMap,
    [INFOMAP_ENTRIES_KEY]: Object.fromEntries(rawMap),
    baseUrl: 'https://src.test',
    page: 1,
  })));

  // ① java.ajax 真的经宿主 HTTP（而不是 L1 的 curl）
  assert.deepEqual(httpCalls, ['https://api.test/x'], '宿主 HTTP 应被调用一次');

  // ② source.setVariable 回流到宿主变量（这是「切分组后分类能变」的前提）
  assert.equal(vars.get('sourceVariable'), '{"shunt":2}');
  // ③ infoMap 的方括号赋值与 put() 都回流到宿主那份持久 Map
  assert.equal(rawMap.get('频道'), '男生频道');
  assert.equal(rawMap.get('二'), 'v2');
  // ④ 快照字段与 RPC 方法在 worker 里都可用
  assert.ok(out.includes('https://src.test'), `getKey 应可用：${out}`);
  assert.ok(out.includes('测试源'), `快照字段应可用：${out}`);
  assert.ok(out.includes('男生频道'), `infoMap 读取应可用：${out}`);
  assert.ok(/"nk":\s*2/.test(out), `Object.keys(infoMap) 应为 2 项：${out}`);
  assert.ok(out.includes('频道') && out.includes('二'), `keys 应含两个键：${out}`);
  assert.ok(out.includes('u1'), `getLoginInfoMap().get() 应可用：${out}`);

  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

test('worker 池：source 快照缺失时仍能读字段与调方法（降级不炸）', async () => {
  const vars = createVariableStore();
  const pool = createWorkerSandboxPool({ size: 1 });
  const liveSource: Record<string, unknown> = {
    bookSourceName: '只有方法',
    getKey: () => 'https://a.test',
    setVariable: (v: unknown) => { vars.set('sv', String(v)); },
  };
  const ev = createHybridJsEvaluator({ variables: vars, pool }) as (
    code: string, bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;

  const out = String(await Promise.resolve(ev('source.setVariable("x"); source.getKey();', { source: liveSource })));
  assert.equal(vars.get('sv'), 'x');
  assert.ok(out.includes('https://a.test'));
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});
