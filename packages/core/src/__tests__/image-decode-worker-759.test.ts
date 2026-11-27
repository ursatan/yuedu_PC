/**
 * `#759` 单张图片解密下移 worker。
 *
 * 锁五件事：
 *  1. 宿主只下发**裸字节描述符**时，worker 能重建 InputStream 方法面（readAllBytes / read / readNBytes）；
 *  2. 2MB 大 Buffer 跨线程往返字节一致（structuredClone 不是引用共享）；
 *  3. 没有 worker 池时同一份绑定在 L1 也能跑（回落路径语义一致）；
 *  4. `YUEDU_IMAGE_DECODE_WORKER=0` / 脚本碰 `Buffer` 等 worker 隔离全局 ⇒ 判不走 worker；
 *  5. worker 抛任何错都判为可回落宿主（含「worker 环境缺能力」的 ReferenceError）；
 *     只有 null/undefined 不算失败（没有可回落的错误对象）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import {
  imageDecodeBindings,
  canDecodeImageInWorker,
  // `#782` 冷规则首图探测
  planImageDecode,
  recordImageDecodeProbeCost,
  abortImageDecodeProbe,
  shouldRetryImageDecodeInL1,
  materializeImageBindings,
  isImageBytesResult,
  resetImageDecodeCostCache,
  recordImageDecodeL1Cost,
  IMAGE_BYTES_KEY,
} from '../selector/image-bytes';

type Ev = ((code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>) & {
  __yueduRouteStats?: { l1: number; worker: number; fast: number };
};

function stats(ev: Ev) {
  return ev.__yueduRouteStats ?? { l1: 0, worker: 0, fast: 0 };
}

function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['YUEDU_IMAGE_DECODE_WORKER'];
  if (value === undefined) delete process.env['YUEDU_IMAGE_DECODE_WORKER'];
  else process.env['YUEDU_IMAGE_DECODE_WORKER'] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env['YUEDU_IMAGE_DECODE_WORKER'];
    else process.env['YUEDU_IMAGE_DECODE_WORKER'] = prev;
  });
}

async function destroy(pool: unknown): Promise<void> {
  await (pool as { destroy?: () => Promise<void> }).destroy?.();
}

test('#759 ① worker：裸字节描述符 → readAllBytes() 可用且字节一致（真 worker 池）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool }) as Ev;
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
    const out = await Promise.resolve(ev('result.readAllBytes()', imageDecodeBindings(bytes, 'https://img.test/a.jpg')));
    assert.ok(out instanceof Uint8Array, '返回应为字节数组');
    assert.deepEqual([...out], [...bytes]);
    assert.equal(stats(ev).worker, 1, '必须走 worker（不是 L1）');
    assert.equal(stats(ev).l1, 0);
  } finally {
    await destroy(pool);
  }
});

test('#759 ② worker：下标 / read(buf) / readNBytes 语义与 L1 一致', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool }) as Ev;
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const out = await Promise.resolve(
      ev(
        'var r=result; r[0]=r[0]+1; var b=new Uint8Array(2); r.read(b); b[0]=b[0]+10; [r[0], b[0], r.readNBytes(2).length]',
        imageDecodeBindings(bytes, 'https://img.test/b.jpg'),
      ),
    );
    assert.deepEqual(out, [2, 12, 2], '下标写入 / read(buf) / readNBytes 都要按 InputStream 游标前进');
    assert.equal(stats(ev).worker, 1);
  } finally {
    await destroy(pool);
  }
});

test('#759 ③ worker：2MB 大 Buffer 往返字节一致（结构化克隆不是引用共享）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool }) as Ev;
    const n = 2 * 1024 * 1024;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) bytes[i] = (i * 31) & 0xff;
    const out = await Promise.resolve(ev('result.readAllBytes()', imageDecodeBindings(bytes, 'https://img.test/big.jpg')));
    assert.ok(out instanceof Uint8Array);
    assert.equal((out as Uint8Array).length, n);
    assert.equal((out as Uint8Array)[0], 0);
    assert.equal((out as Uint8Array)[n - 1], ((n - 1) * 31) & 0xff);
    assert.equal(stats(ev).worker, 1);
  } finally {
    await destroy(pool);
  }
});

test('#759 ④ 无 worker 池：同一份描述符在 L1 还原成带方法的流（回落语义一致）', async () => {
  const ev = createHybridJsEvaluator({ variables: createVariableStore() }) as Ev;
  const bytes = Uint8Array.from([0xab, 0xcd, 0xef]);
  const out = await Promise.resolve(ev('result.readAllBytes()', imageDecodeBindings(bytes, 'https://img.test/c.jpg')));
  assert.deepEqual([...((out as Uint8Array))], [...bytes]);
  // 没有池时 `createHybridJsEvaluator` 直接返回 L1 本体（不挂路由计数）⇒ 只验语义
  assert.equal(stats(ev).worker, 0, '没有池就不能走 worker');
});

test('#759 ⑤ 绑定还原是幂等的，且不会把描述符当普通对象交给脚本', () => {
  const bytes = Uint8Array.from([4, 5, 6]);
  assert.ok(isImageBytesResult(imageDecodeBindings(bytes, 'x')[ 'result' ]));
  const b1 = materializeImageBindings(imageDecodeBindings(bytes, 'x'));
  assert.ok(b1['result'] instanceof Uint8Array);
  assert.ok(!Object.keys(b1).includes(IMAGE_BYTES_KEY));
  const b2 = materializeImageBindings(b1);
  assert.equal(b2['result'], b1['result'], '已还原的绑定不得再次包装');
});

test('#759 ⑥ 开关 / 隔离全局判据：`=1` 强制；`=0` 关；碰 Buffer 等名字留 L1', async () => {
  const js = 'result.readAllBytes()';
  await withEnv('1', async () => {
    assert.equal(canDecodeImageInWorker(js, '', 7), true, '=1 强制下移');
  });
  await withEnv('0', async () => {
    assert.equal(canDecodeImageInWorker(js, '', 7), false, '=0 强制回旧行为');
  });
  await withEnv('1', async () => {
    assert.equal(canDecodeImageInWorker('Buffer.concat([result])'), false, 'Buffer 在 worker vm 不可见');
    assert.equal(canDecodeImageInWorker('require("fs")'), false);
    assert.equal(canDecodeImageInWorker(js, 'var Buffer = null'), false, 'lib 里的 Buffer 也要判');
  });
});

/**
 * `#759` 默认 **auto** 的三条判据（实测依据见 `image-bytes.ts` 的 `imageDecodeWorkerMode` 注释）：
 *  · 小图 + 冷规则 ⇒ `#782` 起改为 **worker 探测一次**（不再让主线程跑首图，见下一条用例）；
 *  · 同一解密函数实测慢过（≥80ms）⇒ 后续下移；
 *  · 大图（≥1MB，`#759` 轮次 797 实测标定）⇒ 直接下移（用户日志 `m=3268ms` 的来源）。
 */
