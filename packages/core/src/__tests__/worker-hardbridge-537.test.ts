/**
 * `#537` **bitmap 桥三条优化**回归锁：
 *  ① 句柄空闲 30s 自动回收（`now` 注入 ⇒ 免时钟造假）；
 *  ② 同帧免回复 op（draw/fill/release）合并成**一条** RPC —— 依赖感知冲洗，
 *     保序由「与逐条下发逐字节一致 + 反序必须不同」证明；`YUEDU_BITMAP_BATCH=0` 可回退；
 *  ③ 大图走 SAB 二进制回包（status=3，免 base64/JSON 化），小图保留 base64 JSON 原路；
 *     两条路径逐字节对拍，阈值可用 `YUEDU_BITMAP_BINARY_MIN_KB` 回退。
 *
 * 对拍纪律同 `#526`：只测 worker = 把源从「能用」改成「不能用」，所以每条都拉 L1 作基线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { hostRpc, createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool, RAW_REPLY_FIELD } from '../sandbox/worker-pool';
import { sweepBitmapHandles } from '../selector/js';
import { createVariableStore } from '../store';

/** 8×8 PNG：纯色底 + 左上角一个白点（白点是③保序判据：丢了就是乱序） */
function tinyPng(): Uint8Array {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 20;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  png.data[0] = 255;
  png.data[1] = 255;
  png.data[2] = 255;
  return new Uint8Array(PNG.sync.write(png));
}

/** 经宿主句柄表持一张图（与 worker rpc 同一张表） */
async function holdPng(): Promise<number> {
  const r = (await hostRpc(undefined, 'bitmap', { op: 'decode', bytes: tinyPng() })) as { id: number };
  assert.ok(r.id > 0, '宿主未返回句柄');
  return r.id;
}

test('① 句柄空闲 30s 自动回收：到期释放、活跃保留、失效句柄明确报错', async () => {
  const id = await holdPng();
  // 未到期（10s）⇒ 不动
  assert.equal(sweepBitmapHandles(Date.now() + 10_000), 0, '未到期就被回收了');
  // 到期（60s）⇒ 释放
  assert.equal(sweepBitmapHandles(Date.now() + 60_000), 1, '到期未回收');
  // 失效句柄 ⇒ 明确抛错，不静默
  await assert.rejects(
    () => hostRpc(undefined, 'bitmap', { op: 'compress', id, format: 'PNG', quality: 100 }),
    /句柄失效/,
    '回收后的句柄应明确报错',
  );
  // 活跃句柄（刚持有）在别的句柄到期时不受影响（10s < 30s 阈值）
  const id2 = await holdPng();
  assert.equal(sweepBitmapHandles(Date.now() + 10_000), 0, '活跃句柄被误回收');
  const ok = (await hostRpc(undefined, 'bitmap', { op: 'compress', id: id2, format: 'PNG', quality: 100 })) as Record<string, unknown>;
  // 小图默认走 base64 原路（③ 阈值），大图才是 RAW_REPLY_FIELD —— 两者都算「仍可 compress」
  assert.ok(ok[RAW_REPLY_FIELD] || typeof ok['b64'] === 'string', '活跃句柄应仍可 compress');
});

