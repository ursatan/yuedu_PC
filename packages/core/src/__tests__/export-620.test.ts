/**
 * `#620` 导出 txt / epub
 *
 * 关键点：**epub 的校验用仓内既有的「只读 zip 解析器」反向解包**（`local-book/zip.ts`）——
 * 自己写的写入器让自己读，等于自证；用另一份独立实现（读 CD + inflate）验，才是真验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readCentralDirectory, readEntryBy } from '../local-book/zip';
import {
  buildEpub,
  buildTxt,
  buildTxtChapterBlock,
  buildTxtHeader,
  crc32,
  exportFileName,
  formatExportText,
  isExportReviewImage,
  removeExportImages,
  resolveExportChapterContent,
  sanitizeExportContent,
  zipFiles,
  TXT_INDENT,
} from '../export';

const dec = new TextDecoder();

/** 真的压缩函数（用 node:zlib）——这样「mimetype 仍 STORED」才是被证明的，而不是因为没给压缩器 */
const nodeDeflate = async (d: Uint8Array): Promise<Uint8Array | undefined> => new Uint8Array(deflateRawSync(d));

test('#620 sanitize：三种段评图形态都剔除（上游 isExportReviewImage 三条判据）', () => {
  // a. click = getDP(n,m) / getZP(n)
  assert.equal(isExportReviewImage('https://a/1.jpg,{"click":"getDP(1,2)"}'), true);
  assert.equal(isExportReviewImage('https://a/1.jpg,{"click":"getZP(3)"}'), true);
  // b. click = dpshow(n) 且 js = dpurl(...)
  assert.equal(isExportReviewImage('https://a/1.jpg,{"click":"dpshow(7)","js":"dpurl(7)"}'), true);
  // b 的否定：只有 show 没有 url ⇒ 不是段评
  assert.equal(isExportReviewImage('https://a/1.jpg,{"click":"dpshow(7)"}'), false);
  // c. style = text && reviewCount > 0 && click 非空
  assert.equal(isExportReviewImage('https://a/1.jpg,{"style":"text","reviewCount":3,"click":"x()"}'), true);
  assert.equal(isExportReviewImage('https://a/1.jpg,{"style":"text","reviewCount":0,"click":"x()"}'), false);
  assert.equal(isExportReviewImage('https://a/1.jpg,{"style":"text","reviewCount":3}'), false);
  // 普通插图（没有尾巴）
  assert.equal(isExportReviewImage('https://a/1.jpg'), false);
  assert.equal(isExportReviewImage(''), false);
});

test('#620 sanitize：正文清洗只删段评图，普通插图保留；不可见字符一律删', () => {
  const html = [
    '第一段\u200B文字\uFEFF',
    '<img src="https://a/cut.jpg,{&quot;click&quot;:&quot;getDP(1,2)&quot;}">',
    '<img src="https://a/keep.jpg">',
  ].join('\n');
  const out = sanitizeExportContent(html);
  assert.ok(!out.includes('cut.jpg'), '段评图应被剔除');
  assert.ok(out.includes('keep.jpg'), '普通插图不能被误删');
  assert.ok(!out.includes('\u200B') && !out.includes('\uFEFF'));
  // removeExportImages 全删
  assert.equal(removeExportImages('<img src="https://a/1.jpg"><img src="https://a/2.jpg">'), '');
});

test('#620 formatExportText：折空行 + 段首缩进（上游 HtmlFormatter.formatText 等价）', () => {
  // ★ 首行不缩进（上游规则是「换行后补缩进」，不是「每行补缩进」）
  assert.equal(formatExportText('第一段\n\n\n第二段'), `第一段\n${TXT_INDENT}第二段`);
  assert.equal(formatExportText('  开头有空格  '), `${TXT_INDENT}开头有空格`);
  assert.equal(formatExportText(''), '');
  // formatIntro 的缩进是空串
  assert.equal(formatExportText('简介一\n简介二', ''), '简介一\n简介二');
});

test('#620 文件名：`书名 作者：作者.txt`，非法字符换下划线（上游 fileNameRegex2）', () => {
  assert.equal(exportFileName('夜无疆', '辰东', 'txt'), '夜无疆 作者：辰东.txt');
  assert.equal(exportFileName('a/b:c*d?e"f<g>h|i', '', 'epub'), 'a_b_c_d_e_f_g_h_i 作者：.epub');
  // 书名里的 `.` 上游**不**替换（fileNameRegex2 不含点）
  assert.equal(exportFileName('第1.5卷', 'x', 'txt'), '第1.5卷 作者：x.txt');
  assert.equal(exportFileName('', '', 'txt'), '未命名 作者：.txt');
});

