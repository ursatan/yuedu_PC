/**
 * `android.graphics` 位图桥回归锁（2026-09-24，挂账 `#117`）。
 *
 * 背景：🎨🔞禁漫天堂 的正文图被站点按 `num` 条横向切分后乱序存放，靠
 * `ruleContent.imageDecode` 的脚本还原（Android 端正常）。我们此前**只有**
 * `android.util.Base64` / `android.text.TextUtils`，`Packages.android.graphics`
 * 落到 `nest()` 兜底 ⇒ `BitmapFactory is not defined` ⇒ `decodeImage` 回退原图
 * ⇒ 用户看到「错乱的一横条一横条」。
 *
 * 本测试**不猜测站点的切条算法**，只锁两件能确定的事：
 * 1. **桥的保真度**：给定同一份输入字节与同一个 `num`，脚本经我们的
 *    `BitmapFactory/Bitmap/Canvas/ByteArrayOutputStream` 产出的像素，
 *    必须与测试内**独立写的一份参照实现**（纯 RGBA 数组搬运，逐字节）**完全一致**；
 * 2. **边界与不静默**：`gif`／`bookId < 220980` 原样返回（脚本的早退分支）；
 *    不支持的格式（webp）**抛错带原因**，不得静默返回原图。
 *
 * `num` 由脚本按 `md5(bookId + imgId)` 的末位字符码算出（三种分支），
 * 测试用 `node:crypto` 复算同一个值 —— 这与 `java.md5Encode` 的实现一致（hex md5）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PNG } from 'pngjs';

import { decode as jpegDecode } from 'jpeg-js';

import { AnalyzeRule, createJsEvaluator, createVariableStore } from '../index';
import { decodeWebp } from '../selector/webp';
import { AndroidBitmap, makeAndroidGraphicsNs } from '../selector/android-graphics';

/**
 * 用例 ①②⑤ 断言的是**像素级保真**（与参照实现逐字节比对）⇒ 显式要求无损 PNG 输出。
 *
 * 生产默认是 **JPEG**（体积策略，`#128`：无损 PNG 让解密产物膨胀约 11×）——
 * 那条路径由用例 ⑥ 单独覆盖，它会在用例内临时切回默认值。
 */
process.env.YUEDU_BITMAP_OUTPUT = 'png';

/** 取自 `data/sources/book-482/https___jmcomicui.net.json` 的 `ruleContent.imageDecode`（原文） */
const JM_SCRIPT = `
if (src.search("qyyuapi.com") != -1) {
    result;
} else {
    var Magua = new JavaImporter();
    Magua.importPackage(Packages.java.io, Packages.android.graphics);
    with(Magua) {
        var mac = src.match(/photos\\/(\\d+)?\\/(\\d+)?/);
        var bookId = mac[1];
        var imgId = mac[2];
        if (src.search("gif") != -1 || Number(bookId) < 220980) {
            result;
        } else {
            var num;
            if (Number(bookId) > 421925) {
                var md5 = java.md5Encode((bookId + imgId));
                var ascii = md5.substr( - 1).charCodeAt(0);
                num = (ascii % 8 + 1) * 2;
            } else if (Number(bookId) >= 268850) {
                var md5 = java.md5Encode((bookId + imgId));
                var ascii = md5.substr( - 1).charCodeAt(0);
                num = (ascii % 10 + 1) * 2;
            } else {
                num = 10;
            }
            var img = BitmapFactory.decodeByteArray(result, 0, result.length);
            var height = img.getHeight();
            var width = img.getWidth();
            var y = Math.floor(height / num);
            var remainder = height % num;
            var newImg = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            var canvas = new Canvas(newImg);
            for (var i = 1; i <= num; i++) {
                var h = i === num ? remainder: 0;
                canvas.drawBitmap(Bitmap.createBitmap(img, 0, y * (i - 1), width, y + h), 0, height - y * i - h, null);
            }
            var newbit = new ByteArrayOutputStream();
            newImg.compress(Bitmap.CompressFormat.PNG, 100, newbit);
            newbit.toByteArray();
        }
    }
}
`;