test('③ 大图二进制 / 小图 base64 原路：阈值两档可回退', async () => {
  // 默认阈值 64KB：8×8 小图必须走 base64 JSON 原路（不是二进制）
  const smallId = (await hostRpc(undefined, 'bitmap', { op: 'decode', bytes: tinyPng() })) as { id: number };
  const small = (await hostRpc(undefined, 'bitmap', { op: 'compress', id: smallId.id, format: 'PNG', quality: 100 })) as Record<string, unknown>;
  assert.equal(small[RAW_REPLY_FIELD], undefined, '小图不应走二进制通道');
  assert.deepEqual([...replyBytes(small).subarray(0, 3)], [0xff, 0xd8, 0xff], '小图 base64 原路回包字节不对（#128 策略应为 JPEG）');

  // 大图（512×512 噪声，JPEG 输出远大于 64KB）默认走二进制
  const bigId = (await hostRpc(undefined, 'bitmap', { op: 'decode', bytes: noisePng(512, 512) })) as { id: number };
  const big = (await hostRpc(undefined, 'bitmap', { op: 'compress', id: bigId.id, format: 'PNG', quality: 100 })) as Record<string, unknown>;
  const raw = big[RAW_REPLY_FIELD];
  assert.ok(raw instanceof Uint8Array, '大图未走 SAB 二进制通道');
  assert.ok(raw.length >= 64 * 1024, `大图输出 ${raw.length}B 未跨阈值`);
  assert.deepEqual([...raw.subarray(0, 3)], [0xff, 0xd8, 0xff], '回包字节不是 JPEG（#128 策略）');

  // 回退验证：同一张大图把阈值设成极大 ⇒ 必须回到 base64 JSON，且字节与二进制路径一致
  process.env['YUEDU_BITMAP_BINARY_MIN_KB'] = '1000000';
  try {
    const fallback = (await hostRpc(undefined, 'bitmap', { op: 'compress', id: bigId.id, format: 'PNG', quality: 100 })) as Record<string, unknown>;
    assert.equal(fallback[RAW_REPLY_FIELD], undefined, '阈值关闭后仍走了二进制');
    assert.deepEqual([...replyBytes(fallback)], [...raw], 'base64 回退路径字节与二进制路径不一致');
  } finally {
    delete process.env['YUEDU_BITMAP_BINARY_MIN_KB'];
  }

  // worker 路径对拍：L1 与 worker 编出的字节应逐字节相同（同一份 android-graphics 实现）
  const code = [
    'var Magua = new JavaImporter();',
    'Magua.importPackage(Packages.java.io, Packages.android.graphics);',
    'with (Magua) {',
    '  var bytes = Packages.android.util.Base64.decode(imgB64, 0);',
    '  var img = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);',
    '  var out = new ByteArrayOutputStream();',
    '  img.compress(Bitmap.CompressFormat.PNG, 100, out);',
    '  Packages.android.util.Base64.encodeToString(out.toByteArray(), 2);',
    '}',
  ].join('\n');
  const vars = createVariableStore();
  const l1 = String(await Promise.resolve(createHybridJsEvaluator({ variables: vars })(code, { imgB64: Buffer.from(tinyPng()).toString('base64') })));
  const pool = createWorkerSandboxPool({ size: 1 });
  const wk = String(await Promise.resolve(createHybridJsEvaluator({ variables: createVariableStore(), pool })(code, { imgB64: Buffer.from(tinyPng()).toString('base64') })));
  assert.ok(l1.length > 100, `L1 基线不对：${l1.slice(0, 40)}`);
  assert.equal(wk, l1, 'worker（小图 base64 回包）与 L1 编出的字节不一致');
  // 注：pool 无 close API（worker 随进程退出回收）
});