test('#759 ⑧ auto 路由：小图冷规则 → worker 探测；记到慢成本后 → worker；大图 → worker', async () => {
  const js = `/* 759-auto-${Date.now()} */ result.readAllBytes()`;
  await withEnv(undefined, async () => {
    resetImageDecodeCostCache();
    assert.equal(canDecodeImageInWorker(js, '', 64), true, '#782：冷规则首图也先下移（探测，主线程零阻塞）');
    recordImageDecodeL1Cost(js, '', 120);
    assert.equal(canDecodeImageInWorker(js, '', 64), true, '同一函数实测 ≥80ms 后下移');
    assert.equal(canDecodeImageInWorker(js, '', 1024 * 1024), true, '大图无论如何都下移');
    // 小于阈值的样本不得污染成本缓存
    recordImageDecodeL1Cost(js, '', 30);
    resetImageDecodeCostCache();
    assert.equal(canDecodeImageInWorker(js, '', 64), true, 'reset 后回到冷规则（探测）');
  });
});

/**
 * `#782`：慢解密函数的第一张图不再在主线程跑（旧行为要靠 L1 实测才知道慢 ⇒ 3s 级
 * 阻塞每进程一次）。新口径：
 *  · 冷规则首图 `probe=true`（worker 往返记样本）；
 *  · 样本 ≥80ms ⇒ `slow`，后续小图继续 worker（`probe=false`）；
 *  · 样本 <80ms ⇒ `fast`，后续小图回 L1（不白花跨线程开销）；
 *  · 大图/强制 `on` 不需要探测。
 */