const BOOK_ID = 300000; // 落在 `>= 268850 && <= 421925` 分支
const IMG_ID = 100;
const SRC_URL = `https://cdn.example.com/media/photos/${BOOK_ID}/${IMG_ID}.jpg`;

/** 复算脚本的 `num`（与 `java.md5Encode` 同为 hex md5） */
function numOf(bookId: number, imgId: number): number {
  const md5 = createHash('md5').update(String(bookId) + String(imgId)).digest('hex');
  const ascii = md5.slice(-1).charCodeAt(0);
  if (bookId > 421925) return (ascii % 8 + 1) * 2;
  if (bookId >= 268850) return (ascii % 10 + 1) * 2;
  return 10;
}

/** 参照实现：完全按脚本的 `Bitmap.createBitmap` + `Canvas.drawBitmap` 语义搬运 RGBA 行 */
function referenceDescramble(rgba: Uint8Array, W: number, H: number, num: number): Uint8Array {
  const y = Math.floor(H / num);
  const remainder = H % num;
  const out = new Uint8Array(W * H * 4);
  for (let i = 1; i <= num; i++) {
    const h = i === num ? remainder : 0;
    const srcY = y * (i - 1);
    const rows = y + h;
    const dstY = H - y * i - h;
    for (let row = 0; row < rows; row++) {
      const s = ((srcY + row) * W) * 4;
      const d = ((dstY + row) * W) * 4;
      out.set(rgba.subarray(s, s + W * 4), d);
    }
  }
  return out;
}

/** 造一张「每一行都不同」的测试图（便于逐行定位串位） */
function makeImage(W: number, H: number): Uint8Array {
  const a = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      a[o] = (y * 13 + x * 7) & 0xff;
      a[o + 1] = (y * 29 + x * 3) & 0xff;
      a[o + 2] = (y * 61 + x * 5) & 0xff;
      a[o + 3] = 255;
    }
  }
  return a;
}

/**
 * 造一张**类照片**的图（用于体积对比用例 ⑥）。
 *
 * 为什么不能复用 `makeImage`：它是逐行线性渐变 + 取模跳变，属**高频噪声**——
 * PNG（DEFLATE）和 JPEG（DCT）在这种内容上都压不动，两者体积接近（实测 58.6KB vs 59.6KB），
 * 体现不出策略差异。真实漫画页是**大面积平色 + 柔和网点 + 少量线稿**，
 * 正是 JPEG 的 DCT 最擅长、PNG 最无力的形态（实测站点素材 216KB webp ↔ 2.4MB PNG）。
 *
 * 这里用低频正弦叠加**确定性小抖动**（模拟照片噪声：JPEG 会把它量化掉，PNG 却必须逐像素存）。
 */
function makePhotoLike(W: number, H: number): Uint8Array {
  const a = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      // 确定性伪随机抖动（±3）：让无损编码无从下手，而有损量化会直接吃掉
      const n = (((x * 7 + y * 13) % 5) + ((x * 3 + y * 11) % 3)) - 3;
      const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
      a[o] = cl(128 + 80 * Math.sin(x / 37) * Math.cos(y / 53) + n);
      a[o + 1] = cl(120 + 70 * Math.sin((x + y) / 61) + n);
      a[o + 2] = cl(110 + 60 * Math.cos((x - y) / 47) + n);
      a[o + 3] = 255;
    }
  }
  return a;
}

function encodePng(rgba: Uint8Array, W: number, H: number): Uint8Array {
  const png = new PNG({ width: W, height: H });
  png.data = Buffer.from(rgba);
  return new Uint8Array(PNG.sync.write(png));
}

function decodePng(bytes: Uint8Array): { w: number; h: number; data: Uint8Array } {
  const d = PNG.sync.read(Buffer.from(bytes));
  return { w: d.width, h: d.height, data: new Uint8Array(d.data) };
}

/** 用真实脚本跑一遍（走 L1 的 java 桥 + Packages/JavaImporter） */
async function runScript(bytes: Uint8Array, src: string): Promise<unknown> {
  const variables = createVariableStore();
  const jsEval = createJsEvaluator({ variables });
  const env = { baseUrl: src, variables, jsEval, jsEvalSync: jsEval } as never;
  return new AnalyzeRule(env).runJs(JM_SCRIPT, { result: bytes, src });
}

