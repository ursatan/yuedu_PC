/**
 * L4 worker 池专项测试：
 *  1) 基础求值 + 绑定传递
 *  2) java.ajax 经宿主 RPC（异步 HTTP 桥）
 *  3) 硬超时 terminate（死循环脚本）
 *  4) createSymmetricCrypto（worker 内加密）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockSamples, resetBlocks } from '../diag/block-stats';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';

const pool = createWorkerSandboxPool({ size: 2, defaultTimeoutMs: 3000 });

test('worker: 基础求值 + result 绑定', async () => {
  const r = await pool.eval<unknown>({ code: 'result + "!"', bindings: { result: '剑来' } });
  assert.equal(r, '剑来!');
});

test('worker: java.ajax 经宿主 RPC 桥（异步 http）', async () => {
  const r = await pool.eval<string>({
    code: 'String(java.ajax("https://mock.local/api"))',
    bindings: {},
    rpc: async (method, args) => {
      assert.equal(method, 'http');
      const a = args as { url: string };
      assert.equal(a.url, 'https://mock.local/api');
      return { body: 'hello-from-host', headers: { 'x-test': '1' }, code: 200 };
    },
  });
  assert.equal(r, 'hello-from-host');
});

test('worker: java.ajax 选项尾巴（,{method/body/headers}）经 RPC 传给宿主', async () => {
  // 与 L1 同一份 URL_PREP_SOURCE 注入 worker —— 绿柠小说那种「ajaxAll 每项带 POST body」
  // 在开池时必须与不开池行为一致（此前 worker 侧手抄副本会漂移）
  const seen: Array<{ method?: string; url?: string; body?: string; headers?: Record<string, string> }> = [];
  const raw = 'https://mock.local/api,{"method":"POST","body":"id=60&pagesize=10","headers":{"sign":"s"}}';
  const r = await pool.eval<string>({
    code: `String(java.ajax(${JSON.stringify(raw)}))`,
    bindings: {},
    rpc: async (method, args) => {
      assert.equal(method, 'http');
      seen.push(args as { method?: string; url?: string; body?: string });
      return { body: 'ok', headers: {}, code: 200 };
    },
  });
  assert.equal(r, 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, 'POST', 'method 取自选项尾巴');
  assert.equal(seen[0]?.url, 'https://mock.local/api', 'URL 剥离尾巴');
  assert.equal(seen[0]?.body, 'id=60&pagesize=10', 'body 取自选项尾巴');
  assert.equal((seen[0]?.headers ?? {})['sign'], 's', 'headers 取自选项尾巴');
});

test('worker: StrResponse 链式语义（.body()/.headers()/.code()）', async () => {
  const r = await pool.eval<unknown>({
    code: 'var resp = java.connect("https://mock.local/x"); [resp.body(), resp.headers()["content-type"], resp.code()].join("|")',
    bindings: {},
    rpc: async () => ({ body: 'BODY', headers: { 'content-type': 'text/html' }, code: 200 }),
  });
  assert.equal(r, 'BODY|text/html|200');
});

test('worker: java.getString 经宿主规则桥', async () => {
  const r = await pool.eval<string>({
    code: 'java.getString("静态规则值")',
    bindings: { $: { a: 1 } },
    rpc: async (method, args) => {
      assert.equal(method, 'evalRule');
      const a = args as { rule: string };
      return 'host:' + a.rule;
    },
  });
  assert.equal(r, 'host:静态规则值');
});

test('worker: 死循环脚本被硬超时 terminate（JS_TIMEOUT）', async () => {
  await assert.rejects(
    () => pool.eval({ code: 'while(true){}' }),
    (e: unknown) => String((e as Error).message).includes('JS_TIMEOUT') || String((e as Error).message).includes('sandbox eval failed') || String((e as Error).message).includes('worker 意外退出'),
  );
});

test('worker: 加密桥（AES/CBC worker 内执行，roundtrip）', async () => {
  const r = await pool.eval<string>({
    code: 'var c = java.createSymmetricCrypto("AES/CBC/PKCS5Padding", "0123456789abcdef", "abcdef9876543210"); c.decryptBase64(c.encryptBase64("secret"))',
    bindings: {},
  });
  assert.equal(r, 'secret');
});

// 回归：decryptStr 必须吃字节数组（Legado 源写法 decryptStr(java.hexDecodeToByteArray(data))）。
// 此前 String(Uint8Array) 拼成 "18,52,…" → wrong final block length → 点众阅读类源全挂。
test('worker: decryptStr 接收字节数组（hexDecodeToByteArray 桥）+ encrypt 返回字节', async () => {
  const r = await pool.eval<string>({
    code: [
      'var c = java.createSymmetricCrypto("AES/CBC/Pkcs7Padding", "dzkjgfyxgshylgzm", "apiupdownedcrypt");',
      'var bytes = Array.from(c.encrypt(JSON.stringify({a: 1})));', // encrypt → 字节数组（hutool 语义）
      'var hex = bytes.map(function(b){var h=(b & 255).toString(16); return h.length < 2 ? "0" + h : h;}).join("");',
      'var plain = c.decryptStr(java.hexDecodeToByteArray(hex));',
      '(plain === JSON.stringify({a: 1})) + "|" + typeof c.encrypt("x")',
    ].join('\n'),
    bindings: {},
  });
  assert.equal(r, 'true|object');
});

// 回归：L1 与 worker 的 java API 面必须一致（worker 缺 randomUUID/HMac/digestBase64Str 等
// 会静默返回 ''，造成「直连好好的、开池就坏」的 A/B 漂移）
test('worker: java API 面与 L1 对齐（不再静默丢方法）', async () => {
  const r = await pool.eval<string>({
    code: [
      'var missing = [];',
      '["randomUUID","base64DecodeToByteArray","hexDecodeToString","hexEncodeToString","digestBase64Str","HMacHex","HMacBase64","encodeURI","decodeURI","getWebViewUA","aesBase64DecodeToString","digestHex","getStrResponse","ajaxAll","webViewGetSource","strToBytes","bytesToStr","hexDecodeToByteArray","toNumChapter","t2s","s2t"].forEach(function(k){',
      '  var v = java[k]; if (typeof v !== "function") missing.push(k); });',
      'var uuid = java.randomUUID();',
      '(missing.length === 0) + "|" + (uuid.length === 36) + "|" + java.HMacHex("data", "HmacSHA256", "key").length + "|" + java.digestBase64Str("data", "SHA-256").length',
    ].join('\n'),
    bindings: {},
  });
  assert.equal(r, 'true|true|64|44');
});

/**
 * `#400` 回归：worker `java.hexDecodeToString` 必须与 L1 `hexStrict` / 上游 Hutool 同语义。
 * 旧实现 try/catch 静默返回空串 ⇒ 源脚本拿空 URL 继续跑（静默错值）；上游对非法 hex 抛错。
 * 对偶：合法 hex 正常解码、空串原样返回、奇数长度前补 0。
 */