/** 确定性噪声图：JPEG 压缩率极低 ⇒ 用于稳定跨过 64KB 二进制阈值（不能用纯色图） */
function noisePng(w: number, h: number, seed = 1): Uint8Array {
  const png = new PNG({ width: w, height: h });
  let s = seed >>> 0;
  for (let i = 0; i < png.data.length; i += 4) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    png.data[i] = s & 0xff;
    png.data[i + 1] = (s >>> 8) & 0xff;
    png.data[i + 2] = (s >>> 16) & 0xff;
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** 第二张 8×8：整块绿 —— 用于 batch 顺序的「后者覆盖前者」判据 */
function greenPng(): Uint8Array {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0;
    png.data[i + 1] = 220;
    png.data[i + 2] = 0;
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** 统一取回包字节：② 阶段是 RAW_REPLY_FIELD，③ 阈值后小图变成 base64 JSON —— 两种都认 */
function replyBytes(r: Record<string, unknown>): Buffer {
  const raw = r[RAW_REPLY_FIELD];
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  return Buffer.from(String(r['b64'] ?? ''), 'base64');
}

test('② 同帧免回复 op 合并包：宿主按数组顺序落地（后者覆盖前者）', async () => {
  const srcA = (await hostRpc(undefined, 'bitmap', { op: 'decode', bytes: tinyPng() })) as { id: number };
  const srcB = (await hostRpc(undefined, 'bitmap', { op: 'decode', bytes: greenPng() })) as { id: number };
  const mk = async (): Promise<number> => ((await hostRpc(undefined, 'bitmap', { op: 'create', w: 8, h: 8 })) as { id: number }).id;
  const encode = async (id: number): Promise<Buffer> =>
    replyBytes((await hostRpc(undefined, 'bitmap', { op: 'compress', id, format: 'PNG', quality: 100 })) as Record<string, unknown>);

  // A：逐条下发（旧行为基线）：先 A 后 B ⇒ B 覆盖
  const a = await mk();
  await hostRpc(undefined, 'bitmap', { op: 'draw', dst: a, src: srcA.id, left: 0, top: 0 });
  await hostRpc(undefined, 'bitmap', { op: 'draw', dst: a, src: srcB.id, left: 0, top: 0 });
  const ref = await encode(a);

  // B：合并成一条 batch（顺序 A → B）⇒ 必须与逐条下发逐字节一致
  const b = await mk();
  await hostRpc(undefined, 'bitmap', {
    op: 'batch',
    ops: [
      { op: 'draw', dst: b, src: srcA.id, left: 0, top: 0 },
      { op: 'draw', dst: b, src: srcB.id, left: 0, top: 0 },
    ],
  });
  assert.deepEqual(await encode(b), ref, 'batch 与逐条下发的产物不一致 ⇒ 合并丢了/乱序了');

  // C：反序 batch（B → A）⇒ A 覆盖，必须与基线不同（证明比较对顺序敏感）
  const c = await mk();
  await hostRpc(undefined, 'bitmap', {
    op: 'batch',
    ops: [
      { op: 'draw', dst: c, src: srcB.id, left: 0, top: 0 },
      { op: 'draw', dst: c, src: srcA.id, left: 0, top: 0 },
    ],
  });
  assert.notDeepEqual(await encode(c), ref, '反序 batch 竟然与正序一致 ⇒ 顺序证明无效');
});

test('③ 免回复 op 保序：drawBitmap/drawColor 后立刻 compress，worker 与 L1 逐字节一致', async () => {
  const code = [
    'var Magua = new JavaImporter();',
    'Magua.importPackage(Packages.java.io, Packages.android.graphics);',
    'with (Magua) {',
    '  var bytes = Packages.android.util.Base64.decode(imgB64, 0);',
    '  var img = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);',
    '  var w = img.getWidth(); var h = img.getHeight();',
    '  var dst = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);',
    '  var canvas = new Canvas(dst);',
    '  canvas.drawColor(0xFF336699);',           // 免回复：fill
    '  canvas.drawBitmap(img, 0, 0);',           // 免回复：draw（左上角白点的来源）
    '  var out = new ByteArrayOutputStream();',
    '  dst.compress(Bitmap.CompressFormat.PNG, 100, out);', // 同步：必须看得到前两次绘制
    '  Packages.android.util.Base64.encodeToString(out.toByteArray(), 2);',
    '}',
  ].join('\n');
  const bindings = { imgB64: Buffer.from(tinyPng()).toString('base64') };
  const l1 = String(await Promise.resolve(createHybridJsEvaluator({ variables: createVariableStore() })(code, bindings)));
  const pool = createWorkerSandboxPool({ size: 1 });
  const wk = String(await Promise.resolve(createHybridJsEvaluator({ variables: createVariableStore(), pool })(code, bindings)));
  // 注：pool 无 close API（worker 随进程退出回收）
  assert.ok(l1.length > 100, `L1 基线不对：${l1.slice(0, 40)}`);
  assert.equal(wk, l1, '免回复 op 疑似乱序/丢失：worker 与 L1 像素不一致');
});
