/**
 * `#577` java / android 垫片补齐（真实源报障驱动的两个缺口）。
 *
 * ① `Packages.android.graphics.Paint is not a constructor`（🔞禁漫天堂API）：
 *    新版 imageDecode 会 `new Paint()` 后 `canvas.drawBitmap(..., paint)`；
 *    我们只有 BitmapFactory/Bitmap/Canvas ⇒ 整段解密抛错 ⇒ 图片保持「横向条」。
 * ② `Packages.java.security.SecureRandom is not a constructor`（🏷微信读书二合一）：
 *    登录脚本用 `new SecureRandom().nextInt(10)` 生成设备号；缺类 ⇒ 游客登录 / 扫码登录全废。
 *
 * 锁两件事：① 两个构造器真的可用；② worker 侧的同名实现存在（两边同步维护，
 * 否则「L1 能跑、worker 静默空串」——`#500` 的既定纪律）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { makeAndroidGraphicsNs } from '../selector/android-graphics';
import { makeSecureRandomCtor } from '../selector/java-bridge';

test('#577 android.graphics.Paint：构造 + 常用 setter 可用（脚本不再抛 not a constructor）', () => {
  const ns = makeAndroidGraphicsNs();
  const Paint = ns['Paint'] as (new () => Record<string, (v?: unknown) => unknown>) | undefined;
  assert.equal(typeof Paint, 'function', 'Packages.android.graphics.Paint 必须是构造函数');
  const p = new Paint!();
  p['setAntiAlias']!(false);
  p['setFilterBitmap']!(false);
  p['setDither']!(false);
  p['setColor']!(0xff112233);
  p['setAlpha']!(128);
  p['setStyle']!('FILL');
  p['setStrokeWidth']!(2);
  assert.equal(p['isAntiAlias']!(), false);
  assert.equal(p['getColor']!(), 0xff112233);
  assert.equal(p['getAlpha']!(), 128);
  assert.equal(p['getStyle']!(), 'FILL');
  assert.equal(p['getStrokeWidth']!(), 2);
  p['reset']!();
  assert.equal(p['getAlpha']!(), 255);
});

test('#577 java.security.SecureRandom：nextInt 范围正确、nextBytes 就地填充', () => {
  const Ctor = makeSecureRandomCtor() as new () => {
    nextInt: (b?: number) => number;
    nextBytes: (b: Uint8Array | number[]) => void;
  };
  const r = new Ctor();
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const v = r.nextInt(10);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 10, `nextInt(10) 越界：${v}`);
    seen.add(v);
  }
  assert.ok(seen.size >= 3, 'nextInt 必须是随机而非常量');
  // Java 语义：nextBytes 填**传入的数组**，返回 undefined
  const buf = new Uint8Array(8);
  r.nextBytes(buf);
  assert.ok(buf.some((x) => x !== 0), 'nextBytes(Uint8Array) 必须就地写入');
  const arr = new Array<number>(8).fill(0);
  r.nextBytes(arr);
  assert.ok(arr.some((x) => x !== 0), 'nextBytes(Array) 必须就地写入');
});

test('#577 worker 侧同步实现：graphics.Paint 与 SecureRandom 的 Java 语义', () => {
  const src = readFileSync(new URL('../sandbox/worker-pool.ts', import.meta.url), 'utf8');
  // `#587` 补 Rect（禁漫天堂六参 drawBitmap 的 src/dst 矩形）；锁同步带上它
  assert.match(
    src,
    /return \{ BitmapFactory: BitmapFactory, Bitmap: Bitmap, Canvas: Canvas, Paint: Paint, Rect: Rect \}/,
    'worker 的 android.graphics 必须暴露 Paint/Rect',
  );
  assert.match(src, /this\.nextBytes = function \(bytes\) \{[\s\S]*?for \(var i = 0; i < len; i\+\+\) bytes\[i\] = rnd\[i\]/, 'worker 的 nextBytes 必须就地填充（不能把参数当长度）');
});
