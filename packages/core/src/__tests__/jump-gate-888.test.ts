/**
 * `#888` 「安全跳转」PoW-Cookie 闸页（蜜橘视频 `*.mmo170.shop`）。
 *
 * 取证用真页面片段：salt/迭代上限/前缀/Cookie 名/跳转基址都按线上原样。
 * 自校验：页面里 `<a id="btn" href="…jpp=salt.4149">` 是站点自己算好的值 ⇒
 * 我们的求解必须**也**落在 4149（第一个满足前 3 hex=000 的 n），对不上说明 FNV 实现错了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a32Hex, planJumpPowGate } from '../net/gate-pass';

const SALT = '1795793184.50791d8d6b9a.401e0d8a82634b26';

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><title>安全跳转</title>
<script>
  (function() {
    var c = "${SALT}";
    function h(s) {
      var x = 0x811c9dc5;
      for (var i = 0; i < s.length; i++) {
        x ^= s.charCodeAt(i);
        x = Math.imul(x, 0x01000193) >>> 0;
      }
      return ("0000000" + x.toString(16)).slice(-8);
    }
    for (var n = 0; n < 5000000; n++) {
      if (h(c + ":" + n).slice(0, 3) === "000") {
        var a = c + "." + n;
        document.cookie = "jpp=" + a + ";path=/;max-age=600;SameSite=Lax";
        window.__jgq = "&jpp=" + encodeURIComponent(a);
        break;
      }
    }
  })();
</script></head>
<body>
  <div class="status" id="status">验证浏览器...</div>
  <a href="https://xn--1107-4com-gn9pt9pkt6cfa923hbxn8j1g.mmo170.shop/?mod=jump&amp;jpp=${SALT}.4149" class="btn" id="btn">立即跳转</a>
  <script>
    setTimeout(function() {
      window.location.href = "https://xn--1107-4com-gn9pt9pkt6cfa923hbxn8j1g.mmo170.shop/?mod=jump" + (window.__jgq || "");
    }, 5500);
  </script>
</body></html>`;

test('#888 ① FNV-1a 与页面脚本逐位一致（站点自己算的 4149 必须命中）', () => {
  assert.equal(fnv1a32Hex(`${SALT}:4149`), '00019b37');
  assert.ok(fnv1a32Hex(`${SALT}:4149`).startsWith('000'), '前 3 个 hex 是 000 才符合页面判据');
  // 逆证：4148 不该命中（否则「首个命中=4149」这个自校验就没意义）
  assert.ok(!fnv1a32Hex(`${SALT}:4148`).startsWith('000'));
});

test('#888 ② 解析闸页：算出 jpp Cookie + 跳转目标', () => {
  const plan = planJumpPowGate(PAGE, 'https://xn--1107-4com-gn9pt9pkt6cfa923hbxn8j1g.mmo170.shop/');
  assert.ok(plan, '应当识别为安全跳转闸页');
  assert.equal(plan!.nonce, 4149, '与站点锚点里的 n 一致');
  assert.equal(plan!.cookie, `jpp=${SALT}.4149`);
  const u = new URL(plan!.target);
  assert.equal(u.searchParams.get('mod'), 'jump', '目标是 mod=jump 那条跳转');
  assert.equal(u.searchParams.get('jpp'), `${SALT}.4149`, 'jpp 参数带在目标上');
  assert.match(u.host, /mmo170\.shop$/, '目标仍是原站（不是别的域）');
});

test('#888 ③ 触发面从严：普通页面 / 只有 mod=jump / 只有 FNV 常量都不认', () => {
  assert.equal(planJumpPowGate('<html><body>正常页面</body></html>', 'https://a.test/'), null);
  // 只有 mod=jump（很多站的分页链接都长这样）
  assert.equal(planJumpPowGate('<html><a href="?mod=jump&id=1">x</a></html>', 'https://a.test/'), null);
  // 只有 FNV 常量（比如某个统计脚本）
  assert.equal(
    planJumpPowGate('<html><script>var x=0x811c9dc5;var y=0x01000193;</script></html>', 'https://a.test/'),
    null,
  );
  // 缺跳转基址
  const noBase = PAGE.replace(/window\.location\.href[\s\S]*?\}, 5500\);/, '');
  assert.equal(planJumpPowGate(noBase, 'https://a.test/'), null);
});
