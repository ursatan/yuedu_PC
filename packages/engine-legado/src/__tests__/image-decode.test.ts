/**
 * 图片二次解密测试（对齐 Legado ImageUtils.decode / ContentRule.imageDecode）
 *  ① AES/CBC/NoPadding（51漫画写法：key/iv 由 charCode 拼出）
 *  ② AES/CBC/PKCS7（漫蛙写法：key=iv，且依赖 cache.get 绑定）
 *  ③ 恒等规则（`result`，七猫写法）原样返回
 *  ④ 未声明规则 → null（调用方回传原图）
 *  ⑤ 规则抛错/返回非法类型 → null（不让解密失败打断阅读）
 *  ⑥ content() 回传 imageDecode 标记（前端据此走服务端代理）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv } from 'node:crypto';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  createWorkerSandboxPool,
} from '@yuedu/core';

const BASE = 'https://img.test';

function makeCtx(pages: Record<string, string> = {}): EngineContext {
  return {
    reqId: 'img-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        const body = pages[url] ?? pages['*'] ?? '<html><body></body></html>';
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

/** 与源脚本同构的 key（102_53_... → 'f5d9...'） */
const KEY51 = '102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48'
  .split('_')
  .map((n) => String.fromCharCode(parseInt(n, 10)))
  .join('');
const IV51 = '57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49'
  .split('_')
  .map((n) => String.fromCharCode(parseInt(n, 10)))
  .join('');

/** 造一张假图（0xFFD8FF... 的 JPEG 头 + 若干字节，长度对齐 16 的倍数供 NoPadding 用） */
const PLAIN = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(60, 7),
]);

function aesEncrypt(plain: Buffer, key: string, iv: string, algo = 'aes-128-cbc', pad = true): Buffer {
  const c = createCipheriv(algo, Buffer.from(key, 'utf-8'), Buffer.from(iv, 'utf-8'));
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(plain), c.final()]);
}

function makeRule(imageDecode: string, over: Record<string, unknown> = {}) {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '图片解密源',
    bookSourceType: 2,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: 'div.pages@html', imageDecode },
    ...over,
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

test('图片解密①: AES/CBC/NoPadding（51漫画写法）解出原始字节', async () => {
  const encrypted = aesEncrypt(PLAIN, KEY51, IV51, 'aes-128-cbc', false);
  const js = `function decryptImage(src) {
  const key = "102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48".split("_").map(n => String.fromCharCode(parseInt(n))).join("");
  const iv  = "57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49".split("_").map(n => String.fromCharCode(parseInt(n))).join("");
  const cipher = java.createSymmetricCrypto("AES/CBC/NoPadding", key, iv);
  return cipher.decrypt(src);
}
decryptImage(result);`;
  const rule = makeRule(js);
  const out = await new LegadoEngine().decodeImage(
    rule as never,
    { url: `${BASE}/i/1.jpg`, bytes: new Uint8Array(encrypted) },
    makeCtx(),
  );
  assert.ok(out, '应返回解密结果');
  assert.deepEqual(Buffer.from(out), PLAIN, '解密后与原始字节一致（NoPadding 不去尾）');
});

test('图片解密②: AES/CBC/PKCS7（漫蛙写法，key=iv，用 cache.get）', async () => {
  const key = 'my2ecret782ecret';
  const encrypted = aesEncrypt(PLAIN, key, key, 'aes-128-cbc', true);
  const js = `key = cache.get("manwa_aes_key") || "my2ecret782ecret";
java.createSymmetricCrypto("aes/cbc/pkcs7padding", key, key).decrypt(result)`;
  const rule = makeRule(js);
  const out = await new LegadoEngine().decodeImage(
    rule as never,
    { url: `${BASE}/i/2.jpg`, bytes: new Uint8Array(encrypted) },
    makeCtx(),
  );
  assert.ok(out, '应返回解密结果');
  assert.deepEqual(Buffer.from(out), PLAIN, 'PKCS7 去填充后与原始字节一致');
});

