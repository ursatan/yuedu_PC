/**
 * `#702` 回归锁：图片代理可以**换 origin**（`127.0.0.1` ↔ `localhost`），且默认仍是同源。
 *
 * ## 为什么要换
 * 浏览器对**同一个 origin** 只给 6 条 HTTP/1.1 连接。图片全走同源 `/api/proxy` ⇒
 * 一页几十张慢图（用户实测 `www.tkshuw.com`，每张 8~10s）把 6 条吃满 ⇒
 * 心跳 `/api/engines` 拿不到连接、15s 超时 ⇒ 侧栏「服务离线」。
 * 实测（`tmp/probe702-connstarve.mjs`）：空载 155ms / 6 张慢图在飞 **3384ms** / 2 张在飞 20ms。
 *
 * ## 本文件锁什么
 *  1. 默认（未设置 origin）→ **相对地址**，行为与从前完全一致（零回归）；
 *  2. 设置后 → **绝对地址**，且 `/api/proxy` 之后的查询串一字不变；
 *  3. `data:`/相对/`blob:` 这类不走代理的地址**不受影响**（它们本来就不出网）；
 *  4. 传空串能清回去（自检失败时的回落路径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageProxyOriginValue, imgSrc, setImageProxyOrigin } from '../src/utils/img';

const IMG = 'https://img.example.com/a.jpg';

test('#702① 默认同源：相对地址（与旧行为逐字一致）', () => {
  setImageProxyOrigin('');
  assert.equal(imageProxyOriginValue(), '');
  assert.equal(imgSrc(IMG), `/api/proxy?u=${encodeURIComponent(IMG)}`);
});

test('#702② 设置 origin ⇒ 绝对地址，查询串不变', () => {
  setImageProxyOrigin('http://localhost:3000');
  const out = imgSrc(IMG, { sourceId: 's1', cover: true });
  assert.ok(out.startsWith('http://localhost:3000/api/proxy?'), out);
  // 去掉 origin 之后必须与同源版本逐字相同
  setImageProxyOrigin('');
  const rel = imgSrc(IMG, { sourceId: 's1', cover: true });
  assert.equal(out.slice('http://localhost:3000'.length), rel);
});

test('#702③ 尾部多余斜杠会被吃掉（不会拼出 `//api/proxy`）', () => {
  setImageProxyOrigin('http://localhost:3000/');
  assert.equal(imageProxyOriginValue(), 'http://localhost:3000');
  assert.ok(imgSrc(IMG).startsWith('http://localhost:3000/api/proxy?'));
});

test('#702④ 不走代理的地址不受 origin 影响（data:/blob:/根相对）', () => {
  setImageProxyOrigin('http://localhost:3000');
  assert.equal(imgSrc('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  assert.equal(imgSrc('blob:http://x/abc'), 'blob:http://x/abc');
  assert.equal(imgSrc('/local/a.png'), '/local/a.png');
  // 带 sourceId 的 data:image 是例外：要走代理做解密 ⇒ 也该带上新 origin
  assert.ok(imgSrc('data:image/png;base64,AAA', { sourceId: 's1' }).startsWith('http://localhost:3000/api/proxy?'));
});

test('#702⑤ 传空串能清回同源（自检失败时的回落路径）', () => {
  setImageProxyOrigin('http://localhost:3000');
  setImageProxyOrigin('');
  assert.equal(imgSrc(IMG), `/api/proxy?u=${encodeURIComponent(IMG)}`);
});
