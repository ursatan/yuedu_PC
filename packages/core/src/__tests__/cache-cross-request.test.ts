/**
 * 回归锁：**源级 `cache` 跨调用 / 跨阶段共享**（#106）—— 对齐 Legado `CacheManager.kt`。
 *
 * ## 为什么这是一条「类级」缺陷而不是某个源的补丁
 *
 * Legado 把 `cache` 绑成 `CacheManager`（`AnalyzeRule.kt:897`、`AnalyzeUrl.kt:382`）：
 * key 是**全局**的，值活在内核 —— 内存 LruCache（进程级）+ DB（持久），
 * `put(key, value, saveTime)` 的 saveTime **单位是秒**、`0` = 不过期。
 * 所以源作者理所当然地跨阶段用它传值。
 *
 * 我们此前的实现是「每次 `createJsEvaluator` new 一个 Map」（L1）+
 * 「worker 每次调用 new 一个 Map」（`worker-pool.ts`），注释还写着「put 后同脚本内 get 可见」——
 * 那是**假的跨阶段保证**。语料里 14 个源用 cache，其中至少两个是**跨请求**依赖：
 *
 *  · 🎨快看漫画：`ruleBookInfo.init` 里 `cache.put("kkmh", JSON.stringify(__NUXT__))`，
 *    `ruleToc.chapterList` 里 `cache.get('kkmh')` —— 详情与目录是**两次 HTTP 请求**
 *    ⇒ 症状是「详情通了但目录 0 章」；
 *  · 📂小说阅读：`init` 里 `cache.putMemory('articleid', id)`，
 *    `ruleToc.chapterUrl` 的 `{{cache.getFromMemory('articleid')}}` —— 同样是跨请求，
 *    但源选的是**内存层** ⇒ 内存层也必须跨请求存活；
 *  · 🏷晋江文学：`cache.put("jjtime", true, 11600)` ⇒ **必须消费 TTL 第三参**；
 *  · ⚡酷我小说：`sort = cache.getFile('KuwoNovels'); if (sort==null){…}` ⇒
 *    **未命中必须返回 `null`**（旧实现返回空串，`if (sort==null)` 恒为 false）。
 *
 * ## 本测试锁住的行为
 * 1. `put` 后「另一次求值」可读（跨请求 —— 用新 variables + 搬运 `__srcCache` 模拟 prime）；
 * 2. 未命中返回 `null`（不是 `''`）；
 * 3. `put` 第三参是秒级 TTL，过期按未命中；
 * 4. `putMemory/getFromMemory` 是**独立的内存层**（`get` 优先读它，但绝不写持久层）；
 * 5. `delete` 三层全删、`deleteMemory` 只删内存；
 * 6. `putFile/getFile` 独立命名空间；
 * 7. **worker 路径**的 cache 回流宿主，且与 L1 共用同一份存储（跨 worker/L1 可见）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/** 计数池：worker 用例必须**真的**走池，否则回落 L1 也会通过 → 测试空转 */
function countingPool(raw: ReturnType<typeof createWorkerSandboxPool>) {
  const st = { evals: 0 };
  const pool = new Proxy(raw as unknown as Record<string, unknown>, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => {
          st.evals++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ReturnType<typeof createWorkerSandboxPool>;
  return { pool, st };
}

/** 模拟「hub 的下一次请求」：新 variables，并从 storage prime 持久层（= engine.primeSourceCache 做的事） */
function nextRequest(prev: ReturnType<typeof createVariableStore>) {
  const v = createVariableStore();
  const bag = prev.get('__srcCache');
  if (typeof bag === 'string' && bag) v.set('__srcCache', bag);
  return v;
}

test('cache.put 跨请求可读（🎨快看漫画 init.put → toc.get 的形态）', () => {
  const variables = createVariableStore();
  const ev1 = createJsEvaluator({ variables });
  assert.equal(String(ev1('cache.put("kkmh", JSON.stringify({data:[1,2]})); "ok"', {})), 'ok');

  // 第二次请求：新的求值器 + 从 storage prime 过来的持久层
  const ev2 = createJsEvaluator({ variables: nextRequest(variables) });
  assert.equal(
    String(ev2('cache.get("kkmh")', {})),
    '{"data":[1,2]}',
    '跨请求必须读得到（旧实现每次新建 Map → 这里是 null → 目录 0 章）',
  );
});

test('cache.get 未命中返回 null，不是空串（⚡酷我小说 `if (sort==null)` / Linpx 的判定）', () => {
  const ev = createJsEvaluator({ variables: createVariableStore() });
  assert.equal(String(ev('String(cache.get("nope"))', {})), 'null', 'Legado 的 CacheManager.get(): String? → null');
  assert.equal(String(ev('String(cache.getFromMemory("nope"))', {})), 'null');
  assert.equal(String(ev('cache.getFile("nope") == null', {})), 'true', '文件层未命中同样是 null');
});

test('cache.put 的第三参是秒级 TTL（🏷晋江文学 11600）；过期按未命中', () => {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables });
  ev('cache.put("jjtime", "1", 11600)', {});
  assert.equal(String(ev('cache.get("jjtime")', {})), '1', '未过期应可读');

  // 把 deadline 拨到过去（比 sleep 稳）——验证 get 真的按 dl 判定
  const bag = JSON.parse(String(variables.get('__srcCache'))) as Record<string, { dl: number }>;
  assert.ok(bag['jjtime']!.dl > Date.now(), 'TTL 应换算成未来的 deadline（秒 → ms）');
  bag['jjtime']!.dl = Date.now() - 1000;
  variables.set('__srcCache', JSON.stringify(bag));
  assert.equal(String(ev('String(cache.get("jjtime"))', {})), 'null', '过期必须按未命中处理');
});