test('图片解密③: 恒等规则（result）原样返回', async () => {
  const rule = makeRule('result');
  const out = await new LegadoEngine().decodeImage(
    rule as never,
    { url: `${BASE}/i/3.jpg`, bytes: new Uint8Array(PLAIN) },
    makeCtx(),
  );
  assert.ok(out);
  assert.deepEqual(Buffer.from(out), PLAIN);
});

test('图片解密④: 未声明规则 → null（调用方回传原图）', async () => {
  const rule = makeRule('');
  const out = await new LegadoEngine().decodeImage(
    rule as never,
    { url: `${BASE}/i/4.jpg`, bytes: new Uint8Array(PLAIN) },
    makeCtx(),
  );
  assert.equal(out, null);
});

test('图片解密⑤: 规则抛错/返回非法值 → null（不打断阅读）', async () => {
  const boom = await new LegadoEngine().decodeImage(
    makeRule('throw new Error("boom")') as never,
    { url: `${BASE}/i/5.jpg`, bytes: new Uint8Array(PLAIN) },
    makeCtx(),
  );
  assert.equal(boom, null);
  const notBytes = await new LegadoEngine().decodeImage(
    makeRule(`"我不是字节"`) as never,
    { url: `${BASE}/i/6.jpg`, bytes: new Uint8Array(PLAIN) },
    makeCtx(),
  );
  assert.equal(notBytes, null);
});

test('图片解密⑥: content() 回传 imageDecode / detail() 回传 coverDecode 标记', async () => {
  const rule = makeRule('result', {
    coverDecodeJs: 'result',
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>漫画</h1><ul id="list"><li><a href="/c/1.html">第1话</a></li></ul></body></html>',
    [`${BASE}/c/1.html`]: '<html><body><div class="pages"><img src="/i/1.jpg"></div></body></html>',
  });
  const engine = new LegadoEngine();
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(d.coverDecode, true, '封面解密标记');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) }, ctx);
  assert.equal(c.imageDecode, true, '正文图片解密标记');
  assert.deepEqual(c.paragraphs, [`${BASE}/i/1.jpg`]);
});

/**
 * ⑦ 回归锁（用户 2026-10-01 Add）：**封面解密的 `result` 必须带 InputStream 语义**。
 *
 * 缺陷现象：🥝猕猴桃漫画 / 漫蛙（两者 `coverDecodeJs` 逐字相同）的首行是
 * `const view = result.readAllBytes();` —— 本仓只给 `Uint8Array` ⇒
 * `TypeError: result.readAllBytes is not a function` ⇒ 解密失败回原图
 * ⇒ 浏览器拿到乱码 ⇒ 发现页 49 张卡片全部显示默认封面。
 *
 * 为什么算「整类」而非单源：上游 `OkHttpStreamFetcher.kt:129-146` 对同一个
 * `ImageUtils.decode` 传**两种类型** —— 封面 `byteStream()`（InputStream）、
 * 正文图 `bytes()`（ByteArray）。源脚本按拿到的类型写 ⇒ 两种都得能跑。
 *
 * 本例逐字照抄猕猴桃漫画的脚本（含 key/iv），只是把 AES 那几行换成可断言的形式，
 * 保证「`readAllBytes` + 头部魔数判定 + 前 16 字节当 IV」这条链在引擎里真的通。
 */
