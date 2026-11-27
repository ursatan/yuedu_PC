/**
 * `#732` 外链脚本本地镜像 —— 判据回归锁。
 *
 * ⚠️ 顺序是用户 2026-11-02 **反转**后的语义：**网络优先 → 镜像兜底 → 连续失败提示手动下载**。
 * 早先的「镜像优先」已被否定（镜像一旦过期会挡住站点新版本）。本文件锁的是**镜像层判据**
 * （路径映射 / meta 校验 / 开关 / etag / 提示持久化）；取数顺序由 `engine-rss` 的用例锁。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  jsMirrorEnabled,
  jsMirrorRelPath,
  jsMirrorRoot,
  readJsMirror,
  writeJsMirror,
  jsMirrorEtag,
  jsMirrorHintThreshold,
  noteJsMirrorFailure,
  noteJsMirrorSuccess,
  listJsMirrorHints,
  __resetJsMirrorHintsForTest,
  __resetJsMirrorWarningsForTest,
} from '../net/jslib-mirror';

const BODY = 'function Get(url) { return url; }\n';

function withMirrorDir<T>(fn: (dir: string) => T): T {
  const prevDir = process.env['YUEDU_JSLIB_MIRROR_DIR'];
  const prevOn = process.env['YUEDU_JSLIB_MIRROR'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jslib-mirror-732-'));
  process.env['YUEDU_JSLIB_MIRROR_DIR'] = dir;
  delete process.env['YUEDU_JSLIB_MIRROR'];
  __resetJsMirrorWarningsForTest();
  __resetJsMirrorHintsForTest();
  try {
    return fn(dir);
  } finally {
    if (prevDir === undefined) delete process.env['YUEDU_JSLIB_MIRROR_DIR'];
    else process.env['YUEDU_JSLIB_MIRROR_DIR'] = prevDir;
    if (prevOn === undefined) delete process.env['YUEDU_JSLIB_MIRROR'];
    else process.env['YUEDU_JSLIB_MIRROR'] = prevOn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('write → read 往返，并落 URL 映射目录 + 旁挂 meta（URL/时间/字节数/sha256）', () => {
  withMirrorDir((dir) => {
    const url = 'https://qyyuapi.com/dy/js/Movieffm/loginUrl.js';
    const rel = writeJsMirror(url, BODY, 'manual');
    assert.equal(rel, 'qyyuapi.com/dy/js/Movieffm/loginUrl.js');

    const abs = path.join(dir, ...rel!.split('/'));
    assert.equal(fs.readFileSync(abs, 'utf-8'), BODY);
    const meta = JSON.parse(fs.readFileSync(`${abs}.meta.json`, 'utf-8'));
    assert.equal(meta.url, url);
    assert.equal(meta.bytes, Buffer.byteLength(BODY, 'utf-8'));
    assert.equal(meta.sha256, createHash('sha256').update(BODY, 'utf-8').digest('hex'));
    assert.equal(meta.source, 'manual');
    assert.ok(!Number.isNaN(Date.parse(meta.fetchedAt)));

    const hit = readJsMirror(url);
    assert.equal(hit?.text, BODY);
    assert.equal(hit?.rel, rel);
    assert.equal(hit?.meta?.sha256, meta.sha256);
  });
});

test('未命中 ⇒ null（调用方回源）；空内容不写盘（避免把失败固化成永久空）', () => {
  withMirrorDir(() => {
    assert.equal(readJsMirror('https://qyyuapi.com/js/none.js'), null);
    assert.equal(writeJsMirror('https://qyyuapi.com/js/empty.js', '   \n'), null);
    assert.equal(readJsMirror('https://qyyuapi.com/js/empty.js'), null);
  });
});

test('镜像内容与 meta 不一致 ⇒ 按未命中回源（不把损坏文件当成功）', () => {
  withMirrorDir((dir) => {
    const url = 'https://qyyuapi.com/js/common.js';
    const rel = writeJsMirror(url, BODY)!;
    const abs = path.join(dir, ...rel.split('/'));
    fs.writeFileSync(abs, `${BODY}// tampered\n`, 'utf-8');
    assert.equal(readJsMirror(url), null);
  });
});

test('无 meta 的手工文件（用户直接丢进目录）⇒ 信任内容', () => {
  withMirrorDir((dir) => {
    const url = 'https://qyyuapi.com/js/manual.js';
    const abs = path.join(dir, 'qyyuapi.com', 'js', 'manual.js');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, BODY, 'utf-8');
    assert.equal(readJsMirror(url)?.text, BODY);
  });
});

test('开关：YUEDU_JSLIB_MIRROR=0 ⇒ 读写都关闭（默认开启）', () => {
  withMirrorDir((dir) => {
    assert.equal(jsMirrorEnabled(), true);
    const url = 'https://qyyuapi.com/js/off.js';
    assert.ok(writeJsMirror(url, BODY));
    process.env['YUEDU_JSLIB_MIRROR'] = '0';
    assert.equal(jsMirrorEnabled(), false);
    assert.equal(readJsMirror(url), null);
    assert.equal(writeJsMirror('https://qyyuapi.com/js/off2.js', BODY), null);
    assert.ok(!fs.existsSync(path.join(dir, 'qyyuapi.com', 'js', 'off2.js')));
  });
});

test('同一 path 不同 query ⇒ 不同镜像文件（不互相覆盖）', () => {
  withMirrorDir(() => {
    const a = jsMirrorRelPath('https://qyyuapi.com/js/x.js?v=1');
    const b = jsMirrorRelPath('https://qyyuapi.com/js/x.js?v=2');
    assert.ok(a && b);
    assert.notEqual(a, b);
    assert.ok(a!.endsWith('x.js.__q' + createHash('sha256').update('?v=1', 'utf-8').digest('hex').slice(0, 8)));
  });
});

test('路径净化：`..` / 保留名 / 非法字符不会逃出镜像根', () => {
  withMirrorDir((dir) => {
    assert.equal(jsMirrorRelPath('ftp://qyyuapi.com/a.js'), null);
    assert.equal(jsMirrorRelPath('not-a-url'), null);
    assert.equal(jsMirrorRelPath('https://qyyuapi.com/'), 'qyyuapi.com/index.js');
    // URL 解析器本身会消掉 `..` 段（`/a/../b.js` → `/b.js`）；解码后残留的 `../` 由净化逻辑拍平
    const rel = jsMirrorRelPath('https://qyyuapi.com/a/%2e%2e/b.js')!;
    assert.equal(rel, 'qyyuapi.com/b.js');
    assert.equal(jsMirrorRelPath('https://qyyuapi.com/a/%2e%2e%2fx/b.js'), 'qyyuapi.com/a/.._x/b.js');
    assert.ok(path.resolve(dir, ...rel.split('/')).startsWith(path.resolve(dir) + path.sep));
  });
});

test('jsMirrorEtag：以内容 sha256 作合成 etag（用户换文件 ⇒ etag 变 ⇒ 源侧 Reload 重取）', () => {
  withMirrorDir(() => {
    const url = 'https://qyyuapi.com/js/etag.js';
    assert.equal(jsMirrorEtag(url), null);
    writeJsMirror(url, BODY);
    assert.equal(jsMirrorEtag(url), createHash('sha256').update(BODY, 'utf-8').digest('hex'));
  });
});

test('镜像根：YUEDU_JSLIB_MIRROR_DIR 覆盖，缺省落在 <data>/jslib-mirror', () => {
  withMirrorDir((dir) => {
    assert.equal(jsMirrorRoot(), path.resolve(dir));
  });
  const prevData = process.env['YUEDU_DATA_DIR'];
  const prevMirror = process.env['YUEDU_JSLIB_MIRROR_DIR'];
  delete process.env['YUEDU_JSLIB_MIRROR_DIR'];
  process.env['YUEDU_DATA_DIR'] = 'tmp-data-732';
  try {
    assert.equal(jsMirrorRoot(), path.resolve('tmp-data-732', 'jslib-mirror'));
  } finally {
    if (prevData === undefined) delete process.env['YUEDU_DATA_DIR'];
    else process.env['YUEDU_DATA_DIR'] = prevData;
    if (prevMirror === undefined) delete process.env['YUEDU_JSLIB_MIRROR_DIR'];
    else process.env['YUEDU_JSLIB_MIRROR_DIR'] = prevMirror;
  }
});

/* ===== 「请手动下载」提示（连续失败到阈值 ⇒ 一次；持久化；路径映射） ===== */

