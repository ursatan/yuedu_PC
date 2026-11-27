/**
 * `#626` 导出 epub 的图片转存（编排层：`apps/web/src/utils/book-export.ts`）
 *
 * 这一层的风险全在**调度与失败语义**（纯函数部分在 core 已有单测）：
 *  1. 同一张图在多章出现只下一次（漫画站一章几十张图，重复下就是几十倍流量）；
 *  2. 段评图**不下载**（净化判据与转存判据同源，否则白等而且 stats 与正文对不上）；
 *  3. 单张图失败 ⇒ 计数 + 保留原地址，**不中断导出**（用户要的是书，不是完美的书）；
 *  4. 相对地址要按章 URL 补全（源常给 `/img/1.jpg`）；
 *  5. `embedImages:false` / txt ⇒ 一次都不请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCentralDirectory, readEntryBy } from '../../../packages/core/src/local-book/zip';
import { exportBook, type ExportDeps } from '../src/utils/book-export';

const dec = new TextDecoder();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function epubEntries(bytes: Uint8Array): { names: string[]; text: (n: string) => string } {
  const ar = readCentralDirectory(bytes);
  return {
    names: ar.entries.map((e) => e.name),
    text: (n: string) => {
      const e = ar.entries.find((x) => x.name === n);
      assert.ok(e, `zip 里没有 ${n}；有 ${ar.entries.map((x) => x.name).join(', ')}`);
      return dec.decode(readEntryBy(bytes, e));
    },
  };
}

const imgChapter = (url: string, srcs: string[]): string[] => srcs.map((s) => `<img src="${s}">`).concat(['正文']);

test('#626 同一张图跨章只下一次；相对地址按章 URL 补全', async () => {
  const asked: string[] = [];
  const deps: ExportDeps = {
    getContent: async (ch) =>
      ch.title === '第一章'
        ? { paragraphs: imgChapter('', ['/img/a.png']) }
        : { paragraphs: imgChapter('', ['https://cdn.example/img/a.png']) },
    fetchImage: async (url) => {
      asked.push(url);
      return PNG;
    },
  };
  const r = await exportBook(
    {
      name: 'b',
      chapters: [
        { title: '第一章', url: 'https://site.example/book/1.html' },
        { title: '第二章', url: 'https://site.example/book/2.html' },
      ],
      format: 'epub',
      includeChapterTitle: false,
    },
    deps,
  );
  // 相对 `/img/a.png` 必须补成站点绝对地址（否则 proxy 收不了）
  assert.deepEqual(asked, ['https://site.example/img/a.png', 'https://cdn.example/img/a.png']);
  assert.equal(r.stats.images.total, 2, '两个不同地址 = 两张');
  assert.equal(r.stats.images.embedded, 2);
  assert.equal(r.stats.images.failed, 0);

  const z = epubEntries(new Uint8Array(await r.blob.arrayBuffer()));
  assert.equal(z.names.filter((n) => n.startsWith('OEBPS/Images/')).length, 2);
  // 相对写法在正文里也要被改写（键是原样 src）
  assert.match(z.text('OEBPS/text/chapter-0001.xhtml'), /src="\.\.\/Images\/[0-9a-f]{16}\.png"/);
});

test('#626 同一 URL 被相对/绝对两种写法引用 ⇒ 只下一次（按补全后的地址去重）', async () => {
  let calls = 0;
  const r = await exportBook(
    {
      name: 'b',
      chapters: [
        { title: '第一章', url: 'https://site.example/b/1.html' },
        { title: '第二章', url: 'https://site.example/b/2.html' },
      ],
      format: 'epub',
      includeChapterTitle: false,
    },
    {
      getContent: async (ch) => ({ paragraphs: ch.title === '第一章' ? ['<img src="/i/x.jpg">'] : ['<img src="https://site.example/i/x.jpg">'] }),
      fetchImage: async () => {
        calls += 1;
        return PNG;
      },
    },
  );
  assert.equal(calls, 1, '同一地址只能请求一次');
  assert.equal(r.stats.images.total, 1);
  assert.equal(r.stats.images.embedded, 2, '两个 rawSrc 各自都要在正文里改写（指向同一个 zip 条目）');
  const z = epubEntries(new Uint8Array(await r.blob.arrayBuffer()));
  assert.equal(z.names.filter((n) => n.startsWith('OEBPS/Images/')).length, 1, '落盘只一份');
});

test('#626 段评图不下载（净化剔掉的不该发请求）', async () => {
  const asked: string[] = [];
  const r = await exportBook(
    { name: 'b', chapters: [{ title: '第一章', url: 'https://s.example/1' }], format: 'epub' },
    {
      getContent: async () => ({
        paragraphs: [
          '<img src="https://s.example/real.jpg">',
          '<img src="https://s.example/cut.jpg,{&quot;click&quot;:&quot;getDP(1,2)&quot;}">',
        ],
      }),
      fetchImage: async (url) => {
        asked.push(url);
        return PNG;
      },
    },
  );
  assert.deepEqual(asked, ['https://s.example/real.jpg']);
  assert.equal(r.stats.images.total, 1);
});

test('#626 单张图失败：计入 failed、保留远程地址、导出仍成功', async () => {
  const r = await exportBook(
    { name: 'b', chapters: [{ title: '第一章', url: 'https://s.example/1' }], format: 'epub', includeChapterTitle: false },
    {
      getContent: async () => ({ paragraphs: ['<img src="https://s.example/dead.jpg">'] }),
      fetchImage: async () => null,
    },
  );
  assert.equal(r.stats.images.total, 1);
  assert.equal(r.stats.images.embedded, 0);
  assert.equal(r.stats.images.failed, 1);
  const z = epubEntries(new Uint8Array(await r.blob.arrayBuffer()));
  assert.equal(z.names.filter((n) => n.startsWith('OEBPS/Images/')).length, 0);
  assert.match(z.text('OEBPS/text/chapter-0001.xhtml'), /src="https:\/\/s\.example\/dead\.jpg"/, '取不到就保持原地址');
});

test('#626 抛错的 fetchImage 也被吞掉（不打死整本导出）', async () => {
  const r = await exportBook(
    { name: 'b', chapters: [{ title: '第一章', url: 'https://s.example/1' }], format: 'epub' },
    {
      getContent: async () => ({ paragraphs: ['<img src="https://s.example/boom.jpg">', '正文'] }),
      fetchImage: async () => {
        throw new Error('403');
      },
    },
  );
  assert.equal(r.stats.images.failed, 1);
  assert.equal(r.stats.written, 1);
});

test('#626 embedImages:false / txt ⇒ 一次都不请求（老行为可回退）', async () => {
  let calls = 0;
  const deps: ExportDeps = {
    getContent: async () => ({ paragraphs: ['<img src="https://s.example/a.jpg">'] }),
    fetchImage: async () => {
      calls += 1;
      return PNG;
    },
  };
  const epub = await exportBook(
    { name: 'b', chapters: [{ title: '一', url: 'https://s.example/1' }], format: 'epub', embedImages: false },
    deps,
  );
  assert.equal(calls, 0);
  assert.equal(epub.stats.images.total, 0);
  const z = epubEntries(new Uint8Array(await epub.blob.arrayBuffer()));
  assert.match(z.text('OEBPS/text/chapter-0001.xhtml'), /src="https:\/\/s\.example\/a\.jpg"/);

  const txt = await exportBook({ name: 'b', chapters: [{ title: '一' }], format: 'txt' }, deps);
  assert.equal(calls, 0);
  assert.deepEqual(txt.stats.images, { total: 0, embedded: 0, failed: 0 });
});

test('#626 封面：fetchCover 给字节 ⇒ 进 zip 且是 spine 第一项；不给 ⇒ 无封面页', async () => {
  const withCover = await exportBook(
    { name: 'b', chapters: [{ title: '一' }], format: 'epub' },
    {
      getContent: async () => ({ paragraphs: ['正文'] }),
      fetchCover: async () => ({ src: 'https://s.example/cover.webp', data: PNG }),
    },
  );
  const z1 = epubEntries(new Uint8Array(await withCover.blob.arrayBuffer()));
  assert.ok(z1.names.includes('OEBPS/text/cover.xhtml'));
  assert.ok(z1.names.some((n) => /^OEBPS\/Images\/cover\.png$/.test(n)), '扩展名以字节为准');
  assert.match(z1.text('OEBPS/content.opf'), /<itemref idref="cover"\/>/);

  const noCover = await exportBook({ name: 'b', chapters: [{ title: '一' }], format: 'epub' }, {
    getContent: async () => ({ paragraphs: ['正文'] }),
  });
  const z2 = epubEntries(new Uint8Array(await noCover.blob.arrayBuffer()));
  assert.ok(!z2.names.includes('OEBPS/text/cover.xhtml'));
});

test('#626 图片阶段进度回传（phase=images，文案要用它）', async () => {
  const phases: string[] = [];
  await exportBook(
    { name: 'b', chapters: [{ title: '一', url: 'https://s.example/1' }], format: 'epub' },
    {
      getContent: async () => ({ paragraphs: ['<img src="https://s.example/a.jpg">', '<img src="https://s.example/b.jpg">'] }),
      fetchImage: async () => PNG,
      concurrency: 1,
    },
    (p) => {
      if (p.phase === 'images') phases.push(`${p.images?.done}/${p.images?.total}`);
    },
  );
  assert.deepEqual(phases, ['1/2', '2/2']);
});