test('图片解密⑦: 封面脚本用 result.readAllBytes()（InputStream 语义）能正常解密', async () => {
  const key = '0B6666A0-BB59-1381-B746-a0E4C9AC'; // 32 字节 = AES-256
  const iv = Buffer.alloc(16, 0x5a);
  // 造「16 字节 IV + AES/CBC/PKCS5 密文」，与该源站点真实响应同构
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key, 'utf-8'), iv);
  const enc = Buffer.concat([cipher.update(PLAIN), cipher.final()]);
  const payload = Buffer.concat([iv, enc]);

  const js = `(() => {
    const view = result.readAllBytes();
    const isImage = (view[0] === 0xFF && view[1] === 0xD8);
    if (isImage) return result;
    const ivv = view.slice(0, 16);
    const ciphertext = view.slice(16);
    const key = java.strToBytes(${JSON.stringify(key)});
    const c = java.createSymmetricCrypto("AES/CBC/PKCS5Padding", key, ivv);
    return c.decrypt(ciphertext);
})()`;

  const compiled = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '封面流语义源',
    bookSourceType: 2,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    coverDecodeJs: js,
  });
  assert.ok(compiled.ok && compiled.rule);
  const out = await new LegadoEngine().decodeImage(
    compiled.rule as never,
    { url: `${BASE}/cover.webp`, bytes: new Uint8Array(payload), isCover: true },
    makeCtx(),
  );
  assert.ok(out, '不应返回 null（返回 null 就意味着回传未解密的乱码）');
  assert.deepEqual(Buffer.from(out), PLAIN, '解出的字节与原始图片一致');
});

/**
 * ⑧ 防空转：同一份源若`result` **没有**流方法，⑦ 的脚本必须失败（返回 null）。
 * 只断言「⑦ 通过」是假通过 —— 万一哪天引擎把脚本整个吞了也照样绿。
 */
test('图片解密⑧（防空转）: 去掉流方法后同一脚本必须失败（证明 ⑦ 绿不是因为脚本被吞）', async () => {
  const compiled = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '防空转',
    bookSourceType: 2,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    coverDecodeJs: 'result.readAllBytes()',
  });
  assert.ok(compiled.ok && compiled.rule);
  const bytes = Uint8Array.from([1, 2, 3, 4]);

  // 正路：引擎挂了方法 ⇒ 脚本跑通，返回字节
  const ok = await new LegadoEngine().decodeImage(
    compiled.rule as never,
    { url: `${BASE}/c.jpg`, bytes, isCover: true },
    makeCtx(),
  );
  assert.ok(ok, '引擎路径应正常返回');
  assert.deepEqual([...ok!], [1, 2, 3, 4]);

  // 反证：**裸数组**（没挂方法）执行同一句 ⇒ 必须 TypeError。
  // 这一条钉住「修复确实来自 asImageStreamResult，而不是脚本被容错吞掉」。
  const bare = new Uint8Array(bytes);
  assert.equal(typeof (bare as unknown as { readAllBytes?: unknown }).readAllBytes, 'undefined');
  assert.throws(() => (bare as unknown as { readAllBytes: () => void }).readAllBytes(), TypeError);
});

// ---------------------------------------------------------------------------
// `#759` 单张图片解密下移 worker
//   · 有 worker 池 ⇒ 下发裸字节描述符（不再把挂了方法的数组塞进结构化克隆）；
//   · worker 基础设施故障 ⇒ 回落宿主 L1，仍返回正确字节（不出「密文当原图」）；
//   · `YUEDU_IMAGE_DECODE_WORKER=0` / 脚本碰 Buffer ⇒ 留 L1，行为与旧版一致。
// ---------------------------------------------------------------------------

function withImageWorkerEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['YUEDU_IMAGE_DECODE_WORKER'];
  if (value === undefined) delete process.env['YUEDU_IMAGE_DECODE_WORKER'];
  else process.env['YUEDU_IMAGE_DECODE_WORKER'] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env['YUEDU_IMAGE_DECODE_WORKER'];
    else process.env['YUEDU_IMAGE_DECODE_WORKER'] = prev;
  });
}