test('#620 txt 书头：书名 / 作者 / 简介（`简介：` 后换行，缩进为空）', () => {
  const h = buildTxtHeader({ name: '夜无疆', author: '辰东', intro: '第一段\n第二段' });
  // 上游 `intro_show` = `简介：%s`，%s = `"\n" + format(intro)` ⇒ 简介首行不缩进、次段缩进
  assert.equal(h, `夜无疆\n作者：辰东\n简介：\n第一段\n${TXT_INDENT}第二段`);
});

test('#620 txt 章节块：`\\n\\n` 开头，标题与正文都带全角缩进', () => {
  // 标题是合并后的**首行** ⇒ 不缩进；正文各段缩进（上游 `ContentProcessor.kt:253` 拼接后整体 format）
  const block = buildTxtChapterBlock({ title: '第一章 起点', paragraphs: ['甲段', '乙段'] });
  assert.equal(block, `\n\n第一章 起点\n${TXT_INDENT}甲段\n${TXT_INDENT}乙段`);
});

test('#620 txt：没正文且非卷 ⇒ 整章跳过（连标题都不写）；卷 ⇒ 只写标题', () => {
  assert.equal(resolveExportChapterContent({ title: 'x', paragraphs: null }), null);
  assert.equal(resolveExportChapterContent({ title: 'x', paragraphs: null, isVolume: true }), '');
  assert.equal(buildTxtChapterBlock({ title: 'x', paragraphs: null }), null);

  const txt = buildTxt({
    name: '书',
    author: '人',
    intro: '',
    chapters: [
      { title: '卷一', isVolume: true, paragraphs: null },
      { title: '第一章', paragraphs: ['正文'] },
      { title: '第二章', paragraphs: null }, // 未缓存 ⇒ 跳过
      { title: '第三章', paragraphs: ['末段'] },
    ],
  });
  assert.ok(txt.startsWith('书\n作者：人\n简介：\n'), '书头在首位');
  assert.ok(txt.includes('卷一'), '卷标题要写');
  assert.ok(!txt.includes('第二章'), '没正文的非卷章节整章跳过');
  assert.ok(txt.indexOf('第一章') < txt.indexOf('第三章'));
  /**
   * ★ 空简介时会连出三个换行 —— **这是上游的行为**，不是我们的 bug：
   * `qy` 以 `简介：\n` 结尾（`intro_show` 的 `%s` = `"\n" + format(intro)`，简介为空时 format 返空串），
   * 紧接着章节块又是 `"\n\n" + …` ⇒ `简介：\n\n\n卷一`。
   * 改成「漂亮的两空行」会让导出文件与手机端不一致，所以照抄，并在此显式锁定。
   */
  assert.ok(txt.includes('简介：\n\n\n卷一'), '上游在空简介时确有连续三个换行，锁住以防「顺手美化」');
});

test('#620 txt：includeChapterTitle=false ⇒ 只有正文；includeHeader=false ⇒ 不写书头', () => {
  const txt = buildTxt({
    name: '书',
    chapters: [{ title: '第一章', paragraphs: ['正文'] }],
    includeChapterTitle: false,
    includeHeader: false,
  });
  assert.equal(txt, `\n\n正文`);
});

test('#620 导出的 txt 会把正文里的图片删掉（txt 装不了图）', () => {
  const txt = buildTxt({
    name: '书',
    chapters: [{ title: '第一章', paragraphs: ['文字<img src="https://a/1.jpg">后面'] }],
    includeHeader: false,
  });
  assert.ok(!txt.includes('<img'));
  assert.ok(txt.includes('文字后面'));
});