test('worker: hexDecodeToString 对非法 hex 抛错（与 L1/上游同语义）+ 合法解码', async () => {
  const bad = await pool.eval<string>({
    code: 'try { java.hexDecodeToString("6a/x"); "no-throw" } catch (e) { String(e.message) }',
    bindings: {},
  });
  assert.match(bad, /Illegal hexadecimal character/);

  const ok = await pool.eval<string>({
    code: '[java.hexDecodeToString("e58991"), java.hexDecodeToString(""), java.hexDecodeToString("5")].join("|")',
    bindings: {},
  });
  assert.equal(ok, '剑||\u0005');
});

test('worker: 多并发求值互不串扰', async () => {
  const rs = await Promise.all(
    Array.from({ length: 5 }, (_, i) => pool.eval<string>({ code: '"n" + page', bindings: { page: i } })),
  );
  assert.deepEqual(rs.sort(), ['n0', 'n1', 'n2', 'n3', 'n4']);
});

/**
 * `#779` D 回归：求值画像要能区分「纯计算到顶」与「宿主 RPC 排队」。
 *  · `sandbox-host`：宿主 RPC 处理时长（已从预算扣除）
 *  · `sandbox-rpc-lag`：worker 发出 RPC → 宿主收到，宿主事件循环排队
 *  · `sandbox-eval`：`wall - host`，超时恒记（含 timeout 标记）
 */
test('worker: #779 诊断画像（host/rpcLag/evalMs）', async () => {
  resetBlocks();
  // 1) 宿主 RPC 慢 300ms：应记 sandbox-host（≥250ms），且 eval 不计这 300ms
  const r = await pool.eval<string>({
    code: 'String(java.ajax("https://mock.local/slow"))',
    bindings: {},
    rpc: async () => {
      await new Promise((res) => setTimeout(res, 300));
      return { body: 'ok', headers: {}, code: 200 };
    },
  });
  assert.equal(r, 'ok');
  const host = blockSamples().filter((s) => s.kind === 'sandbox-host');
  assert.equal(host.length, 1);
  assert.ok(host[0]!.ms >= 250, `hostMs 应 ≥250，实际 ${host[0]!.ms}`);
  assert.match(host[0]!.detail, /rpc=1/);

  // 2) 纯计算超时：应记 sandbox-eval 且带 timeout 标记
  resetBlocks();
  const tiny = createWorkerSandboxPool({ size: 1, defaultTimeoutMs: 500 });
  await assert.rejects(
    () => tiny.eval({ code: 'while(true){}' }),
    (e: unknown) => String((e as Error).message).includes('JS_TIMEOUT'),
  );
  const evals = blockSamples().filter((s) => s.kind === 'sandbox-eval');
  assert.ok(evals.length >= 1);
  const last = evals[evals.length - 1]!;
  assert.match(last.detail, /timeout/);
  assert.ok(last.ms >= 400, `evalMs 应接近 500，实际 ${last.ms}`);
});