test('提示阈值：默认 3，YUEDU_JSLIB_MIRROR_HINT_AFTER 可调（最小 1）', () => {
  withMirrorDir(() => {
    assert.equal(jsMirrorHintThreshold(), 3);
    process.env['YUEDU_JSLIB_MIRROR_HINT_AFTER'] = '2';
    assert.equal(jsMirrorHintThreshold(), 2);
    process.env['YUEDU_JSLIB_MIRROR_HINT_AFTER'] = '0';
    assert.equal(jsMirrorHintThreshold(), 3, '非法值回落默认 3');
    delete process.env['YUEDU_JSLIB_MIRROR_HINT_AFTER'];
  });
});

test('连续失败 3 次 ⇒ 只提示 1 次；第 4 次不再提示；成功回写后计数清零', () => {
  withMirrorDir(() => {
    const url = 'https://qyyuapi.com/dy/js/Movieffm/loginUrl.js';
    assert.equal(noteJsMirrorFailure(url, '请求超时（>12000ms）'), null);
    assert.equal(noteJsMirrorFailure(url, '请求超时（>12000ms）'), null);
    const hint = noteJsMirrorFailure(url, '请求超时（>12000ms）');
    assert.ok(hint, '第 3 次必须提示');
    assert.equal(hint!.fails, 3);
    assert.equal(hint!.reason, '请求超时（>12000ms）');
    // 用户应当看到的文案三要素：URL / 绝对路径 / 一句话操作说明
    assert.ok(hint!.text.includes(url));
    assert.ok(hint!.text.includes(hint!.absPath));
    assert.match(hint!.text, /浏览器下载后按此路径保存，重启服务生效/);
    // 路径按 URL 映射：<镜像根>/qyyuapi.com/dy/js/Movieffm/loginUrl.js（Windows 反斜杠）
    assert.equal(
      hint!.absPath,
      path.join(process.env['YUEDU_JSLIB_MIRROR_DIR'] ?? '', 'qyyuapi.com', 'dy', 'js', 'Movieffm', 'loginUrl.js'),
    );
    if (process.platform === 'win32') assert.ok(hint!.absPath.includes('\\'));

    assert.equal(noteJsMirrorFailure(url, '请求超时（>12000ms）'), null, '同一 URL 只提示一次');
    const listed = listJsMirrorHints();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.fails, 4, '计数继续累加，但不再提示');

    // 网络恢复（回写镜像）⇒ 连续失败计数清零；已提示标记保留（不重复打扰）
    noteJsMirrorSuccess(url);
    const after = listJsMirrorHints();
    assert.equal(after[0]?.fails, 0, '成功一次即清零连续失败');
    assert.equal(after[0]?.notifiedAt, listed[0]?.notifiedAt, '提示时间不变（同 URL 只提示一次）');
  });
});