test('#782 ① 首次判定：冷规则 probe=true；慢样本 ⇒ 后续 worker；快样本 ⇒ 后续回 L1；大图不探测', async () => {
  await withEnv(undefined, async () => {
    resetImageDecodeCostCache();
    const slowJs = `/* 782-slow-${Date.now()} */ result.readAllBytes()`;
    assert.deepEqual(planImageDecode(slowJs, '', 64), { useWorker: true, probe: true }, '冷规则首图先探测');
    recordImageDecodeProbeCost(slowJs, '', 3000);
    assert.deepEqual(planImageDecode(slowJs, '', 64), { useWorker: true, probe: false }, '慢函数后续小图继续 worker');

    const fastJs = `/* 782-fast-${Date.now()} */ result.readAllBytes()`;
    assert.deepEqual(planImageDecode(fastJs, '', 64), { useWorker: true, probe: true }, '另一个冷规则也要探测');
    recordImageDecodeProbeCost(fastJs, '', 30);
    assert.deepEqual(planImageDecode(fastJs, '', 64), { useWorker: false, probe: false }, '便宜函数后续小图回 L1');

    assert.deepEqual(planImageDecode(slowJs, '', 1024 * 1024), { useWorker: true, probe: false }, '大图直接下移，不探测');
    assert.deepEqual(planImageDecode(slowJs, '', 1024 * 1024), { useWorker: true, probe: false }, '重复调用不得再开探测');
  });
});

test('#782 ② 并发同函数只测一次：只有第一张 probe=true，后续样本被丢弃', async () => {
  await withEnv(undefined, async () => {
    resetImageDecodeCostCache();
    const js = `/* 782-concurrent-${Date.now()} */ result.readAllBytes()`;
    const plans = [planImageDecode(js, '', 64), planImageDecode(js, '', 64), planImageDecode(js, '', 64)];
    assert.deepEqual(plans.map((p) => p.probe), [true, false, false], '并发首图只认第一张样本');
    assert.deepEqual(plans.map((p) => p.useWorker), [true, true, true], '并发后续仍走 worker（不阻塞主线程）');
    recordImageDecodeProbeCost(js, '', 2000);
    recordImageDecodeProbeCost(js, '', 30); // 已判定 ⇒ 丢弃，不得把 slow 覆盖成 fast
    assert.deepEqual(planImageDecode(js, '', 64), { useWorker: true, probe: false });
  });
});

test('#782 ③ 失败回落主线程：探测中断后可重测；L1 样本也会清掉探测标记', async () => {
  await withEnv(undefined, async () => {
    resetImageDecodeCostCache();
    const js = `/* 782-abort-${Date.now()} */ result.readAllBytes()`;
    assert.equal(planImageDecode(js, '', 64).probe, true);
    abortImageDecodeProbe(js, '');
    assert.deepEqual(planImageDecode(js, '', 64), { useWorker: true, probe: true }, 'worker 失败回落 L1 后仍可重新探测');

    const js2 = `/* 782-fallback-${Date.now()} */ result.readAllBytes()`;
    assert.equal(planImageDecode(js2, '', 64).probe, true);
    recordImageDecodeL1Cost(js2, '', 4000); // 回落 L1 并实测到慢
    assert.deepEqual(planImageDecode(js2, '', 64), { useWorker: true, probe: false }, '回落样本直接定性为慢');
  });
});

/**
 * `#759` 阈值 **1MB** 的边界（轮次 797 实测标定：空载交叉 2.2/3.5MB，负载 1.0~1.2MB）：
 *  · 已判 `fast` 的规则：512KB~1MB 之间回 L1（L1 实测 16~33ms，下移只多付往返）；
 *  · ≥1MB 仍强制 worker（负载下 1MB 逐字节 L1 首样本 82.9ms）；
 *  · `=on` 无视阈值/成本强制下移，`=off` 一律不下移；
 *  · `#782` 探测只针对「冷规则 + 小图」，阈值两侧都不改判（体积闸在探测之前）。
 */
