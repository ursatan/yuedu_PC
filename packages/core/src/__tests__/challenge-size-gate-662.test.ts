/**
 * `#662` 挑战页判据的**体积门**：`ddos-guard` / `challenge-platform` 这类字样
 * 会出现在**正常页面**的脚本引用里（站点全站挂了 DDoS-Guard / Turnstile）。
 *
 * ## 事故
 * 用户实测 Aff：分类页 **84KB**、正文页 **200KB+** 被判成「DDoS-Guard / captcha 拦截页」
 * ⇒ 引擎以为每次都在撞盾 ⇒ 一个请求接一个请求去「过闸」（日志刷屏、反复弹验证窗），
 * 而实际上页面早就正常了。用户的原话：「为什么会不停过闸页？不是过一次就可以了？」
 *
 * ## 判据
 * 真正的挑战页只有 2~6KB；「泛化特征」必须配体积门（`maxLen`），
 * 而 `just a moment` / `attention required` 这类高特异措辞不受门限。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChallengePage } from '../diag/self-fetch';

/** 造一个「正常页面」：体积可控、正文里带盾方脚本引用（真实站点的形态） */
function page(size: number, extra = ''): string {
  const body = 'x'.repeat(Math.max(0, size - 400));
  return `<!DOCTYPE html><html><head><title>某站点</title>${extra}</head><body><div id="content">${body}</div></body></html>`;
}

test('#662 ①：大页面里的 challenge-platform / ddos-guard 不算挑战页', () => {
  const big = page(84_000, '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>');
  assert.equal(isChallengePage(big).challenge, false, '84KB 正常页不该被判成拦截页');

  const big2 = page(200_000, '<script>window._ddg_=1;</script><script src="/ddos-guard.js"></script>');
  assert.equal(isChallengePage(big2).challenge, false, '200KB 正常页不该被判成拦截页');
});

test('#662 ②：小页面里的同类字样仍算挑战页（真闸页只有 2~6KB）', () => {
  const small = page(2_500, '<script src="https://challenge-platform.example/x.js"></script>');
  assert.equal(isChallengePage(small).challenge, true);
  assert.match(String(isChallengePage(small).via), /DDoS-Guard/);

  const smallDdg = page(3_000, '<div class="ddos-guard">checking</div>');
  assert.equal(isChallengePage(smallDdg).challenge, true);
});

test('#662 ③：高特异措辞不受体积门限制（Just a moment 出现在大页也算）', () => {
  const big = page(50_000, '<title>Just a moment...</title>');
  assert.equal(isChallengePage(big).challenge, true, 'Just a moment 是硬特征，不看体积');
});

test('#662 ④：普通页面（无盾方字样）保持 false', () => {
  assert.equal(isChallengePage(page(84_000)).challenge, false);
  assert.equal(isChallengePage('').challenge, false);
});