/** `#587`：同 harness，但跑新版 cdngwc 脚本（Rect + 六参 drawBitmap 形态） */
async function runCdngwcScript(bytes: Uint8Array, src: string): Promise<unknown> {
  const variables = createVariableStore();
  const jsEval = createJsEvaluator({ variables });
  const env = { baseUrl: src, variables, jsEval, jsEvalSync: jsEval } as never;
  return new AnalyzeRule(env).runJs(CDNGWC_SCRIPT, { result: bytes, src });
}

const W = 6;

test('① 保真度：脚本产出与独立参照实现逐字节一致（含 remainder≠0 的错位情形）', async () => {
  const num = numOf(BOOK_ID, IMG_ID);
  assert.ok(num >= 2 && num % 2 === 0, `num 应为偶数，实际 ${num}`);
  const y = 7;
  const H = num * y + 3; // 故意留余数：dest 边界会相对条边界错位
  const input = makeImage(W, H);

  const out = (await runScript(encodePng(input, W, H), SRC_URL)) as Uint8Array;
  assert.ok(out && out.length, `脚本应返回字节，实际 ${typeof out}`);
  const got = decodePng(out);
  const want = referenceDescramble(input, W, H, num);

  assert.equal(got.w, W, '宽度必须保持');
  assert.equal(got.h, H, '高度必须保持');
  assert.deepEqual(Array.from(got.data), Array.from(want), '像素必须与参照实现完全一致');
  // 顺带证明「真的干活了」：输出与输入不同（否则等于原图直返）
  assert.notDeepEqual(Array.from(got.data), Array.from(input), '输出不应与输入相同（说明确实重排了）');
});

test('② 往返：高度能被 num 整除时，脚本对「已打乱的图」能还原出原图', async () => {
  const num = numOf(BOOK_ID, IMG_ID);
  const H = num * 8; // 整除 ⇒ dest 与条边界对齐，该变换是自身的逆（整条竖切反转）
  const original = makeImage(W, H);
  const scrambled = referenceDescramble(original, W, H, num);
  assert.notDeepEqual(Array.from(scrambled), Array.from(original), '前提：打乱后应与原图不同');

  const out = (await runScript(encodePng(scrambled, W, H), SRC_URL)) as Uint8Array;
  const got = decodePng(out);
  assert.deepEqual(Array.from(got.data), Array.from(original), '必须还原出原图');
});

test('③ 早退分支：gif / bookId < 220980 原样返回（不得被二次处理）', async () => {
  const num = numOf(BOOK_ID, IMG_ID);
  const H = num * 8;
  const img = encodePng(makeImage(W, H), W, H);

  const gifSrc = `https://cdn.example.com/media/photos/${BOOK_ID}/${IMG_ID}.gif`;
  const byGif = (await runScript(img, gifSrc)) as Uint8Array;
  assert.deepEqual(Array.from(byGif), Array.from(img), 'gif 应原样返回');

  const smallSrc = 'https://cdn.example.com/media/photos/200000/9.jpg';
  const byId = (await runScript(img, smallSrc)) as Uint8Array;
  assert.deepEqual(Array.from(byId), Array.from(img), 'bookId < 220980 应原样返回');
});

test('④ 数据不合法时必须抛错带原因（不得静默回退原图）', async () => {
  const fakeWebp = new Uint8Array(24);
  fakeWebp.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  fakeWebp.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  await assert.rejects(
    () => runScript(fakeWebp, SRC_URL),
    (e: Error) => {
      assert.match(e.message, /webp|解码/i, `错误信息应说明原因：${e.message}`);
      return true;
    },
    '不合法的 webp 必须显式报错（由引擎层留痕），不能静默回退原图',
  );
});

/**
 * ⑤ **webp 解码**（2026-09-25 补）。
 *
 * 站点的正文图已改成 **webp（有损 VP8）** —— 实测 `/album/303036` 的
 * `…/media/photos/303036/00001.webp`（216924 字节）就是 VP8。而切条还原脚本
 * 必须解码出像素才能重排，所以 `BitmapFactory` 缺 webp 分支时会抛错回退原图：
 * 用户看到「图片还是切条的，没有解密」。
 *
 * 样本是**合成图**（`tmp/gen-webp-fixture.mjs` 用无头 Chrome 的
 * `canvas.toDataURL('image/webp')` 生成，VP8X 容器 + VP8 有损），不引用站点素材。
 */