test('#759 ① worker：图片解密下发裸字节描述符，worker 解出正确字节', async () => {
  // auto 默认为小图留 L1（实测无收益）⇒ 这条「必须走 worker」的用例显式强制 on
  await withImageWorkerEnv('1', async () => {
    const pool = createWorkerSandboxPool({ size: 1 });
    const jobs: Array<{ bindings?: Record<string, unknown> }> = [];
    const orig = pool.eval.bind(pool);
    (pool as unknown as { eval: typeof pool.eval }).eval = (opts) => {
      jobs.push(opts);
      return orig(opts);
    };
    try {
      const rule = makeRule('result.readAllBytes()');
      const ctx = { ...makeCtx(), sandbox: pool as never };
      const out = await new LegadoEngine().decodeImage(
        rule as never,
        { url: `${BASE}/w/1.jpg`, bytes: new Uint8Array(PLAIN) },
        ctx,
      );
      assert.ok(out);
      assert.deepEqual(Buffer.from(out), PLAIN);
      assert.ok(
        jobs.some((j) => j.bindings?.['__yueduImageBytes'] instanceof Uint8Array),
        '解密任务必须走 worker，且下发的是裸字节（不是挂了方法的数组）',
      );
    } finally {
      await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
    }
  });
});

test('#759 ② worker 基础设施故障 ⇒ 回落宿主 L1（结果仍是正确字节，不返回密文）', async () => {
  await withImageWorkerEnv('1', async () => {
    const boom = Object.assign(new Error('sandbox worker 意外退出'), { __yueduWorkerInfra: true });
    const pool = {
      __yueduWorkerPool: true,
      async eval() {
        throw boom;
      },
    } as never;
    const rule = makeRule('result.readAllBytes()');
    const out = await new LegadoEngine().decodeImage(
      rule as never,
      { url: `${BASE}/w/2.jpg`, bytes: new Uint8Array(PLAIN) },
      { ...makeCtx(), sandbox: pool },
    );
    assert.ok(out, '必须回落成功，而不是返回 null（null ⇒ 服务端回传密文）');
    assert.deepEqual(Buffer.from(out), PLAIN);
  });
});

