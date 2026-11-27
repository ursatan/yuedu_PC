/**
 * `#677` 选择器探针的两处口径（物料源码查看器用户实测）：
 *
 * ① **样本条数/长度必须可调**：旧实现固定回 3 条 220 字（那是给「0 命中的候选预览」定的），
 *    而查看器要的是「命中多少就列多少」⇒ 用户看到「命中 10 项，下面只显示 3 项」。
 * ② **取值规则要回值**：`img@src` / `a@text` 在 `getElements` 里必然 0 命中
 *    （它把 `@src` 当标签名再选一次，上游 `getElements` 的 `@` 分段语义就这样），
 *    而引擎取值走的是 `getStringList`。所以 `valueMode` 下改走「head 选元素 + tail 逐项取值」，
 *    元素 HTML 另放 `htmlSamples`（查看器拿它定位源码、当二次匹配的物料）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeSelector } from '../diag/probe';

const HTML =
  '<div class="item"><a href="/399/"><img alt="A" src="https://x/a.jpg"></a>'
  + '<div class="itemtxt"><h3 class="book"><a href="/399/">我在精神病</a></h3></div></div>'
  + '<div class="item"><a href="/400/"><img alt="B" src="https://x/b.jpg"></a></div>';

test('P-① 默认仍只回 3 条（别的调用方靠这个省流量）', async () => {
  const html = Array.from({ length: 10 }, (_, i) => `<div class="row">第${i}行</div>`).join('');
  const r = await probeSelector({ selector: '.row', content: html });
  assert.equal(r.hitCount, 10);
  assert.equal(r.samples.length, 3);
});

test('P-② sampleLimit / sampleMax 放开后能给全量', async () => {
  const html = Array.from({ length: 10 }, (_, i) => `<div class="row">第${i}行</div>`).join('');
  const r = await probeSelector({ selector: '.row', content: html, sampleLimit: 100, sampleMax: 4000 });
  assert.equal(r.hitCount, 10);
  assert.equal(r.samples.length, 10);
  assert.equal(r.samples[9], '<div class="row">第9行</div>');
});

test('P-③ 值模式：img@src 回 src（旧口径是 0 命中）', async () => {
  const plain = await probeSelector({ selector: 'img@src', content: HTML, sampleLimit: 10 });
  assert.equal(plain.hitCount, 0, 'getElements("img@src") 必然 0（@src 被当标签名）—— 这是上游语义，不是 bug');

  const r = await probeSelector({ selector: 'img@src', content: HTML, valueMode: true, sampleLimit: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.hitCount, 2);
  assert.deepEqual(r.samples, ['https://x/a.jpg', 'https://x/b.jpg']);
  // 元素 HTML 必须同时在（查看器用它定位源码 / 当二次匹配物料）
  assert.match(String(r.htmlSamples?.[0]), /^<img [^>]*src="https:\/\/x\/a\.jpg"/);
});

test('P-④ 值模式：a@text 回文本，不是节点 HTML', async () => {
  const r = await probeSelector({ selector: 'a@text', content: HTML, valueMode: true, sampleLimit: 10 });
  assert.equal(r.hitCount, 3);
  assert.ok(r.samples.includes('我在精神病'), `应含书名文本，实际：${JSON.stringify(r.samples)}`);
  assert.ok(!r.samples.some((s) => s.startsWith('<')), '值模式不该回节点 HTML');
});

test('P-⑤ 值模式对**纯选择器**不生效：列表规则仍回卡片 HTML（二次匹配要用）', async () => {
  const r = await probeSelector({ selector: '.item', content: HTML, valueMode: true, sampleLimit: 10 });
  assert.equal(r.hitCount, 2);
  assert.match(r.samples[0] ?? '', /^<div class="item">/);
  assert.deepEqual(r.htmlSamples, r.samples);
});

test('P-⑥ 值模式：末段是选择续段时按「head 选元素 + tail 继续取」切（class.item@tag.a@href）', async () => {
  const r = await probeSelector({ selector: 'class.item@tag.a@href', content: HTML, valueMode: true, sampleLimit: 10 });
  assert.equal(r.hitCount, 3);
  assert.deepEqual(r.samples, ['/399/', '/399/', '/400/']);
});

test('P-⑦ `h3@a` 在引擎里是**空**（末段当属性名），要文字必须 `@text`（`#678` 用户质疑）', async () => {
  const html = '<div class="itemtxt"><h3><b>06</b><a href="/220/">神秘复苏</a></h3></div>';
  /**
   * 用户看到查看器把 `h3@a` 显示成「神秘复苏」后质疑：不是应该 `h3@a@text` 才取文字么？
   * 对。上游 `getResultList` 先按 `@` 切，最后一段交给 `getResultLast`：
   * 非关键字 ⇒ `element.attr(lastRule)` ⇒ `attr("a")` ⇒ 空。
   */
  const bare = await probeSelector({ selector: 'h3@a', content: html, valueMode: true });
  assert.equal(bare.hitCount, 1, '元素命中 1 个（h3）');
  assert.deepEqual(bare.samples, [''], '值必须为空（旧实现错把它当选择器取文本）');
  assert.match(String(bare.note), /属性名/, '要对「全空」给出解释：末段一律当属性名');

  const text = await probeSelector({ selector: 'h3@a@text', content: html, valueMode: true });
  assert.deepEqual(text.samples, ['神秘复苏']);

  const href = await probeSelector({ selector: 'h3@a@href', content: html, valueMode: true });
  assert.deepEqual(href.samples, ['/220/']);
});