test('⑤ webp（有损 VP8）能被解码并完成切条重排（不再报「不支持的图片格式」）', async () => {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('./fixtures/sample.webp', import.meta.url))));
  // ⚠️ TypedArray 的 toString 是 join(',')，要看四个 ASCII 字节必须走 Buffer
  assert.equal(Buffer.from(bytes.subarray(12, 16)).toString('latin1'), 'VP8X', '样本应为 VP8X 容器');
  const src = decodeWebp(bytes);
  assert.equal(src.width, 64, 'webp 宽度');
  assert.equal(src.height, 120, 'webp 高度');

  const out = (await runScript(bytes, SRC_URL)) as Uint8Array;
  assert.ok(out && out.length, `脚本应返回字节（说明 webp 已被解码），实际 ${typeof out}`);
  const got = decodePng(out);
  assert.equal(got.w, 64, '重排后宽度必须保持');
  assert.equal(got.h, 120, '重排后高度必须保持');
  assert.notDeepEqual(
    Array.from(got.data),
    Array.from(src.data),
    '输出应与 webp 原图不同 —— 说明确实做了切条重排（而不是原样回退）',
  );
});

/**
 * ⑥ **体积策略**（`#128`，2026-09-25 补）：脚本要 PNG，宿主默认给 JPEG。
 *
 * 用户实测「有些章回有 200+ 照片」⇒ 无损 PNG 下**单话约 480MB**（单张 216KB webp → 2.4MB PNG）。
 * 解密产物是照片类图像，PNG（DEFLATE）在连续色调上几乎压不动，必须改用有损格式承载。
 * 全语料只有 1 个源调 `Bitmap.compress`，且脚本只做 base64 回传、不解析图片头 ⇒ 改格式无感。
 *
 * 这个用例锁三件事：① 默认确实输出 JPEG（SOI 魔数）；② **体积显著更小**；③ 尺寸不变、能解码
 * （证明不是「输出坏了所以小」）。
 */
test('⑥ 体积策略：默认 compress(PNG) 实际输出 JPEG，体积显著更小且可解码', async () => {
  const W2 = 160;
  const H2 = 320;
  // 类照片样本（见 makePhotoLike 的注释：高频噪声图上两者体积接近，看不出策略差异）
  const input = makePhotoLike(W2, H2);
  const pngIn = encodePng(input, W2, H2);

  // ① 无损 PNG 基准
  process.env.YUEDU_BITMAP_OUTPUT = 'png';
  const pngOut = (await runScript(pngIn, SRC_URL)) as Uint8Array;

  // ② 默认（JPEG）
  delete process.env.YUEDU_BITMAP_OUTPUT;
  const jpgOut = (await runScript(pngIn, SRC_URL)) as Uint8Array;
  process.env.YUEDU_BITMAP_OUTPUT = 'png'; // 还原，避免影响其它用例

  assert.equal(jpgOut[0], 0xff, 'JPEG 应以 SOI 0xFF 开头');
  assert.equal(jpgOut[1], 0xd8, 'JPEG 应以 SOI 0xD8 开头');
  assert.ok(
    jpgOut.length * 4 < pngOut.length,
    `JPEG 体积应显著小于 PNG（实际 ${jpgOut.length} vs ${pngOut.length}）`,
  );
  // 能解码 + 尺寸正确 ⇒ 证明是「真的图」，不是输出坏掉所以变小
  const dec = jpegDecode(Buffer.from(jpgOut));
  assert.equal(dec.width, W2, 'JPEG 宽度必须保持');
  assert.equal(dec.height, H2, 'JPEG 高度必须保持');

  // 开关能切回无损（排障路径必须可用）
  assert.equal(pngOut[1], 0x50, 'PNG 应以 0x50（P）开头');
});