test('#759 ⑨ 阈值 1MB 边界：fast 规则 512KB~1MB 回 L1；≥1MB 仍下移；on 强制；off 不下移', async () => {
  const MB = 1024 * 1024;
  const fastJs = `/* 759-edge-${Date.now()} */ result.readAllBytes()`;

  await withEnv(undefined, async () => {
    resetImageDecodeCostCache();
    recordImageDecodeProbeCost(fastJs, '', 30); // 探测样本实测便宜 ⇒ fast
    for (const len of [512 * 1024, 768 * 1024, MB - 1]) {
      assert.equal(canDecodeImageInWorker(fastJs, '', len), false, `${len}B（<1MB）fast 规则回 L1`);
      assert.deepEqual(planImageDecode(fastJs, '', len), { useWorker: false, probe: false }, `${len}B（<1MB）fast 规则回 L1`);
    }
    assert.equal(canDecodeImageInWorker(fastJs, '', MB), true, '=1MB 起强制下移');
    assert.deepEqual(planImageDecode(fastJs, '', MB), { useWorker: true, probe: false }, '=1MB 直接下移，不探测');

    // `#782`：体积闸在探测之前 ⇒ 阈值不影响探测路径本身
    const coldJs = `/* 759-edge-cold-${Date.now()} */ result.readAllBytes()`;
    assert.deepEqual(planImageDecode(coldJs, '', 512 * 1024), { useWorker: true, probe: true }, '冷规则 512KB 照样探测');
    assert.deepEqual(planImageDecode(coldJs, '', MB), { useWorker: true, probe: false }, '冷规则 ≥1MB 直接下移');
    recordImageDecodeProbeCost(coldJs, '', 3000);
    assert.deepEqual(planImageDecode(coldJs, '', 512 * 1024), { useWorker: true, probe: false }, '慢样本之后 512KB 不再探测');
  });

  await withEnv('on', async () => {
    resetImageDecodeCostCache();
    recordImageDecodeProbeCost(fastJs, '', 30); // 即便判过 fast，=on 也强制下移
    assert.deepEqual(planImageDecode(fastJs, '', 64), { useWorker: true, probe: false }, '=on 强制下移（不看阈值/成本）');
    assert.deepEqual(planImageDecode(fastJs, '', MB), { useWorker: true, probe: false }, '=on 大图也下移');
  });

  await withEnv('off', async () => {
    resetImageDecodeCostCache();
    assert.equal(canDecodeImageInWorker(fastJs, '', MB), false, '=off 大图也不下移');
    assert.deepEqual(planImageDecode(fastJs, '', MB), { useWorker: false, probe: false }, '=off 一律 L1');
    assert.deepEqual(planImageDecode(fastJs, '', 64), { useWorker: false, probe: false }, '=off 小图也不下移');
  });
});

test('#759 ⑦ 回落判据：worker 抛任何错都回落宿主（保正确性）；null/undefined 不回落', () => {
  assert.equal(shouldRetryImageDecodeInL1(Object.assign(new Error('sandbox worker 意外退出'), { __yueduWorkerInfra: true })), true);
  assert.equal(shouldRetryImageDecodeInL1(Object.assign(new Error('超时'), { code: 'JS_TIMEOUT' })), true);
  // worker 环境缺能力（Buffer/Packages 类）也是 ReferenceError ⇒ 必须回落，否则回传密文
  assert.equal(shouldRetryImageDecodeInL1(new Error('ReferenceError: foo is not defined')), true);
  assert.equal(shouldRetryImageDecodeInL1(Object.assign(new Error('l1 超时'), { code: 'L1_TIMEOUT' })), true);
  assert.equal(shouldRetryImageDecodeInL1(null), false);
  assert.equal(shouldRetryImageDecodeInL1(undefined), false);
});