test('#620 crc32 与已知值一致（空串 0 / "123456789" = 0xCBF43926）', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('#620 zip：mimetype 必须是第一项且 STORED（epub 的硬要求），且能被独立解析器读回', async () => {
  const zip = await zipFiles(
    [
      { path: 'mimetype', data: new TextEncoder().encode('application/epub+zip'), store: true },
      { path: 'a/b.txt', data: new TextEncoder().encode('你好 world') },
    ],
    { deflate: nodeDeflate },
  );
  const ar = readCentralDirectory(zip);
  assert.equal(ar.entries.length, 2);
  assert.equal(ar.entries[0]!.name, 'mimetype');
  assert.equal(ar.entries[0]!.method, 0, 'mimetype 必须 STORED（即使有可用的压缩器）');
  assert.equal(dec.decode(readEntryBy(zip, ar.entries[0]!)), 'application/epub+zip');
  assert.equal(dec.decode(readEntryBy(zip, ar.entries[1]!)), '你好 world');
});

test('#620 epub：结构完整（container/opf/ncx/nav/每章 xhtml），标题与简介进元数据', async () => {
  const epub = await buildEpub(
    {
      name: '夜无疆',
      author: '辰东',
      intro: '简介一段 & <危险>',
      chapters: [
        { title: '卷一 启程', isVolume: true, paragraphs: null },
        { title: '第一章', paragraphs: ['甲段', '乙段'] },
        { title: '第二章', paragraphs: null }, // 未缓存 ⇒ 不进书
      ],
    },
    { deflate: nodeDeflate },
  );
  const ar = readCentralDirectory(epub);
  const names = ar.entries.map((e) => e.name);
  assert.equal(names[0], 'mimetype');
  assert.equal(ar.entries[0]!.method, 0, 'epub 的 mimetype 必须 STORED');
  // 除 mimetype 外应当真的被压缩了（否则这条测试等于没覆盖 DEFLATE 路径）
  assert.ok(ar.entries.slice(1).some((e) => e.method === 8), '正文 xhtml/opf 应走 DEFLATE');
  for (const must of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/toc.ncx', 'OEBPS/nav.xhtml', 'OEBPS/style.css']) {
    assert.ok(names.includes(must), `缺 ${must}`);
  }
  // 卷 + 第一章 = 2 个 xhtml；第二章没有正文，不该出现
  const chapters = names.filter((n) => /^OEBPS\/text\/chapter-\d{4}\.xhtml$/.test(n));
  assert.equal(chapters.length, 2, `实际：${chapters.join(',')}`);

  const opf = dec.decode(readEntryBy(epub, ar.entries[names.indexOf('OEBPS/content.opf')]!));
  assert.match(opf, /<dc:title>夜无疆<\/dc:title>/);
  assert.match(opf, /<dc:creator>辰东<\/dc:creator>/);
  assert.match(opf, /<dc:language>zh<\/dc:language>/);
  assert.match(opf, /<dc:publisher>Legado<\/dc:publisher>/);
  // 简介里的 XML 特殊字符必须转义（否则 epub 直接打开报错）
  assert.match(opf, /<dc:description>简介一段 &amp; &lt;危险&gt;<\/dc:description>/);
  // spine 与 manifest 条数一致
  const spineRefs = opf.match(/<itemref idref="/g) ?? [];
  assert.equal(spineRefs.length, 2);

  const ch1 = dec.decode(readEntryBy(epub, ar.entries[names.indexOf('OEBPS/text/chapter-0002.xhtml')]!));
  assert.match(ch1, /<h2>第一章<\/h2>/);
  assert.match(ch1, /<p>甲段<\/p>/);
  assert.match(ch1, /<p>乙段<\/p>/);
  // 卷页只应有标题、无正文
  const vol = dec.decode(readEntryBy(epub, ar.entries[names.indexOf('OEBPS/text/chapter-0001.xhtml')]!));
  assert.match(vol, /class="volume"/);
  assert.match(vol, /<h2>卷一 启程<\/h2>/);
  assert.ok(!/<p>/.test(vol));
});

test('#620 epub：带压缩钩子时条目用 DEFLATE，且解压回来内容不变', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const epub = await buildEpub(
    { name: 'x', author: 'y', chapters: [{ title: '第一章', paragraphs: ['重复内容'.repeat(200)] }] },
    { deflate: async (b) => new Uint8Array(deflateRawSync(b)) },
  );
  const ar = readCentralDirectory(epub);
  const chEntry = ar.entries.find((e) => e.name === 'OEBPS/text/chapter-0001.xhtml')!;
  assert.equal(chEntry.method, 8, '正文应被压缩');
  const html = dec.decode(readEntryBy(epub, chEntry));
  assert.ok(html.includes('重复内容'), '解压后内容必须完整');
  // mimetype 仍然 STORED（无论钩子怎么压）
  assert.equal(ar.entries[0]!.method, 0);
});