test('putMemory/getFromMemory 是独立内存层：不落持久层，但 get 优先读它', () => {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables });
  ev('cache.putMemory("articleid", "42")', {});
  assert.equal(String(ev('cache.getFromMemory("articleid")', {})), '42');
  // Legado CacheManager.get：先内存 LRU，再 DB
  assert.equal(String(ev('cache.get("articleid")', {})), '42', 'get 必须先查内存层');
  assert.equal(variables.get('__srcCache'), undefined, 'putMemory 不得写持久层（否则就不是"内存"语义了）');

  // 带 TTL 的 put 不驻内存（对齐 CacheManager.put 的 deleteMemory 分支）
  ev('cache.putMemory("ttlkey", "mem"); cache.put("ttlkey", "disk", 100)', {});
  assert.equal(String(ev('String(cache.getFromMemory("ttlkey"))', {})), 'null', '带 TTL 的 put 应把内存那份删掉');
  assert.equal(String(ev('cache.get("ttlkey")', {})), 'disk', '但持久层仍在');
});

test('delete 三层全删；deleteMemory 只删内存', () => {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables });
  ev('cache.put("k", "persist"); cache.putMemory("k", "mem"); cache.putFile("k", "file")', {});
  ev('cache.deleteMemory("k")', {});
  assert.equal(String(ev('String(cache.getFromMemory("k"))', {})), 'null');
  assert.equal(String(ev('cache.get("k")', {})), 'persist', 'deleteMemory 不该动持久层');
  assert.equal(String(ev('cache.getFile("k")', {})), 'file', 'deleteMemory 不该动文件层');

  ev('cache.delete("k")', {});
  assert.equal(String(ev('String(cache.get("k"))', {})), 'null', 'delete 应删持久层');
  assert.equal(String(ev('String(cache.getFile("k"))', {})), 'null', 'delete 应连文件层一起删（Legado 三处全删）');
  // 清空后持久层是空 bag，prime 到下次请求也不会"复活"旧值
  assert.equal(String(nextRequest(variables).get('__srcCache')), '{}');
});

test('putFile/getFile 独立命名空间（⚡酷我小说 / 🔊懒人听书）', () => {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables });
  ev('cache.put("KuwoNovels", "PLAIN"); cache.putFile("KuwoNovels", "FILE")', {});
  assert.equal(String(ev('cache.get("KuwoNovels")', {})), 'PLAIN', '同名的普通键与文件键不得互相覆盖');
  assert.equal(String(ev('cache.getFile("KuwoNovels")', {})), 'FILE');
});

test('worker 路径：cache.put 回流宿主，且与 L1 共用同一份存储（跨 worker/L1）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    // 用 java.ajax 触发 worker 路由（与既有 java-put-scope 用例同一手法）
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  try {
    const put = await Promise.resolve(
      ev('java.ajax("https://h.test/a"); cache.put("kk", "from-worker"); cache.putMemory("mm", "mem-worker"); "ok"', {}),
    );
    assert.equal(String(put), 'ok');
    assert.ok(st.evals > 0, '本用例必须真的走 worker 池（否则是空转）');
    assert.ok(
      String(variables.get('__srcCache') ?? '').includes('"from-worker"'),
      `worker 的 cache.put 必须回流宿主持久层：${String(variables.get('__srcCache'))}`,
    );

    // L1 下一次求值读得到 worker 写的内容（同一份存储）
    const l1 = createJsEvaluator({ variables });
    assert.equal(String(l1('cache.get("kk")', {})), 'from-worker', 'L1 必须读到 worker 写的 cache');
    assert.equal(String(l1('cache.getFromMemory("mm")', {})), 'mem-worker', '内存层也要跨 worker/L1');

    // 反向：L1 写、worker 读（同一份存储）
    l1('cache.put("back", "from-l1")', {});
    const read = await Promise.resolve(ev('java.ajax("https://h.test/b"); cache.get("back")', {}));
    assert.equal(String(read), 'from-l1', 'worker 必须读到 L1 写的 cache');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});