/**
 * `#587` 新版禁漫天堂系 `imageDecode`（2026-10-23 用户实测报「图解码失败:
 * TypeError: Packages.android.graphics.Rect is not a constructor」）。
 *
 * 与上面 JM_SCRIPT 的差别：区域搬运从「`Bitmap.createBitmap(img,x,y,w,h)` 裁出子图 +
 * 四参 drawBitmap」换成 **`new Rect(l,t,r,b)` 源/目标双矩形 + 六参 drawBitmap**
 * （`canvas.drawBitmap(bmp, new Rect(0,ys,w,ys+m2), new Rect(0,yd,w,yd+m2), pt)`）。
 * 我们彼时 `android.graphics` 没有 Rect ⇒ `new undefined` ⇒ 整段被源脚本 try 吞掉 ⇒ 回原图。
 * 修法：宿主与 worker 两侧都补 `Rect`（宿主 android-graphics.ts / worker 模板）+ 六参重载
 * （宿主按 Android 语义把 srcRect 区域**缩放**铺进 dstRect；worker 鸭子类型认形后走
 * `op:'drawRegion'` RPC 回宿主唯一实现）。
 *
 * 本锁两层：⑦ 脚本级（走 L1 桥跑**与线上同形态**的脚本，对独立参照实现逐字节比对）；
 * ⑧ 垫片级（直接调 `makeAndroidGraphicsNs`，锁 Rect 字段/宽高与六参搬运落点）。
 */
const CDNGWC_SCRIPT = `
(function(){
 try{
  var U=String(src||'');
  var i=U.indexOf('/media/photos/');
  if(i<0)return result;
  var t=U.substring(i+14);var ps=t.split('/');
  if(ps.length<2)return result;
  var pid=parseInt(ps[0].split('?')[0],10)||0;
  var f=ps[1];if(f==null)return result;
  var fn=f.split('?')[0].split('.')[0];
  var ext='';
  if(f.indexOf('.')>=0)ext=f.split('?')[0].split('.').pop();
  ext=String(ext).toLowerCase();
  if(ext==='gif')return result;
  var n=0;
  if(pid<220980){n=0;}
  else if(pid<268850){n=10;}
  else{var x=pid<421926?10:8;var h=String(java.md5Encode(String(pid)+String(fn)));var c=h.charCodeAt(h.length-1);n=(c%x)*2+2;}
  if(n<=1)return result;
  var bmp=Packages.android.graphics.BitmapFactory.decodeByteArray(result,0,result.length);
  var w=bmp.getWidth(),h=bmp.getHeight();
  var dst=Packages.android.graphics.Bitmap.createBitmap(w,h,Packages.android.graphics.Bitmap.Config.ARGB_8888);
  var cv=new Packages.android.graphics.Canvas(dst);
  var pt=new Packages.android.graphics.Paint();
  var over=h%n;var move=Math.floor(h/n);
  for(var ii=0;ii<n;ii++){
   var m2=move;var ys=h-move*(ii+1)-over;var yd=move*ii;
   if(ii===0){m2+=over;}else{yd+=over;}
   if(ys<0)ys=0;if(ys+m2>h)m2=h-ys;
   if(yd<0)yd=0;if(yd+m2>h)m2=h-yd;
   cv.drawBitmap(bmp,new Packages.android.graphics.Rect(0,ys,w,ys+m2),new Packages.android.graphics.Rect(0,yd,w,yd+m2),pt);
  }
  var bos=new Packages.java.io.ByteArrayOutputStream();
  dst.compress(Packages.android.graphics.Bitmap.CompressFormat.PNG,100,bos);
  return bos.toByteArray();
 }catch(e){
  return result;
 }
})()
`;

/** 复算 cdngwc 脚本的 `n`（pid > 421926 走 md5 分支） */
function cdngwcNumOf(pid: number, fn: string): number {
  const md5 = createHash('md5').update(String(pid) + String(fn)).digest('hex');
  return (md5.slice(-1).charCodeAt(0) % 8) * 2 + 2;
}