test('worker: java.webView 走宿主 render 通道（WebViewProvider 桥）', async () => {
  const r = await pool.eval<string>({
    code: 'String(java.webView("https://spa.example/page"))',
    bindings: {},
    rpc: async (method, args) => {
      assert.equal(method, 'render'); // 走 render 而非 http
      const a = args as { url: string };
      assert.equal(a.url, 'https://spa.example/page');
      return { body: '<html><body>渲染后的内容</body></html>', headers: {}, code: 200 };
    },
  });
  assert.ok(r.includes('渲染后的内容'));
});

/**
 * `#636` Script 分支回归：libGlobalNames 源的一次求值**不得**在 realm 全局留下
 * 删不掉的绑定（旧实现是 Script 顶层 `var __yueduRet`）。
 *
 * 那种 var 在 vm 全局上 `delete` 恒为 false ⇒ reset() 清不掉 ⇒ 之后 runner 里
 * `with(scope){ x = eval(code) }` 的赋值沿原型链写到该全局属性、局部变量恒空
 * ⇒ **同一 worker 之后所有求值都返回 undefined**（实测：`{{page}}` 变空串，
 * 表现为「URL 非法」、Cin 的 `//` 变 404 被误判 WAF、SF 400 等一整族症状）。
 */
/**
 * `#785` Script 分支回归：顶层 `var` 的赋值必须落**全局**。
 *
 * 旧实现是 `with(__yueduP.scope){ eval(code) }`，而 scopeObj 的原型链连到 realm 全局：
 * 顶层 `var bucket` hoist 到全局后，`bucket = []` 会在 scopeObj 上新建自有属性
 * （实测 global=undefined / scope=[]）⇒ 只看得见全局的闭包（间接 eval / de.js 载荷里的
 * Data()/push()）读到 undefined，抛 reading 'push'（qyyuapi 分类实测的那一条）。
 */
test('worker: libGlobalNames 顶层 var 赋值落全局（全局闭包可见）', async () => {
  const solo = createWorkerSandboxPool({ size: 1, defaultTimeoutMs: 8000 }) as unknown as {
    eval: (o: Record<string, unknown>) => Promise<unknown>;
    dispose?: () => Promise<void>;
  };
  try {
    const r = await solo.eval({
      code: 'var bucket; bucket = []; globalThis.reader = function () { return bucket; }; String(reader().push("x"))',
      bindings: {},
      lib: 'var libFlag = 1; function Get() { return "g"; }',
      chain: true,
      libGlobalNames: true,
      vm: true,
    });
    assert.equal(r, '1');
    // 与上面 #636 用例同判据：本次注入的绑定不得污染同 worker 的后续求值
    assert.equal(await solo.eval({ code: '2*3', vm: true }), 6);
    assert.equal(await solo.eval({ code: 'page', bindings: { page: 4 }, vm: true }), 4);
  } finally {
    await solo.dispose?.();
  }
});

test('worker: libGlobalNames 求值后同一 worker 仍能正确求值（realm 不被污染）', async () => {
  const solo = createWorkerSandboxPool({ size: 1, defaultTimeoutMs: 8000 }) as unknown as {
    eval: (o: Record<string, unknown>) => Promise<unknown>;
    dispose?: () => Promise<void>;
  };
  try {
    assert.equal(await solo.eval({ code: '2*3', vm: true }), 6);
    const r = await solo.eval({
      code: 'String(result)',
      bindings: { result: 'ok' },
      lib: 'var foo = 1;',
      chain: true,
      libGlobalNames: true,
      vm: true,
    });
    assert.equal(r, 'ok');
    assert.equal(await solo.eval({ code: '2*3', vm: true }), 6);
    assert.equal(await solo.eval({ code: 'page', bindings: { page: 4 }, vm: true }), 4);
  } finally {
    await solo.dispose?.();
  }
});
