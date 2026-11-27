/**
 * `#620` 导出编排层（`apps/web/src/utils/book-export.ts`）
 *
 * 这一层的风险不在「拼字符串」（那在 core，已有单测），而在**调度语义**：
 * 并发乱序后是否仍按章节顺序写、失败章是否计数、卷是否白打源站、净化 used 是否汇总。
 * 这四件事只要错一件，导出的书就是错的，且用户很难发现（文件能打开）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCentralDirectory } from '../../../packages/core/src/local-book/zip';
import { EXPORT_CONCURRENCY, exportBook, htmlToPlainParagraphs, type ExportDeps } from '../src/utils/book-export';

const chapters = [{ title: '第一章' }, { title: '第二章' }, { title: '第三章' }];

test('#620 基本导出：书头 + 三章，顺序与目录一致', async () => {
  const deps: ExportDeps = {
    getContent: async (ch) => ({ paragraphs: [`${ch.title}的正文`] }),
  };
  const r = await exportBook(
    { name: '夜无疆', author: '辰东', intro: '简介', chapters, format: 'txt' },
    deps,
  );
  assert.equal(r.filename, '夜无疆 作者：辰东.txt');
  assert.equal(r.stats.total, 3);
  assert.equal(r.stats.written, 3);
  assert.equal(r.stats.failed, 0);
  const t = r.text ?? '';
  assert.ok(t.startsWith('夜无疆\n作者：辰东\n简介：\n简介'), '书头在首位');
  assert.ok(t.indexOf('第一章的正文') < t.indexOf('第二章的正文'));
  assert.ok(t.indexOf('第二章的正文') < t.indexOf('第三章的正文'));
});

test('#620 并发乱序返回时仍按目录顺序落盘（结果按下标回填）', async () => {
  const deps: ExportDeps = {
    // 越靠后的章越快返回 ⇒ 若实现是「谁先回谁先写」，顺序就会反过来
    getContent: async (ch) => {
      const delay = ch.title === '第一章' ? 30 : ch.title === '第二章' ? 15 : 0;
      await new Promise((r) => setTimeout(r, delay));
      return { paragraphs: [`[${ch.title}]`] };
    },
  };
  const r = await exportBook({ name: 'b', chapters, format: 'txt', includeHeader: false }, deps);
  const t = r.text ?? '';
  assert.ok(t.indexOf('[第一章]') < t.indexOf('[第二章]'));
  assert.ok(t.indexOf('[第二章]') < t.indexOf('[第三章]'));
});

test('#620 卷不发请求（引擎对卷返回空内容，别为它打源站）', async () => {
  let asked = 0;
  const deps: ExportDeps = {
    getContent: async (ch) => {
      asked += 1;
      return { paragraphs: [`${ch.title}-正文`] };
    },
  };
  const r = await exportBook(
    { name: 'b', chapters: [{ title: '卷一', isVolume: true }, { title: '第一章' }], format: 'txt', includeHeader: false },
    deps,
  );
  assert.equal(asked, 1, '卷不该触发 getContent');
  const t = r.text ?? '';
  assert.ok(t.includes('卷一'), '卷标题要写进文件');
  assert.equal(r.stats.written, 2);
});

test('#620 单章反复失败 ⇒ 计入 failed 且继续导其余章；全失败 ⇒ 抛错（不留空文件）', async () => {
  const deps: ExportDeps = {
    retry: 1,
    getContent: async (ch) => {
      if (ch.title === '第二章') throw new Error('boom');
      return { paragraphs: [`${ch.title}-正文`] };
    },
  };
  const r = await exportBook({ name: 'b', chapters, format: 'txt', includeHeader: false }, deps);
  assert.equal(r.stats.failed, 1);
  assert.equal(r.stats.written, 2);
  assert.equal(r.stats.skipped, 1);
  assert.ok(!(r.text ?? '').includes('第二章'));

  await assert.rejects(
    () =>
      exportBook(
        { name: 'b', chapters, format: 'txt' },
        {
          getContent: async () => {
            throw new Error('all down');
          },
          retry: 0,
        },
      ),
    /一章正文都没拿到/,
  );
});

test('#620 没有正文的章（返回 null）静默跳过，但计入 skipped', async () => {
  const r = await exportBook(
    { name: 'b', chapters, format: 'txt', includeHeader: false },
    { getContent: async (ch) => (ch.title === '第二章' ? null : { paragraphs: ['正文'] }) },
  );
  assert.equal(r.stats.written, 2);
  assert.equal(r.stats.skipped, 1);
});

test('#620 净化：used 规则 id 去重汇总（验收「替换规则生效」靠它）', async () => {
  const r = await exportBook(
    { name: 'b', chapters, format: 'txt', includeHeader: false },
    {
      getContent: async () => ({ paragraphs: ['广告正文'] }),
      purifyContent: (ps) => ({ paragraphs: ps.map((p) => p.replace('广告', '')), used: [7, 9] }),
      purifyTitle: (t) => ({ title: t + '·净', used: [3] }),
    },
  );
  assert.equal(r.stats.replaceUsed, 3, '7/9/3 去重后 3 条');
  assert.ok((r.text ?? '').includes('正文'));
  assert.ok((r.text ?? '').includes('第一章·净'), '标题净化要生效');
});

test('#620 范围导出（from/to 闭区间）', async () => {
  const r = await exportBook(
    { name: 'b', chapters, from: 1, to: 2, format: 'txt', includeHeader: false },
    { getContent: async (ch) => ({ paragraphs: [`[${ch.title}]`] }) },
  );
  assert.equal(r.stats.total, 2);
  assert.ok(!(r.text ?? '').includes('[第一章]'));
  assert.ok((r.text ?? '').includes('[第二章]') && (r.text ?? '').includes('[第三章]'));
});

test('#620 epub 导出：合法 zip 容器、mimetype 第一项 STORED、章数与正文对得上', async () => {
  const r = await exportBook({ name: '夜无疆', author: '辰东', chapters, format: 'epub' }, {
    getContent: async (ch) => ({ paragraphs: [`${ch.title}：正文`] }),
  });
  assert.equal(r.filename, '夜无疆 作者：辰东.epub');
  assert.equal(r.blob.type, 'application/epub+zip');
  const bytes = new Uint8Array(await r.blob.arrayBuffer());
  const ar = readCentralDirectory(bytes);
  assert.equal(ar.entries[0]!.name, 'mimetype');
  assert.equal(ar.entries[0]!.method, 0);
  const chs = ar.entries.filter((e) => /^OEBPS\/text\/chapter-\d{4}\.xhtml$/.test(e.name));
  assert.equal(chs.length, 3);
});

test('#620 html 章节降级成纯文本（不能整章丢）', async () => {
  const r = await exportBook({ name: 'b', chapters: [{ title: '一' }], format: 'txt', includeHeader: false }, {
    getContent: async () => ({ html: '<div><p>甲&amp;乙</p><p>丙</p><script>bad()</script></div>' }),
  });
  const t = r.text ?? '';
  assert.ok(t.includes('甲&乙'));
  assert.ok(t.includes('丙'));
  assert.ok(!t.includes('bad()'), 'script 内容不能进正文');
  assert.deepEqual(htmlToPlainParagraphs('<p>a</p><p>b</p>'), ['a', 'b']);
  assert.equal(EXPORT_CONCURRENCY, 3);
});
