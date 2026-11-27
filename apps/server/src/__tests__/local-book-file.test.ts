/**
 * `#228` / `#217` 本地书「记录 → 磁盘文件」解析的回归锁。
 *
 * ## ★ 要防的那个 bug：`content` 端点回 **裸 500**
 * 症状（`#227` 探针，2026-10-03）：关掉阅读浮层重开后、从详情页点目录进正文 ⇒
 * 前端只显示「正文加载失败：Internal Server Error」。
 *
 * 根因链（每一环都实测过）：
 *  1. 本地书主键由**前端**算（`loc_book\0{"fileName":"x.txt"}`），文件名只在 payload 里；
 *  2. **前端契约里没有 `originName`** ⇒ 任何一次 `PUT /api/user/books`（同步进度 /
 *     改分组 / 换封面）都把它**覆盖成 `''`**；
 *  3. 旧代码 `localBookPath(book.originName ?? '')` 抛「文件名越界」，而**那行在 try 之外**
 *     ⇒ Fastify 兜成 500，**没有 JSON 信封** ⇒ 前端拼不出原因，只剩 `Internal Server Error`。
 *
 * ## 为什么单测能锁住它
 * 「跑起来看看」锁不住：要复现得先关浮层触发一次 PUT 把库写脏，步骤一多就会「这次没复现」就算过。
 * 改成锁**契约**：`resolveLocalBookFile` **对任何输入都不抛**，失败一律 `ok:false` + 410。
 * 这个性质一破，「try 之外的 throw」就回来了 ⇒ 500 就回来了。
 *
 * ## 防空转约定
 * 每个「失败」用例旁都有**同函数换入参能通过**的对照，避免断言写成恒真。
 *
 * 运行：`pnpm --filter @yuedu/server test`
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  localBookFileName, localBookPath, resolveLocalBookFile, safeLocalBookName,
} from '../local-book-file';

/** 每个用例一个独立临时目录（不带仓库 `tmp/`，见 `_probe-env.mjs` 注释里那类卡死经历） */
const dirs: string[] = [];
function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lbfile-${tag}-`));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 本地书主键的两种真实形态（前端算出来后过 HTTP 就是后者） */
const URL_NUL = 'loc_book\0{"fileName":"测试.txt"}';
const URL_ENC = 'loc_book%00%7B%22fileName%22%3A%22%E6%B5%8B%E8%AF%95.txt%22%7D';

/* ── ★ `#228` 核心：绝不抛（旧代码的 throw 在 try 外 ⇒ 500） ────────────── */

test('★ #228 originName 被冲成空串：不抛，且从 bookUrl 反推出文件名', () => {
  const dir = tmpDir('empty-origin');
  fs.writeFileSync(path.join(dir, '测试.txt'), '正文');
  // 修复前：这行抛「文件名越界」⇒ Fastify 兜成 500
  const r = resolveLocalBookFile(dir, { originName: '' }, URL_NUL);
  assert.equal(r.ok, true, 'originName 空 ⇒ 必须能从 bookUrl 反推出文件名');
  assert.equal(r.ok && r.fileName, '测试.txt');
  assert.equal(r.ok && fs.existsSync(r.filePath), true);
});

test('★ #228 originName 是 null（整条 upsert 补默认值后的形态）：同样不抛', () => {
  const dir = tmpDir('null-origin');
  fs.writeFileSync(path.join(dir, '测试.txt'), '正文');
  const r = resolveLocalBookFile(dir, { originName: null }, URL_ENC);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.fileName, '测试.txt');
});

test('★ #228 连 book 都是 null：不抛，回 410 LOCAL_FILE_NAME_UNKNOWN（不是 500）', () => {
  const dir = tmpDir('no-book');
  const r = resolveLocalBookFile(dir, null, 'https://example.com/net-book');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 410);
  assert.equal(r.ok === false && r.error, 'LOCAL_FILE_NAME_UNKNOWN');
});

test('★ #228 任一组脏输入都不抛（穷举；抛了就证明「try 外的 throw」回来了）', () => {
  const dir = tmpDir('fuzz');
  // 先把「能被反推出来」的那两个文件放进去，否则这组输入只会全失败 ——
  // 全失败的话下面「不抛」就成了恒真断言（防空转：必须既有成功也有失败）
  fs.writeFileSync(path.join(dir, '测试.txt'), '正文');
  fs.writeFileSync(path.join(dir, 'a.txt'), '正文');
  const books: Array<{ originName?: string | null } | null | undefined> = [
    null, undefined, {}, { originName: '' }, { originName: null }, { originName: undefined },
    { originName: '../越界.txt' }, { originName: '..' }, { originName: '.' },
    { originName: '/etc/passwd' }, { originName: 'a\0b.txt' }, { originName: '不存在.txt' },
  ];
  const urls = ['', 'loc_book', 'loc_book%00', URL_NUL, URL_ENC, 'https://a/b', 'loc_book://x.txt'];
  let ok = 0;
  let bad = 0;
  for (const b of books) {
    for (const u of urls) {
      // ★ 唯一断言：不抛。抛出即 fail（这正是修复前的形态）
      const r = resolveLocalBookFile(dir, b, u);
      if (r.ok) ok++;
      else {
        bad++;
        assert.equal(r.status, 410, '失败只允许是 410，绝不能是 5xx');
        assert.ok(r.detail.length > 0, '410 必须带说清原因的 detail');
      }
    }
  }
  // 防空转：这组输入里必须既有成功的也有失败的，否则「不抛」是恒真断言
  assert.ok(ok > 0, `应有能解析成功的组合（实得 ${ok}）`);
  assert.ok(bad > 0, `应有解析失败的组合（实得 ${bad}）`);
});