test('提示持久化到 .hints.json（跨进程重读仍只提示一次）', () => {
  withMirrorDir((dir) => {
    const url = 'https://qyyuapi.com/js/common.js';
    noteJsMirrorFailure(url, '请求超时');
    noteJsMirrorFailure(url, '请求超时');
    assert.ok(noteJsMirrorFailure(url, '请求超时'));
    const file = path.join(dir, '.hints.json');
    assert.ok(fs.existsSync(file), '提示必须落盘（跨进程 / 重启不重复弹）');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(raw.version, 1);
    assert.ok(raw.urls[url].notifiedAt, '已提示标记必须持久化');
    assert.equal(noteJsMirrorFailure(url, '请求超时'), null, '重读后仍然只提示一次');
  });
});

test('提示：YUEDU_JSLIB_MIRROR=0 ⇒ 不记账也不提示（镜像已关，提示无处可放）', () => {
  withMirrorDir(() => {
    process.env['YUEDU_JSLIB_MIRROR'] = '0';
    assert.equal(noteJsMirrorFailure('https://qyyuapi.com/js/off.js', '超时'), null);
    assert.deepEqual(listJsMirrorHints(), []);
  });
});

/* ===== 运行期出口（L1 `java.importScript`）：网络优先 → 镜像兜底 → 明确失败 ===== */

import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

function evalImport(url: string, status: number, body: string): unknown {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    syncFetch: () => ({ status, headers: {}, setCookie: [], body }),
  });
  return ev(`java.importScript("${url}")`, {});
}

test('L1 importScript：网络成功 ⇒ 用网络内容，并回写镜像（不读旧镜像）', () => {
  withMirrorDir(() => {
    const url = 'https://qyyuapi.com/js/runtime-net.js';
    writeJsMirror(url, 'var OLD = 0;\n', 'manual');
    const out = evalImport(url, 200, 'var NEW = 1;\n');
    assert.match(String(out), /var NEW = 1;/, '网络成功必须用网络内容');
    assert.equal(readJsMirror(url)?.text, 'var NEW = 1;\n', '网络成功必须覆盖旧镜像');
  });
});

test('L1 importScript：网络失败 + 镜像命中 ⇒ 返回镜像内容（兜底，且不催下载）', () => {
  withMirrorDir(() => {
    const url = 'https://qyyuapi.com/js/runtime-fallback.js';
    writeJsMirror(url, 'var MIRROR = 2;\n', 'manual');
    const out = evalImport(url, 500, '');
    assert.match(String(out), /var MIRROR = 2;/, '网络失败必须用镜像内容继续');
    assert.deepEqual(listJsMirrorHints(), [], '兜底成功不提示');
  });
});

test('L1 importScript：网络失败 + 无镜像 ⇒ 抛明确错误（不返回空串），第 3 次起提示一次', () => {
  withMirrorDir(() => {
    const url = 'https://qyyuapi.com/js/runtime-both-fail.js';
    for (let i = 0; i < 3; i++) {
      assert.throws(() => evalImport(url, 500, ''), /内容获取失败或者为空/);
    }
    const hints = listJsMirrorHints();
    assert.equal(hints.length, 1, '连续 3 次失败必须提示一次');
    assert.equal(hints[0]?.url, url);
    assert.match(hints[0]?.text ?? '', /浏览器下载后按此路径保存，重启服务生效/);
    assert.throws(() => evalImport(url, 500, ''), /内容获取失败或者为空/);
    assert.equal(listJsMirrorHints().length, 1, '第 4 次不再重复提示');
  });
});