/** 参照实现：完全按 cdngwc 脚本的条带数学搬运 RGBA 行（含 clamp） */
function referenceCdngwc(rgba: Uint8Array, W: number, H: number, n: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  const over = H % n;
  const move = Math.floor(H / n);
  for (let ii = 0; ii < n; ii++) {
    let m2 = move;
    let ys = H - move * (ii + 1) - over;
    let yd = move * ii;
    if (ii === 0) m2 += over;
    else yd += over;
    if (ys < 0) ys = 0;
    if (ys + m2 > H) m2 = H - ys;
    if (yd < 0) yd = 0;
    if (yd + m2 > H) m2 = H - yd;
    for (let row = 0; row < m2; row++) {
      const s = (ys + row) * W * 4;
      const d = (yd + row) * W * 4;
      out.set(rgba.subarray(s, s + W * 4), d);
    }
  }
  return out;
}

test('⑦ #587 脚本级：Rect + 六参 drawBitmap 的切条还原与参照实现逐字节一致', async () => {
  const pid = 500000; // > 421926 ⇒ md5 分支
  const fn = '00001';
  const n = cdngwcNumOf(pid, fn);
  assert.ok(n >= 2, `n 应 ≥ 2，实际 ${n}`);
  const H = n * 5 + 3; // 故意留余数：夹紧逻辑必须被走到
  const input = makeImage(W, H);

  const out = (await runCdngwcScript(encodePng(input, W, H), `https://cdn-msp.example.com/media/photos/${pid}/${fn}.webp`)) as Uint8Array;
  assert.ok(out && out.length, '脚本应返回字节');
  const got = decodePng(out);
  const want = referenceCdngwc(input, W, H, n);

  assert.equal(got.w, W, '宽度必须保持');
  assert.equal(got.h, H, '高度必须保持');
  assert.deepEqual(Array.from(got.data), Array.from(want), '像素必须与参照实现完全一致');
  // 防空转：Rect 再缺失 ⇒ 脚本 catch 后原图直返 ⇒ 这条必红（#587 的病态）
  assert.notDeepEqual(Array.from(got.data), Array.from(input), '输出不应与输入相同（说明 Rect 六参路径真的干活了）');
});

test('⑧ #587 垫片级：Rect 字段/宽高 + drawBitmap(bmp, src, dst, paint) 区域搬运落点', () => {
  const gfx = makeAndroidGraphicsNs() as unknown as {
    Rect: new (l?: number, t?: number, r?: number, b?: number) => {
      left: number; top: number; right: number; bottom: number;
      width(): number; height(): number; isEmpty(): boolean;
    };
    Bitmap: { createBitmap: (w: number, h: number) => AndroidBitmap };
    Canvas: new (t: unknown) => { drawBitmap: (...args: unknown[]) => void };
  };

  const r = new gfx.Rect(2, 3, 9, 7);
  assert.equal(r.left, 2, 'left 字段');
  assert.equal(r.top, 3, 'top 字段');
  assert.equal(r.right, 9, 'right 字段');
  assert.equal(r.bottom, 7, 'bottom 字段');
  assert.equal(r.width(), 7, 'width()');
  assert.equal(r.height(), 4, 'height()');
  assert.equal(r.isEmpty(), false, '非空矩形');

  // 源图 4×4：每行一个标记色（R = 行号 × 10）
  const src = gfx.Bitmap.createBitmap(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const o = (y * 4 + x) * 4;
      src.data[o] = y * 10;
      src.data[o + 1] = 100;
      src.data[o + 2] = 100;
      src.data[o + 3] = 255;
    }
  }
  // 目标：新建空白 4×4（透明）
  const dst = gfx.Bitmap.createBitmap(4, 4);
  const cv = new gfx.Canvas(dst);
  // 把源第 1~2 行（Rect(0,1,4,3)）搬到目标第 2 行起（Rect(0,2,4,4)）
  cv.drawBitmap(src, new gfx.Rect(0, 1, 4, 3), new gfx.Rect(0, 2, 4, 4), null);
  for (let x = 0; x < 4; x++) {
    assert.equal(dst.data[(2 * 4 + x) * 4], 10, `目标第 3 行第 ${x} 列应来自源第 2 行`);
    assert.equal(dst.data[(3 * 4 + x) * 4], 20, `目标第 4 行第 ${x} 列应来自源第 3 行`);
  }
  // 未写区域不被碰（Android 语义：只画 srcRect∩dstRect）
  assert.equal(dst.data[3], 0, '目标第 1 行必须保持透明（没写过）');
  assert.equal(dst.data[7], 0, '目标第 2 行必须保持透明（没写过）');
});