test('#759 ③ 开关 `=0` / 脚本碰 Buffer ⇒ 不走 worker（旧行为完全一致）', async () => {
  await withImageWorkerEnv('0', async () => {
    const pool = createWorkerSandboxPool({ size: 1 });
    const jobs: Array<{ bindings?: Record<string, unknown> }> = [];
    const orig = pool.eval.bind(pool);
    (pool as unknown as { eval: typeof pool.eval }).eval = (opts) => {
      jobs.push(opts);
      return orig(opts);
    };
    try {
      const rule = makeRule('result.readAllBytes()');
      const out = await new LegadoEngine().decodeImage(
        rule as never,
        { url: `${BASE}/w/3.jpg`, bytes: new Uint8Array(PLAIN) },
        { ...makeCtx(), sandbox: pool as never },
      );
      assert.deepEqual(Buffer.from(out!), PLAIN);
      assert.ok(
        !jobs.some((j) => j.bindings?.['__yueduImageBytes'] !== undefined),
        '开关关掉后不得下发图片字节描述符',
      );
    } finally {
      await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
    }
  });

  // `Buffer` 在 worker 的 vm realm 不可见 ⇒ 必须留 L1（L1 有 Buffer，能跑通）
  const pool = createWorkerSandboxPool({ size: 1 });
  const jobs: Array<{ bindings?: Record<string, unknown> }> = [];
  const orig = pool.eval.bind(pool);
  (pool as unknown as { eval: typeof pool.eval }).eval = (opts) => {
    jobs.push(opts);
    return orig(opts);
  };
  try {
    const rule = makeRule('Buffer.from(result.readAllBytes()).slice(0)');
    const out = await new LegadoEngine().decodeImage(
      rule as never,
      { url: `${BASE}/w/4.jpg`, bytes: new Uint8Array(PLAIN) },
      { ...makeCtx(), sandbox: pool as never },
    );
    assert.deepEqual(Buffer.from(out!), PLAIN);
    assert.ok(!jobs.some((j) => j.bindings?.['__yueduImageBytes'] !== undefined), 'Buffer 脚本必须留 L1');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});

/* ──────────────────────────────────────────────────────────────────────────────
 * `D2` **图片解密标准参数 `decode{}`**
 *
 * `{js, ivPrefixBytes, keyEncoding}`：`js` 只返回 key（可读注入的 `ivPrefixBytes` /
 * `iv` / `keyEncoding`），IV 取图片前缀，AES-CBC 由服务端 `node:crypto` 完成。
 * 锁：对象形式能解、JSON 字符串形式能解、标记（`content.imageDecode` /
 * `detail.coverDecode`) 对两种形式都成立。
 * ────────────────────────────────────────────────────────────────────────────── */

function makeIvPrefixPayload(plain: Buffer): { image: Uint8Array; keyB64: string; key: Buffer; iv: Buffer } {
  const iv = Buffer.from('abcdef0123456789');
  const key = Buffer.from('0123456789abcdef');
  const enc = aesEncrypt(plain, key.toString('utf-8'), iv.toString('utf-8'));
  return { image: new Uint8Array(Buffer.concat([iv, enc])), keyB64: key.toString('base64'), key, iv };
}

/** 用注入的 `ivPrefixBytes` / `iv` / `keyEncoding` 生成 key（证明参数确实进了 JS 环境） */
const D2_JS = (keyB64: string): string =>
  `ivPrefixBytes === 16 && keyEncoding === "base64" && iv.length === 16
    ? ${JSON.stringify(keyB64)}
    : "错误的 key";`;

test('D2 ①: 对象形式 `decode{}` ⇒ js 只返回 key，服务端 AES-CBC 解出原图', async () => {
  const sample = makeIvPrefixPayload(PLAIN);
  const compiled = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: 'D2 对象形式',
    bookSourceType: 2,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: {
      content: 'div.pages@html',
      imageDecode: { js: D2_JS(sample.keyB64), ivPrefixBytes: 16, keyEncoding: 'base64' } as never,
    },
  });
  assert.ok(compiled.ok && compiled.rule);
  const out = await new LegadoEngine().decodeImage(
    compiled.rule as never,
    { url: `${BASE}/d2/1.jpg`, bytes: sample.image },
    makeCtx(),
  );
  assert.ok(out, '对象形式的 decode{} 必须能解密');
  assert.deepEqual(Buffer.from(out), PLAIN, '解出的字节与原始图片一致');
});

test('D2 ②: JSON 字符串形式 `decode{}` 同样可解，且 content()/detail() 标记成立', async () => {
  const sample = makeIvPrefixPayload(PLAIN);
  const json = JSON.stringify({ js: D2_JS(sample.keyB64), ivPrefixBytes: 16, keyEncoding: 'base64' });
  const rule = makeRule(json, {
    // 封面也换成对象形式（`detail()` 的 `coverDecode` 判据必须认）
    coverDecodeJs: { js: D2_JS(sample.keyB64), ivPrefixBytes: 16, keyEncoding: 'base64' } as never,
  });
  const out = await new LegadoEngine().decodeImage(
    rule as never,
    { url: `${BASE}/d2/2.jpg`, bytes: sample.image },
    makeCtx(),
  );
  assert.ok(out);
  assert.deepEqual(Buffer.from(out), PLAIN);

  const ctx = makeCtx({
    '*': '<html><body><h1>漫画</h1><ul id="list"><li><a href="/c/1.html">第1话</a></li></ul></body></html>',
    [`${BASE}/c/1.html`]: '<html><body><div class="pages"><img src="/i/1.jpg"></div></body></html>',
  });
  const engine = new LegadoEngine();
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(d.coverDecode, true, '对象形式封面仍须标记 coverDecode');
  const c = await engine.content(
    rule as never,
    { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) },
    ctx,
  );
  assert.equal(c.imageDecode, true, 'JSON 字符串形式正文图仍须标记 imageDecode');
});
