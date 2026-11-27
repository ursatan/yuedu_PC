/**
 * `#731` 断点 1：**阿里云 WAF 挑战页**必须被认出来（此前 `401 + 1055 字节` 的挑战页当正文解析）。
 *
 * 事故（用户实测 Aff）：
 *   `[antibot-check] 401 bodyLen=1055` 之后什么都不发生 —— 既不判反爬、也不开验证窗，
 *   挑战页被当成正文 ⇒ 列表静默 0 条。
 *
 * 判据必须同时满足两条：**状态码在拦截集合里** + **页面有 WAF 特征**（不是普通 401 JSON）。
 * 体积门：`访问频率太高 / 请输入验证码` 这类文案在正常登录页里很常见，只在小页面才认。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChallengePage } from '../diag/self-fetch';

function page(size: number, head = '', body = ''): string {
  const pad = 'x'.repeat(Math.max(0, size - head.length - body.length - 80));
  return `<!DOCTYPE html><html><head><title>验证</title>${head}</head><body>${body}${pad}</body></html>`;
}

test('#731 ①：__wafcaptcha / acw_sc__v2 / aliyungf_tc 均识别为阿里云 WAF', () => {
  for (const marker of ['__wafcaptcha', 'acw_sc__v2', 'aliyungf_tc', 'aliyun_waf']) {
    const r = isChallengePage(page(1055, `<script>window.${marker}=1;</script>`));
    assert.equal(r.challenge, true, `${marker} 必须被判成挑战页（用户实测的就是这一类）`);
    assert.match(String(r.via), /阿里云 WAF/, `via 要能说清是哪一类 WAF：${marker}`);
  }
});

test('#731 ②：「访问频率太高 / 请输入验证码」只在**小页面**才认（体积门）', () => {
  const small = page(1_055, '', '访问频率太高，请输入验证码');
  assert.equal(isChallengePage(small).challenge, true);
  assert.match(String(isChallengePage(small).via), /阿里云 WAF/);

  // 正常的大页面里也可能出现这句文案（帮助文本 / 登录说明）⇒ 不能误判
  const big = page(60_000, '', '请输入验证码');
  assert.equal(isChallengePage(big).challenge, false, '大页面里的「请输入验证码」不算挑战页');
});

test('#731 ③：SafeLine（雷池）特征仍识别（与阿里云同批收敛）', () => {
  const r = isChallengePage(page(4_000, '<script src="/.safeline/static/js/main.js"></script>'));
  assert.equal(r.challenge, true);
  assert.match(String(r.via), /SafeLine/);
});

test('#731 ④：无 WAF 特征的普通页面保持 false（不误伤）', () => {
  assert.equal(isChallengePage(page(1_055, '', '登录已失效，请重新登录')).challenge, false);
  assert.equal(isChallengePage('').challenge, false);
});