/* ── 三种失败原因各自到位（且都不冒充 500） ─────────────────────────────── */

test('#228 文件名里有 ../ ⇒ 410 LOCAL_FILE_NAME_INVALID（带原因，不抛）', () => {
  const dir = tmpDir('escape');
  const r = resolveLocalBookFile(dir, { originName: '../../windows.txt' }, URL_NUL);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'LOCAL_FILE_NAME_INVALID');
  assert.match(r.ok === false ? r.detail : '', /文件名不合法/);
  // 对照：同函数、换一个合法文件名 ⇒ 通过（证明上面不是恒真）
  fs.writeFileSync(path.join(dir, '测试.txt'), 'x');
  const okr = resolveLocalBookFile(dir, { originName: '测试.txt' }, URL_NUL);
  assert.equal(okr.ok, true);
});

test('#228 记录有文件名但磁盘上没有 ⇒ 410 FILE_MISSING（且 detail 带上文件名）', () => {
  const dir = tmpDir('missing');
  const r = resolveLocalBookFile(dir, { originName: '被删掉了.txt' }, URL_NUL);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'FILE_MISSING');
  assert.match(r.ok === false ? r.detail : '', /被删掉了\.txt/);
  // 对照：把文件放回去 ⇒ 同一行记录立刻可解析
  fs.writeFileSync(path.join(dir, '被删掉了.txt'), 'x');
  const okr = resolveLocalBookFile(dir, { originName: '被删掉了.txt' }, URL_NUL);
  assert.equal(okr.ok, true);
});

test('#228 网络书（主键不是 loc_book）推不出文件名 ⇒ 410，不抛', () => {
  const dir = tmpDir('net');
  const r = resolveLocalBookFile(dir, { originName: '' }, 'https://example.com/book/1');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'LOCAL_FILE_NAME_UNKNOWN');
});

/* ── `#217`：判格式前先反推（否则真 epub 被当成 txt） ───────────────────── */

test('#217 localBookFileName：originName 空 ⇒ 从 bookUrl 反推（两种形态都认）', () => {
  assert.equal(localBookFileName({ originName: '' }, URL_NUL), '测试.txt', '真实 NUL');
  assert.equal(localBookFileName({ originName: '' }, URL_ENC), '测试.txt', '字面 %00 + URL 编码');
  assert.equal(localBookFileName({ originName: '' }, 'loc_book://a.txt'), 'a.txt', '旧形态');
});

test('#217 localBookFileName：非空不动（显式值优先级最高）· 推不出返回空', () => {
  assert.equal(localBookFileName({ originName: '显式.epub' }, URL_NUL), '显式.epub');
  assert.equal(localBookFileName({ originName: '' }, 'https://example.com/b'), '');
  assert.equal(localBookFileName(null, URL_NUL), '测试.txt', 'book 为空也能从 url 推');
});

/* ── 导入侧洗名字（`safeLocalBookName`） ────────────────────────────────── */

test('safeLocalBookName：去掉目录成分与 Windows 非法字符', () => {
  assert.equal(safeLocalBookName('a/b/书.txt'), '书.txt', '目录成分');
  assert.equal(safeLocalBookName('../书.txt'), '书.txt', '../ 穿越');
  assert.equal(safeLocalBookName('书:名*?.txt'), '书_名__.txt', '非法字符替换成 _');
  assert.equal(safeLocalBookName('%E6%B5%8B%E8%AF%95.txt'), '测试.txt', 'URL 编码先解再洗');
});

test('safeLocalBookName：`.`/`..`/空/超长 ⇒ 抛（导入侧就是该拒绝）', () => {
  assert.throws(() => safeLocalBookName('..'), /文件名无效/);
  assert.throws(() => safeLocalBookName('.'), /文件名无效/);
  assert.throws(() => safeLocalBookName('   '), /文件名无效/);
  assert.throws(() => safeLocalBookName('x'.repeat(181)), /文件名过长/);
  // 对照：180 字刚好放行（证明上面的「超长」不是恒真）
  assert.equal(safeLocalBookName('x'.repeat(180)).length, 180);
});

/* ── localBookPath 越界校验 ────────────────────────────────────────────── */

test('localBookPath：跳出目录 ⇒ 抛「文件名越界」（双保险，读取侧被 resolve 兜住）', () => {
  const dir = tmpDir('path');
  assert.throws(() => localBookPath(dir, '../outside.txt'), /文件名越界/);
  // 对照
  assert.equal(localBookPath(dir, 'ok.txt'), path.resolve(dir, 'ok.txt'));
});
