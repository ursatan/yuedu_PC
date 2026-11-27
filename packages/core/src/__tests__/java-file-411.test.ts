/**
 * 回归锁 `#411`：`java.importScript / cacheFile / readTxtFile / deleteFile`
 * （Legado `JsExtensions.kt:455-493` / `:826-851`）。
 *
 * ## 为什么这是一条「类级」缺陷
 * 本仓 java 桩此前**没有这四个 key** ⇒ 落到 `Proxy` 的「未实现 → 返回空串」兜底，
 * 而兜底返回的是一个**函数**（不是空串！）⇒ 源脚本写
 * `java.importScript(url).match(...)[1]` 时 `.match` 不存在 ⇒ TypeError
 * ⇒ **整段求值失败**。
 *
 * 实测受害者：18AV（`tmp/src-18AV.json`）的 `loginUi`（`@js:` 模板串）**第一个字段名**就是
 * `"ArtPlayer V${java.importScript('https://unpkg.com/artplayer/dist/artplayer.js').match(/artplayer.js.*v(.+)/i)[1]}"`
 * —— 求值失败 ⇒ 字段数组为空 ⇒ 登录对话框静默退化成「打开登录窗口」（违反铁律 4）。
 *
 * ## 本测试锁住的行为
 * 1. `importScript(http…)` 返回**文本**（不是兜底函数），`match[1]` 可用；
 * 2. **内容空即抛**（上游 `NoStackTraceException`）—— 不静默返回空串；
 * 3. `cacheFile` 命中文件层后**不再下载**（第二次调用零次 HTTP）；
 * 4. `deleteFile` 返回布尔，删后文件层未命中；
 * 5. **worker 路径**与 L1 共用同一份文件层（worker 下载过的，L1 直接命中）；
 * 6. worker 路径的空内容错误**能传回调用方**（不是被吞掉）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/**
 * `#732` 测试隔离：`importScript/cacheFile` 现在「镜像优先」，第一条用例会把手写响应
 * 回写进 `<cwd>/data/jslib-mirror`；文件内后续用例（如「空内容必须抛」）就会命中镜像
 * 而不再抛。这里关掉镜像，保持本文件原有语义（镜像能力由 `jslib-mirror-731.test.ts` 覆盖）。
 */
process.env['YUEDU_JSLIB_MIRROR'] = '0';

const LIB_URL = 'https://unpkg.com/artplayer/dist/artplayer.js';
/** 与 `selector/js-file.ts` 的 `fileCacheKey` 同算法（此处独立算一遍，避免自证） */
const keyOf = (url: string) => createHash('md5').update(url, 'utf-8').digest('hex').slice(8, 24);

const OK_BODY = 'var artplayer={version:"5.2.1"};// artplayer.js?v5.2.1';

test('L1：java.importScript(http) 返回文本，match()[1] 可用（18AV 登录页字段名）', () => {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    syncFetch: () => ({ status: 200, headers: {}, setCookie: [], body: OK_BODY }),
  });
  const out = ev(`java.importScript("${LIB_URL}").match(/artplayer.js.*v(.+)/i)[1]`, {});
  assert.equal(String(out), '5.2.1', '必须拿到真文本；旧实现是兜底函数 ⇒ .match 不存在 ⇒ TypeError');
});

test('L1：importScript 内容为空必须抛（上游 NoStackTraceException）', () => {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    syncFetch: () => ({ status: 500, headers: {}, setCookie: [], body: '' }),
  });
  assert.throws(
    () => ev(`java.importScript("${LIB_URL}")`, {}),
    /内容获取失败或者为空/,
    '空内容不能静默返回空串',
  );
});

test('L1：cacheFile 命中文件层后不再下载（第二次零 HTTP）', () => {
  let calls = 0;
  const variables = createVariableStore();
  const ev = createJsEvaluator({
    variables,
    syncFetch: () => { calls++; return { status: 200, headers: {}, setCookie: [], body: OK_BODY }; },
  });
  assert.equal(String(ev(`java.cacheFile("${LIB_URL}")`, {})), OK_BODY);
  assert.equal(String(ev(`java.cacheFile("${LIB_URL}")`, {})), OK_BODY);
  assert.equal(calls, 1, '第二次必须命中文件层（不重复下载）');
  // 文件层键 = md5Encode16(url)（与上游 CacheManager 的键算法一致）
  assert.ok(String(variables.get('__srcCache') ?? '').includes(keyOf(LIB_URL)), '文件层必须落在按源持久层');
});

test('L1：deleteFile 返回布尔，删后文件层未命中', () => {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    syncFetch: () => ({ status: 200, headers: {}, setCookie: [], body: OK_BODY }),
  });
  ev(`java.cacheFile("${LIB_URL}")`, {});
  assert.equal(String(ev(`String(java.deleteFile("${LIB_URL}"))`, {})), 'true');
  assert.equal(String(ev(`String(java.deleteFile("${LIB_URL}"))`, {})), 'false');
  assert.equal(String(ev(`java.readTxtFile("${LIB_URL}")`, {})), '', '删后应未命中');
});

test('worker：importScript 走 RPC 下载并缓存，且与 L1 共用同一份文件层', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  let calls = 0;
  const variables = createVariableStore();
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    http: async () => { calls++; return { status: 200, headers: {}, body: OK_BODY }; },
  });
  try {
    const out = await Promise.resolve(ev(`java.importScript("${LIB_URL}").match(/artplayer.js.*v(.+)/i)[1]`, {}));
    assert.equal(String(out), '5.2.1', 'worker 路径也必须拿到真文本');
    const again = await Promise.resolve(ev(`java.importScript("${LIB_URL}")`, {}));
    assert.equal(String(again), OK_BODY);
    assert.equal(calls, 1, 'worker 第二次必须命中同一份文件层');

    // L1 直接读 worker 写过的文件层（同一份按源持久存储）
    const l1 = createJsEvaluator({ variables, syncFetch: () => ({ status: 200, headers: {}, setCookie: [], body: 'SHOULD-NOT-FETCH' }) });
    assert.equal(String(l1(`java.cacheFile("${LIB_URL}")`, {})), OK_BODY, 'L1 必须命中 worker 写的缓存');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});

test('worker：空内容错误能传回调用方（不是被吞成空串）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 404, headers: {}, body: '' }),
  });
  try {
    await assert.rejects(
      async () => { await ev(`java.importScript("${LIB_URL}")`, {}); },
      /内容获取失败或者为空/,
    );
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});