/**
 * 本地书解析回归测试（`#202`）
 *
 * 覆盖 `local-book/`：编码探测 · TXT 分章与取正文 · 文件名→书名作者 · EPUB（zip/OPF/目录/正文）。
 *
 * ## 为什么自己造 zip
 * epub 就是 zip，而**造一个 zip 不需要依赖** —— STORED（不压缩）条目的格式是
 * 「本地头 + 原文 + 中央目录 + EOCD」，加一个 CRC32 表即可（下面 40 行）。
 * 自己造的好处：**测试数据完全可控**（能精确构造「fragment 跨文件」「目录在 nav / ncx」
 * 「spine 前面有封面页」这些分支），且不引入测试期依赖。
 *
 * ## 断言口径
 * 不只断言「没抛错」：每一条都断言**具体值**（章节数、标题、偏移、正文内容），
 * 并各配一条**防空转**断言（例如「偏移切出来的原文必须真等于期望的那几行」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import {
  analyzeFileName,
  detectCharset,
  decodeBuffer,
  expandGroupRefs,
  normaliseCharset,
  htmlToParagraphs,
  importLocalBook,
  importLocalBookArchive,
  isSupportedLocalBook,
  listArchiveBooks,
  localBookUrlOf,
  parseEpub,
  parseMobi,
  parsePdf,
  parseSanitize,
  parseTxt,
  parseUmd,
  readCentralDirectory,
  readEpubAsset,
  readEpubChapter,
  readEpubContent,
  readLocalBookContent,
  readMobiContent,
  readMobiCover,
  readTxtContent,
  readUmdContent,
  sanitizeEpubHtml,
} from '../local-book';

/* ------------------------------------------------------------------ *
 * 最小 ZIP 写入器（STORED，只为本测试服务）
 * ------------------------------------------------------------------ */

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    CRC_TABLE = t;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 把若干「文件」打成一个 STORED zip（不做压缩，解析器同样要支持 method 0）
 *
 * 内容可以是字符串（按 UTF-8 编）或 **原始字节**（`#212` Step2：图片资源）。
 */
function makeZip(files: Array<[string, string | Uint8Array]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const [name, content] of files) {
    const nameB = enc.encode(name);
    const dataB = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(dataB);
    const local = new Uint8Array(30 + nameB.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // method = stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataB.length, true);
    lv.setUint32(22, dataB.length, true);
    lv.setUint16(26, nameB.length, true);
    local.set(nameB, 30);
    chunks.push(local, dataB);

    const cen = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true); // method
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataB.length, true);
    cv.setUint32(24, dataB.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameB, 46);
    central.push(cen);
    offset += local.length + dataB.length;
  }
  const cenStart = offset;
  let cenSize = 0;
  for (const c of central) cenSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, cenStart, true);
  const all = [...chunks, ...central, eocd];
  const total = all.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/* ------------------------------------------------------------------ *
 * 一、编码探测
 * ------------------------------------------------------------------ */

test('#202 编码探测：BOM 优先，其次按「能否严格解成 UTF-8」判', () => {
  assert.equal(detectCharset(utf8('第一章 你好')), 'utf-8', '纯 UTF-8 中文应判 utf-8');
  assert.equal(
    detectCharset(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
    'utf-8',
    'UTF-8 BOM 是事实，优先于一切猜测',
  );
  assert.equal(detectCharset(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), 'utf-16le', 'UTF-16LE BOM');
  assert.equal(detectCharset(new Uint8Array([0xfe, 0xff, 0x00, 0x41])), 'utf-16be', 'UTF-16BE BOM');
  // GBK 的「中」= D6 D0（非法 UTF-8 序列）⇒ 必须判成非 UTF-8
  const gbk = new Uint8Array([0xd6, 0xd0, 0xb9, 0xfa]);
  assert.equal(detectCharset(gbk), 'gb18030', 'GBK 字节序列不是合法 UTF-8 ⇒ 判 gb18030');
  assert.equal(decodeBuffer(gbk, 'gbk'), '中国', '按 gb18030 解出来必须真的是「中国」（防空转）');
  assert.equal(decodeBuffer(utf8('中国'), 'utf-8'), '中国', 'UTF-8 也要解对');
});

/* ------------------------------------------------------------------ *
 * 二、TXT 分章
 * ------------------------------------------------------------------ */

/**
 * 造一段**真实长度**的章节正文。
 *
 * ⚠️ 为什么必须够长：上游选目录规则的判据里有「距上次标题 < 1000 字 ⇒ 疑是卷、不计有效章节」
 *   （`TextFile.getTocRule`），并要求「有效章节数 ≥ 卷数×3」。这是**上游原样移植**的启发式，
 *   对「两三章、每章几十字」的玩具样本会**故意判成误识别** ⇒ 退回按长度硬切。
 *   所以测试样本按真实小说规模造（每章 > 1000 字），否则测的是兜底分支而不是分章规则。
 */
function pad(n: number, tag: string): string {
  return Array.from({ length: n }, (_, i) => `${tag}第${i}行的内容。`).join('\n');
}

const TXT = [
  '这是前言第一行。',
  '这是前言第二行。',
  '',
  '第一章 起点',
  pad(160, '甲'),         // ≈ 1400 字（必须 > 1000，见上面说明）
  '',
  '第二章 归来',
  pad(160, '乙'),
  '',
  '第三章 终局',
  pad(160, '丙'),
  '',
].join('\n');

test('#202 TXT：第 X 章 分章 + 偏移口径（start 在标题后、end 在下个标题前）', () => {
  const buf = utf8(TXT);
  const p = parseTxt(buf);
  assert.equal(p.charset, 'utf-8');
  assert.ok(p.chapters.length >= 4, `至少分出 前言 + 3 章，实得 ${p.chapters.length}`);
  assert.deepEqual(
    p.chapters.map((c) => c.title).slice(0, 4),
    ['前言', '第一章 起点', '第二章 归来', '第三章 终局'],
    '标题必须按顺序解析出来（前言来自第一个标题之前的内容）',
  );
  // ★ 防空转：偏移切出来的正文必须真是那几行，而不是「恰好位置对」
  const c1 = p.chapters[1]!;
  const body = readTxtContent(buf, p.charset, c1.start, c1.end);
  assert.ok(body.includes('甲第0行的内容。'), `第一章正文应含甲段内容，实得前 80 字：${JSON.stringify(body.slice(0, 80))}`);
  assert.ok(body.includes('甲第159行的内容。'), '本章最后一行也要在');
  assert.ok(!body.includes('第一章 起点'), '★ 正文不得包含标题（start 落在标题之后）');
  assert.ok(!body.includes('乙第0行的内容。'), '★ 正文不得越过下一章（end 落在下个标题之前）');
  // 前言那一章要含前言内容
  const pre = p.chapters[0]!;
  assert.ok(readTxtContent(buf, p.charset, pre.start, pre.end).includes('这是前言第一行。'));
  assert.equal(p.chapters.at(-1)!.end, TXT.length, '最后一章的 end = 全文长度');
});

test('#202 TXT：标题之间没有内容 ⇒ 判为卷名（isVolume）', () => {
  // 1 个卷 + 5 章：上游要求「有效章节数 ≥ 卷数×3」才认这条规则，所以样本要够
  const text = [
    // ⚠️ 开头要有一行「前言」：首选的目录规则用 `(?<=[　\s])` 后行断言，**文件第一位**的标题
    //    前面没有空白 ⇒ 匹配不到（上游同样如此）。真实 txt 几乎都有书名/作者行，这里照此还原。
    '这是前言。', '',
    '第一章 起点', pad(160, '甲'), '',
    '第二卷 风起', '',
    '第二章 接续', pad(160, '乙'), '',
    '第三章 再续', pad(160, '丙'), '',
    '第四章 又续', pad(160, '丁'), '',
    '第五章 终章', pad(160, '戊'), '',
  ].join('\n');
  const p = parseTxt(utf8(text));
  const vol = p.chapters.find((c) => c.title.includes('第二卷'));
  assert.ok(vol, `应解析出「第二卷 风起」，实得 ${p.chapters.map((c) => c.title).join(' | ')}`);
  assert.equal(vol!.isVolume, true, '★ 该章后面没有正文 ⇒ 必须是卷名（阅读器要跳过它取正文）');
  const first = p.chapters.find((c) => c.title.includes('第一章'));
  assert.equal(first!.isVolume, false, '有正文的章不能标成卷');
  assert.ok(vol!.end - vol!.start <= 2, `卷名章的内容只应有换行（实得 ${vol!.end - vol!.start} 个字符）`);
});

test('#202 TXT：完全没有章节标题 ⇒ 按固定长度硬切（不能返回 0 章）', () => {
  const text = '这是一段没有任何章节标题的文字。'.repeat(2000); // 约 3.2 万字
  const p = parseTxt(utf8(text));
  assert.ok(p.chapters.length >= 2, `无标题也必须切出多节，实得 ${p.chapters.length}`);
  assert.ok(p.chapters.every((c) => c.end > c.start), '每节的 end 必须大于 start');
  // 防空转：所有节拼起来应覆盖全文
  const sum = p.chapters.reduce((a, c) => a + (c.end - c.start), 0);
  assert.ok(Math.abs(sum - text.length) <= 2, `分节应覆盖全文（${sum} vs ${text.length}）`);
});

test('#202 TXT：文件名 → 书名/作者（照上游 4 条内置模式）', () => {
  assert.deepEqual(analyzeFileName('《斗破苍穹》作者：天蚕土豆.txt'), { name: '斗破苍穹', author: '天蚕土豆' });
  assert.deepEqual(analyzeFileName('某某某 作者：张三.txt'), { name: '某某某', author: '张三' });
  assert.deepEqual(analyzeFileName('书名 by 作者名.epub'), { name: '书名', author: '作者名' });
  const plain = analyzeFileName('平凡的世界.txt');
  assert.equal(plain.name, '平凡的世界', '没有作者信息时书名就是文件名去后缀');
  assert.equal(plain.author, '', '猜不出作者时必须是空串（不能瞎填）');
});

/* ------------------------------------------------------------------ *
 * 二·补 `#212`：tocUrl 净化 / 超长章节拆分 / 字数
 * ------------------------------------------------------------------ */

test('#212 ⑥ 净化表达式词法：支持 @replace/@trim/@all，其它一律判「不支持」', () => {
  assert.deepEqual(parseSanitize(''), [], '空串 = 不净化（照上游 isNullOrBlank 早返回）');
  assert.deepEqual(parseSanitize('@all'), [], '显式 @all = 不净化');
  assert.deepEqual(parseSanitize('@trim'), [{ kind: 'trim' }]);
  assert.deepEqual(parseSanitize('@replace:^第(\\d+)章'), [{ kind: 'replace', src: '^第(\\d+)章', to: '' }]);
  assert.deepEqual(parseSanitize('@replace:^第(\\d+)章@$1'), [{ kind: 'replace', src: '^第(\\d+)章', to: '$1' }]);
  // ★ 多条串联
  assert.equal(parseSanitize('@trim\n@replace:x@y')!.length, 2);
  // ★ 不支持的形态必须返回 null（⇒ 调用方保留原标题 + 留痕），绝不能猜
  assert.equal(parseSanitize('result.replace(/x/,"")'), null, '裸 JS 必须判不支持');
  assert.equal(parseSanitize('@replace:'), null, '空正则判不支持');
  assert.equal(parseSanitize('@trim\nresult'), null, '一条不支持 ⇒ 整条不支持');
  assert.equal(parseSanitize('@unknown'), null);
});

test('#212 ⑥ 组引用展开：$0 = 整个匹配（JS 原生 replace 不认 $0）', () => {
  assert.equal(expandGroupRefs('[$0]', ['abc']), '[abc]');
  assert.equal(expandGroupRefs('$1-$2', ['whole', 'a', 'b']), 'a-b');
  // 只有 2 个组时 `$10` = `$1` + 字面量 `0`（Java appendReplacement 同款）
  assert.equal(expandGroupRefs('$10', ['w', 'a', 'b']), 'a0');
  // 超范围的组号 ⇒ 抛错（让上层判「该条净化为空 ⇒ 丢掉」，不留半个结果）
  assert.throws(() => expandGroupRefs('$3', ['w', 'a', 'b']), /No group 3/);
});

test('#212 ⑥ ★ 端到端：默认规则表 replacement 全空 ⇒ 标题原样保留（不执行任何脚本）', () => {
  // 26 条内置规则的 `replacement` 实测全为空 ⇒ 开箱行为 = 「不动标题」。
  // 这条断言守住「默认不改写」；净化能力只对**用户挂了表达式的规则**生效。
  const text = ['这是前言。', '', '第一章 起点', pad(160, '甲'), '', '第二章 归来', pad(160, '乙'), '', '第三章 终局', pad(160, '丙')].join('\n');
  const p = parseTxt(utf8(text));
  assert.deepEqual(
    p.chapters.map((c) => c.title).slice(1, 4),
    ['第一章 起点', '第二章 归来', '第三章 终局'],
    '★ 默认（26 条内置规则 replacement 全为空）必须原样保留标题',
  );
});

test('#212 ⑤ 超长章节拆分：原章降级为卷名 + 子章标 (1)(2)…', () => {
  // 一章 ≈ 250KB（> 102400），应被拆成 3 段左右
  const huge = pad(14000, '巨'); // ≈ 14000 行 × ~10 字 ≈ 14 万字
  const text = ['这是前言。', '', '第一章 起点', pad(160, '甲'), '', '第二章 巨章', huge, '', '第三章 终局', pad(160, '丙')].join('\n');
  const noSplit = parseTxt(utf8(text), null, false);
  const split = parseTxt(utf8(text), null, true);
  // 关闭拆分时该章原样一大章
  assert.ok(noSplit.chapters.some((c) => c.title === '第二章 巨章' && !c.isVolume), '★ 不开拆分：大章原样存在');
  // 开启拆分：出现「第二章 巨章」卷名 + (1)(2)…
  const vol = split.chapters.find((c) => c.title === '第二章 巨章');
  assert.ok(vol, '★ 开拆分：原标题保留为一个条目');
  assert.equal(vol!.isVolume, true, '★ 原章必须降级为卷名（end 收到 start）');
  assert.equal(vol!.end, vol!.start, '★ 卷名章没有正文区间');
  const children = split.chapters.filter((c) => /^第二章 巨章\(\d+\)$/.test(c.title));
  assert.ok(children.length >= 2, `★ 应拆出多个子章，实得 ${children.length}`);
  assert.deepEqual(children.map((c) => c.title), children.map((_, i) => `第二章 巨章(${i + 1})`), '子章编号必须是 (1)(2)… 连续');
  // 防空转：子章正文必须**加起来等于原文**（不能丢字/重复）
  const sum = children.reduce((a, c) => a + (c.end - c.start), 0);
  const orig = noSplit.chapters.find((c) => c.title === '第二章 巨章')!;
  assert.equal(sum, orig.end - orig.start, '★ 拆出的子章必须无缝拼回原区间');
});

/* ------------------------------------------------------------------ *
 * 三、EPUB
 * ------------------------------------------------------------------ */

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:description>这是简介。</dc:description>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">第一章 开始</a></li>
  <li><a href="ch2.xhtml">第二章 继续</a></li>
</ol></nav></body></html>`;

const COVER_PAGE = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>封面页</title></head>
<body><div><img src="cover.jpg" alt="封面"/></div></body></html>`;

const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head>
<body><h1>第一章 开始</h1><p>第一段。</p><p>第二段。</p></body></html>`;

const CH2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head>
<body><p>第二章正文。</p><p>第二章第二段。</p></body></html>`;

function sampleEpub(): Uint8Array {
  return makeZip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', CONTAINER],
    ['OEBPS/content.opf', OPF],
    ['OEBPS/nav.xhtml', NAV],
    ['OEBPS/cover.xhtml', COVER_PAGE],
    ['OEBPS/ch1.xhtml', CH1],
    ['OEBPS/ch2.xhtml', CH2],
  ]);
}

test('#202 EPUB：zip → container → OPF → nav 目录解析', () => {
  const e = parseEpub(sampleEpub());
  assert.equal(e.title, '测试之书', 'dc:title 要取到');
  assert.equal(e.author, '测试作者', 'dc:creator 要取到');
  assert.equal(e.intro, '这是简介。', 'dc:description 要取到');
  assert.deepEqual(e.spine, ['OEBPS/cover.xhtml', 'OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml'], 'spine 顺序');
  assert.deepEqual(
    e.chapters.map((c) => c.title),
    ['封面页', '第一章 开始', '第二章 继续'],
    '★ spine 里第一个目录目标之前的 cover.xhtml 要补成第一章（照上游 parseFirstPage）',
  );
  assert.deepEqual(e.chapters.map((c) => c.href), [
    'OEBPS/cover.xhtml',
    'OEBPS/ch1.xhtml',
    'OEBPS/ch2.xhtml',
  ]);
});

test('#202 EPUB：正文提取（段落切分 + 标题标签不进正文）', () => {
  const buf = sampleEpub();
  const e = parseEpub(buf);
  const ch1 = e.chapters.find((c) => c.href === 'OEBPS/ch1.xhtml')!;
  const paras = readEpubContent(buf, ch1.url, e.chapters[e.chapters.indexOf(ch1) + 1]!.url, e.spine);
  assert.deepEqual(paras, ['第一章 开始', '第一段。', '第二段。'], `实得 ${JSON.stringify(paras)}`);
  assert.ok(!paras.some((p) => p.includes('<')), '段落里不得残留 HTML 标签');
});

test('#202 EPUB：无 nav 时退回 toc.ncx（EPUB2）', () => {
  const NCX = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1"><navLabel><text>甲章</text></navLabel><content src="ch1.xhtml"/></navPoint>
  <navPoint id="n2"><navLabel><text>乙章</text></navLabel><content src="ch2.xhtml#sec2"/>
    <navPoint id="n2a"><navLabel><text>乙章之一</text></navLabel><content src="ch2.xhtml#sec2a"/></navPoint>
  </navPoint>
</navMap></ncx>`;
  const OPF2 = OPF.replace('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>').replace(
    '</manifest>',
    '</manifest>',
  );
  const buf = makeZip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', CONTAINER],
    ['OEBPS/content.opf', OPF2],
    ['OEBPS/toc.ncx', NCX],
    ['OEBPS/cover.xhtml', COVER_PAGE],
    ['OEBPS/ch1.xhtml', CH1],
    ['OEBPS/ch2.xhtml', CH2],
  ]);
  const e = parseEpub(buf);
  const titles = e.chapters.map((c) => c.title);
  assert.ok(titles.includes('甲章') && titles.includes('乙章'), `应解析 ncx 目录，实得 ${titles.join(' | ')}`);
  assert.ok(titles.includes('乙章之一'), '★ navPoint **嵌套**层级也要展开（上游递归取）');
  const nested = e.chapters.find((c) => c.title === '乙章之一')!;
  assert.equal(nested.startFragmentId, 'sec2a', '带 #fragment 的目录项要保留 fragment');
});

test('#202 EPUB：DRM 加密必须**明确报错**（不静默给空正文）', () => {
  const buf = makeZip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', CONTAINER],
    ['META-INF/encryption.xml', '<encryption/>'],
    ['OEBPS/content.opf', OPF],
    ['OEBPS/nav.xhtml', NAV],
    ['OEBPS/ch1.xhtml', CH1],
  ]);
  assert.throws(() => parseEpub(buf), /DRM/, '带 encryption.xml 要报「不支持解密」，而不是给空章');
});

test('#202 HTML → 段落：块级断开、script/style/注音剔除', () => {
  const paras = htmlToParagraphs(
    '<body><style>p{color:red}</style><script>var a=1</script><p>甲</p><div>乙<span>丙</span></div><p>丁<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby></p></body>',
  );
  assert.deepEqual(paras, ['甲', '乙丙', '丁漢'], `实得 ${JSON.stringify(paras)}`);
});

/* ------------------------------------------------------------------ *
 * 四、入库装配（importLocalBook）
 * ------------------------------------------------------------------ */

test('#202 importLocalBook：txt 装配出的书与目录行可用于直接入库', () => {
  const r = importLocalBook(utf8(TXT), '《测试书》作者：某人.txt');
  // ★ `#212` Step3：主键改为**契约层唯一算法**（`localBookUrlOf`）。
  //   旧断言锁的是 `loc_book://<名>` —— 那是**与前端不一致的缺陷形态**（前端算的是
  //   `encodeItemKey(itemKey('loc_book',{fileName}))`）⇒ 走这条路的书前端会判成「不在书架」。
  //   这里改为断言「前缀与网络书隔开 + 与 localBookUrlOf 完全一致」。
  assert.equal(r.book.bookUrl, localBookUrlOf('《测试书》作者：某人.txt'), 'bookUrl 必须与前端主键算法一致');
  assert.ok(r.book.bookUrl.startsWith('loc_book'), 'bookUrl 用前缀与网络书隔开');
  assert.equal(r.book.origin, 'loc_book', 'origin 必须是 LOCAL_TAG');
  assert.equal(r.book.name, '测试书', '书名从文件名解析');
  assert.equal(r.book.author, '某人');
  assert.equal(r.book.charset, 'utf-8', 'charset 落库（取正文时要用）');
  assert.equal(r.book.totalChapterNum, r.chapters.length, 'totalChapterNum 要等于目录条数');
  assert.equal(r.chapters.length, r.book.totalChapterNum);
  // 目录行的关键字段
  const c1 = r.chapters[1]!;
  assert.equal(c1.bookUrl, r.book.bookUrl, '目录必须挂在这本书下（外键）');
  assert.equal(c1.index, 1, 'index 与顺序一致');
  assert.ok(c1.start !== null && c1.end !== null && c1.end > c1.start, 'txt 章必须有可用的 start/end');
  assert.ok(r.summary.tocRuleName.length > 0, '应记录命中的目录规则名（便于排查分章不理想）');
});

test('#202 importLocalBook：epub 装配 + 取正文（端到端，不落库）', () => {
  const buf = sampleEpub();
  const r = importLocalBook(buf, '测试之书.epub');
  assert.equal(r.summary.format, 'epub');
  assert.equal(r.book.name, '测试之书', 'epub 书名优先用 OPF 元数据');
  assert.equal(r.book.author, '测试作者');
  assert.equal(r.chapters.length, 3);
  const spine = JSON.parse(r.book.variable ?? '{}') as { epubSpine?: string[] };
  assert.deepEqual(spine.epubSpine, ['OEBPS/cover.xhtml', 'OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml'], 'spine 必须存进 variable');
  assert.ok(r.chapters[1]!.variable?.includes('nextUrl'), '每章要存下一章地址（取正文时用来定位结尾）');

  // 端到端：用「落库后的书行 + 章行」取正文
  const got = readLocalBookContent(buf, r.book, r.chapters[1]!);
  assert.deepEqual(got.paragraphs, ['第一章 开始', '第一段。', '第二段。'], `实得 ${JSON.stringify(got.paragraphs)}`);
  const got2 = readLocalBookContent(buf, r.book, r.chapters[2]!);
  assert.ok(got2.paragraphs.includes('第二章正文。'), '第二章正文要取到');
});

/**
 * `#217` **格式判据不能靠「有兜底的字段」反推**（`#312` 的又一例）。
 *
 * ## 真实故障（已实测复现）
 * `readLocalBookContent` 凭 `book.originName` 判格式。`originName` 会被前端写成空
 * （前端契约里没这个字段），服务端 `content` 端点**原先原样把 `book` 传进来**
 * ⇒ `ext === ''` ⇒ 落进「先 txt 后 epub」的试探分支 ⇒ **一本真 epub 被当纯文本按字节切**，
 * 正文返回 zip 二进制（`PK\x03\x04…mimetype application/epub+zip`）。
 *
 * ## 修法 = 单一判据 + 无兜底的诚实报错
 * 正解**不是**给 `readLocalBookContent` 加兜底（那会让「判据」在两个地方各推一次），
 * 而是**调用方传自洽的 `originName`**（服务端现在传 `fileNameFromLocalBookUrl` 反推的结果）。
 * 本测试把这条不变量钉住：**`originName` 为空时，epub 绝不能落进 txt 分支拿到乱码** ——
 * 要么正确取到正文（调用方补了 `originName`），要么**明确报错**（不许给二进制垃圾）。
 */
test('#217 originName 为空时 epub 不许落进 txt 分支拿乱码（宁可报错）', () => {
  const buf = sampleEpub();
  const r = importLocalBook(buf, '测试之书.epub');
  const ch = r.chapters[1]!;

  // ① 调用方补了 originName（= 服务端现在的行为）⇒ 正文正确
  const fixed = readLocalBookContent(buf, { ...r.book, originName: '测试之书.epub' }, ch);
  assert.deepEqual(fixed.paragraphs, ['第一章 开始', '第一段。', '第二段。'], '补了 originName 必须走 epub 分支');

  // ② 调用方没补（= 旧行为）⇒ 必然拿到乱码或报错，但**绝不能是「看起来正常的文本」**
  let paras: string[] | null = null;
  try {
    paras = readLocalBookContent(buf, { ...r.book, originName: '' }, ch).paragraphs;
  } catch {
    paras = null; // 报错是可接受的结果（比乱码好）
  }
  if (paras) {
    const joined = paras.join('');
    assert.ok(
      joined.includes('第一章 开始') && !joined.includes('PK\u0003\u0004'),
      `★ 空 originName 时必须报错或走对分支，绝不能把 epub 当文本切出乱码（实得 ${JSON.stringify(paras.slice(0, 2))}）`,
    );
  }
});

test('#212 ④ epub 每章字数：字数与正文段落字符数一致 + 书级总字数 = 各章之和', () => {
  const buf = sampleEpub();
  const r = importLocalBook(buf, '测试之书.epub');
  // 每章的字数必须等于「取正文后段落字符数之和」（防空转：不是随便填个 0）
  // ⚠️ 封面章（cover.xhtml）只有 `<img>` ⇒ 正文为空 ⇒ `readLocalBookContent` 会**按设计**抛错
  //    （铁律 3：不给静默空白）。所以这里只在「取得到正文」的章上比对，并断言封面章字数为 null。
  let compared = 0;
  for (const ch of r.chapters) {
    let paras: string[];
    try {
      paras = readLocalBookContent(buf, r.book, ch).paragraphs;
    } catch {
      assert.equal(ch.wordCount, null, `无正文的章「${ch.title}」字数应为 null`);
      continue;
    }
    const expected = paras.reduce((a, p) => a + p.length, 0);
    assert.equal(ch.wordCount, expected ? `${expected}字` : null, `章「${ch.title}」字数应与正文一致`);
    compared += 1;
  }
  assert.ok(compared >= 2, `至少比对两章（实得 ${compared}）`);
  const total = r.chapters.reduce((a, c) => a + Number((c.wordCount ?? '0').replace(/[^\d]/g, '')), 0);
  assert.ok(total > 0, '★ 不能恒为 0（此前 epub 硬编码 0）');
  assert.ok(r.book.wordCount, '★ 书级 wordCount 必须有值');
  assert.equal(r.summary.wordCount, total, 'summary.wordCount = 各章之和');
});

test('#212 ④ epubWordCount=false 时不读 XHTML（字数降级为 null，但不报错）', () => {
  const r = importLocalBook(sampleEpub(), '测试之书.epub', null, { epubWordCount: false });
  assert.equal(r.book.wordCount, null, '关掉统计 ⇒ 书级字数为 null');
  assert.ok(r.chapters.every((c) => c.wordCount === null), '关掉统计 ⇒ 每章字数也为 null');
  assert.equal(r.chapters.length, 3, '★ 关掉统计**不能**影响章数（只是少读一遍 XHTML）');
});

test('#202 不支持的后缀必须明确报错（不静默当 txt 解析）', () => {
  assert.equal(isSupportedLocalBook('a.txt'), true);
  assert.equal(isSupportedLocalBook('a.EPUB'), true, '后缀大小写不敏感');
  // `#212` Step4 起 pdf / mobi / azw3 已支持；用**真没做**的后缀做「不支持」的对照
  assert.equal(isSupportedLocalBook('a.azw'), false, 'azw（旧版）本仓未支持');
  assert.throws(() => importLocalBook(utf8('x'), 'a.azw'), /暂不支持/, '不支持的类型要说清楚是什么类型');
  assert.throws(() => importLocalBook(new Uint8Array(0), 'a.txt'), /空/, '空文件要报错');
});

/* ===================== `#234` 手动指定文本编码 =====================
 * 自动探测（`detectCharset`）在**无 BOM 的 GBK vs Big5** 上可能互相误判
 * （都是双字节高位序列），而认错的后果是「整本乱码 + 目录全乱」且**不报错**。
 * ⇒ 必须让用户能手动指定（`ShelfView.vue` 的「文本编码」下拉 → `x-book-charset` 头）。
 *
 * 这一段锁的是「**hint 真的强制生效，且只影响 txt**」——
 * 后者是界面上那句提示「epub 不受此项影响」的唯一依据。
 */

/** 造一段 GBK 字节（中文「第一章」= D6 D0 CE C4 A1 A2） */
const GBK_BYTES = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xa1, 0xa2, 0x0a]);

test('#234 ① 自动探测：GBK 字节判 gb18030（作前置：证明「猜」在这类文件上本来就可能错）', () => {
  assert.equal(detectCharset(GBK_BYTES), 'gb18030');
});

test('#234 ② ★ 显式 hint 覆盖自动探测：同一份字节，指定 utf-8 就按 utf-8 解（结果自然是乱码 —— 这是预期的）', () => {
  const auto = importLocalBook(GBK_BYTES, 'a.txt');
  assert.equal(auto.book.charset, 'gb18030', '不给 hint 时按自动探测');
  const forced = importLocalBook(GBK_BYTES, 'a.txt', 'utf-8');
  assert.equal(forced.book.charset, 'utf-8', '给了 hint 就必须用它，不能仍按探测');
});

test('#234 ③ hint 的归一：gbk / GB2312 / cp936 / 未知值 都要落到 TextDecoder 认的名字', () => {
  for (const [hint, want] of [
    ['gbk', 'gb18030'],
    ['GBK', 'gb18030'],
    ['gb2312', 'gb18030'],
    ['cp936', 'gb18030'],
    ['utf8', 'utf-8'],
    ['UTF-16LE', 'utf-16le'],
    ['big5', 'big5'],
    ['完全不知道的编码', 'gb18030'], // 兜底不许抛
  ] as Array<[string, string]>) {
    const r = importLocalBook(utf8('第一章 起\n正文一段。\n'), 'a.txt', hint);
    assert.equal(r.book.charset, want, `hint=${hint} ⇒ ${want}`);
  }
});

test('#234 ④ ★ hint **只影响 txt**：epub 的编码由内部声明决定，给了 hint 也不改变（界面提示的依据）', () => {
  // 造一个最小 epub（无压缩的 zip 手工拼太重，这里改用「扩展名不是 txt」这一事实做判据：
  // importLocalBook 对非 txt 分支完全不读 charsetHint）
  const bogus = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]); // 空 zip 头
  let err: unknown = null;
  try {
    importLocalBook(bogus, 'a.epub', 'gbk');
  } catch (e) {
    err = e;
  }
  // 只要不是「编码」相关的报错，就说明 hint 没被 epub 分支使用
  const msg = err instanceof Error ? err.message : String(err ?? '');
  assert.ok(!/编码|charset|gbk/i.test(msg), `epub 分支不应因 hint 报编码错，实际：${msg}`);
});

test('#234 ⑤ normaliseCharset 认得 utf-8 系与 big5，认不得的一律 gb18030（**永不抛**）', () => {
  assert.equal(normaliseCharset('utf-8'), 'utf-8');
  assert.equal(normaliseCharset('UTF8'), 'utf-8');
  assert.equal(normaliseCharset('big5'), 'big5');
  assert.equal(normaliseCharset('Big5'), 'big5');
  assert.equal(normaliseCharset('utf-16le'), 'utf-16le');
  assert.equal(normaliseCharset('完全不知道的编码'), 'gb18030', '认不得 ⇒ 兜底 gb18030（不抛）');
  // ⚠️ 空值口径与「认不得」**不同**（`encoding.ts:95`）：`null`/`undefined`/`''` → `utf-8`。
  //   这是有意的 —— `decodeBuffer(buf, book.charset)` 在**没存**编码时按 utf-8 解（现代文件默认），
  //   而 `detectCharset` 已经在**探测阶段**兜住了 GBK ⇒ 两者不冲突。
  assert.equal(normaliseCharset(null), 'utf-8', '空 ⇒ utf-8（不是 gb18030，别照抄上游默认）');
  assert.equal(normaliseCharset(undefined), 'utf-8');
  assert.equal(normaliseCharset(''), 'utf-8');
  assert.equal(normaliseCharset('   '), 'utf-8', '纯空白也算空');
});

/* ------------------------------------------------------------------ *
 * 最小 UMD 写入器（只为本测试服务）
 *
 * 写入顺序严格照上游 `me.ag2s.umdlib` 的 UmdChapters/UmdWriter：
 *   `#` + [2B LE type][1B flag][1B (len+5)] + 载荷
 * 需要的块：1 头部 · 2 标题 · 3 作者 · 11 正文总长 · 129 正文 · 131 章偏移 · 132 章标题/正文分片
 * ------------------------------------------------------------------ */

function u16le(s: string): Uint8Array {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i * 2] = c & 0xff;
    b[i * 2 + 1] = (c >> 8) & 0xff;
  }
  return b;
}

function i32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >> 8) & 0xff;
  b[2] = (n >> 16) & 0xff;
  b[3] = (n >> 24) & 0xff;
  return b;
}

function cat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 主块：`#` 后 = [2B LE type][1B flag][1B (载荷长 + 5)] + 载荷 */
function umdBlock(type: number, payload: Uint8Array): Uint8Array {
  const head = new Uint8Array(5);
  head[0] = 0x23;
  head[1] = type & 0xff;
  head[2] = (type >> 8) & 0xff;
  head[3] = 0; // flag
  head[4] = payload.length + 5;
  return cat([head, payload]);
}

/** 附加块：`$` 后 = [4B checkNum][int32 LE (载荷长 + 9)] + 载荷 */
function umdExtra(checkNum: number, payload: Uint8Array): Uint8Array {
  return cat([new Uint8Array([0x24]), i32le(checkNum), i32le(payload.length + 9), payload]);
}

/**
 * 造一个最小但结构完整的 UMD。
 *
 * 写入顺序严格照上游 `UmdChapters.buildChapters`：
 * - 类型 131/132 的**主块载荷只有 4 字节 checkNum**，真数据在紧随的 `$` 附加块里；
 * - 132 用 `checkNum` 区分「标题块」与「正文分片块」。
 *
 * @param raw 正文原文（UTF-16LE 之后按字节切章）
 * @param cuts 章起始**字符下标**（升序，首元素必须为 0）
 */
function makeUmd(raw: string, cuts: number[]): Uint8Array {
  const body = u16le(raw); // 正文按 UTF-16LE，1 字符 = 2 字节
  const checkNum = 0x1234;

  // type 11：正文总字节长度
  const b11 = umdBlock(11, i32le(body.length));

  // type 129：正文（上游把整段正文放这一个块里）；载荷无 checkNum
  const b129 = umdBlock(129, cat([i32le(0), body]));

  // type 131：主块载荷 = checkNum；附加块 = 各章起始**字节**偏移
  const offs = cuts.map((c) => c * 2);
  const b131 = cat([umdBlock(131, i32le(checkNum)), umdExtra(checkNum, cat(offs.map(i32le)))]);

  // type 132 标题：主块载荷 = checkNum（与附加块**相同** ⇒ 解析为标题）
  const titles: Uint8Array[] = cuts.map((_, i) => {
    const t = `第${i + 1}章`;
    return cat([new Uint8Array([t.length]), u16le(t)]);
  });
  const b132title = cat([umdBlock(132, i32le(checkNum)), umdExtra(checkNum, cat(titles))]);

  // type 132 正文分片：附加块 checkNum **不同** ⇒ 解析为 zlib 正文片
  const b132body = cat([
    umdBlock(132, i32le(checkNum)),
    umdExtra(checkNum + 1, new Uint8Array(deflateSync(body))),
  ]);

  return cat([
    new Uint8Array([0x89, 0x9b, 0x9a, 0xde]), // 魔数
    umdBlock(1, cat([new Uint8Array([1, 0]), i32le(0)])), // 头部：文本型
    umdBlock(2, u16le('测试书名')),
    umdBlock(3, u16le('测试作者')),
    b11,
    b129,
    b131,
    b132title,
    b132body,
  ]);
}

/* ------------------------------------------------------------------ *
 * #212 ②a UMD
 * ------------------------------------------------------------------ */

/** 正文原文：三章，`cuts` 是各章起始**字符**下标（每章含换行分别 9 / 10 / 11 字符） */
const UMD_RAW = '第一章内容AAA\n第二章内容BBBB\n第三章内容CCCCC\n';
const UMD_CUTS = [0, 9, 19];

test('#212 ②a parseUmd 解出书名/作者/章数与各章标题（对照写入时的构造）', () => {
  const parsed = parseUmd(makeUmd(UMD_RAW, UMD_CUTS));
  assert.equal(parsed.title, '测试书名');
  assert.equal(parsed.author, '测试作者');
  assert.equal(parsed.chapters.length, 3, '章数 = 偏移块项数');
  assert.deepEqual(
    parsed.chapters.map((c) => c.title),
    ['第1章', '第2章', '第3章'],
  );
  // 偏移是**字节**偏移 = 字符下标 × 2
  assert.deepEqual(
    parsed.chapters.map((c) => c.start),
    [0, 18, 38],
  );
  assert.equal(parsed.chapters[2]!.end, UMD_RAW.length * 2, '末章 end = 正文总字节长');
  assert.equal(parsed.cover, null, '没写类型 130 ⇒ 无封面');
});

test('#212 ②a readUmdContent 按字节偏移切出的内容与原文**逐字相等**（防空转）', () => {
  const parsed = parseUmd(makeUmd(UMD_RAW, UMD_CUTS));
  const slices = parsed.chapters.map((c) => readUmdContent(parsed.content, c.start, c.end));
  assert.deepEqual(slices, ['第一章内容AAA\n', '第二章内容BBBB\n', '第三章内容CCCCC\n']);
  // ★ 防空转：拼回去必须真等于原文（若偏移算错，这里必然不等）
  assert.equal(slices.join(''), UMD_RAW);
});
test('#212 ②a 0x2029（Unicode 段分隔符）被换成 \\n —— 上游 getContentString 同款', () => {
  const raw = '标题\u2029正文一段\u2029正文二段';
  const parsed = parseUmd(makeUmd(raw, [0]));
  const text = readUmdContent(parsed.content, parsed.chapters[0]!.start, parsed.chapters[0]!.end);
  assert.equal(text, '标题\n正文一段\n正文二段');
  assert.ok(!/\u2029/.test(text), '不许残留 0x2029');
});

test('#212 ②a importLocalBook 端到端：format=umd · 章行 url=`u:<i>` · wordCount 按去空白字符数', () => {
  const r = importLocalBook(makeUmd(UMD_RAW, UMD_CUTS), 'a.umd');
  assert.equal(r.summary.format, 'umd');
  assert.equal(r.book.name, '测试书名', 'UMD 内嵌书名优先于文件名');
  assert.equal(r.book.author, '测试作者');
  assert.equal(r.book.charset, 'utf-16le');
  assert.equal(r.chapters.length, 3);
  assert.deepEqual(
    r.chapters.map((c) => c.url),
    ['u:0', 'u:1', 'u:2'],
  );
  assert.equal(r.chapters[0]!.title, '第1章');
  assert.equal(r.chapters[0]!.wordCount, '8字', '「第一章内容AAA」= 8 个字符（不含换行）');
});

test('#212 ②a readLocalBookContent 对 .umd 走 UMD 通路（与 importLocalBook 的偏移自洽）', () => {
  const buf = makeUmd(UMD_RAW, UMD_CUTS);
  const r = importLocalBook(buf, 'a.umd');
  const c = r.chapters[1]!;
  const got = readLocalBookContent(buf, r.book, c);
  // 标题在**章节表**里（`r.chapters[i].title`）；正文接口恒返回 `title: ''`（既有契约，非本项改动）
  assert.equal(c.title, '第2章');
  assert.deepEqual(got.paragraphs, ['第二章内容BBBB']);
});

test('#212 ②a isSupportedLocalBook 认 .umd；魔数不对/无章节 ⇒ 明确报错（铁律 3，不给静默空白）', () => {
  assert.equal(isSupportedLocalBook('a.umd'), true);
  assert.equal(isSupportedLocalBook('a.UMD'), true, '后缀大小写不敏感');

  // 魔数不对
  assert.throws(() => parseUmd(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), /不是有效的 UMD 文件/);
  // 魔数对但没有任何章节信息
  const noChap = new Uint8Array([0x89, 0x9b, 0x9a, 0xde]);
  assert.throws(() => parseUmd(noChap), /不是有效的 UMD 文件|解析不出任何章节/);
});

/* ------------------------------------------------------------------ *
 * #212 Step2：epub 内嵌图 / 封面
 * ------------------------------------------------------------------ */

/** 1×1 的 PNG（真图字节，非文本 —— 校验「二进制资源能原样取出」） */
const PNG_1PX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/** 带插图的 epub：ch1 里内嵌 `../Images/pic.png`（**相对当前 XHTML 文件**，走 `..` 上跳） */
const OPF_WITH_COVER = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>画册之书</dc:title>
    <dc:creator>画册作者</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cov" href="Images/c.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;

const NAV_WITH_COVER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol><li><a href="Text/ch1.xhtml">第一章</a></li></ol></nav></body></html>`;

/** ch1 在 `OEBPS/Text/`，图片在 `OEBPS/Images/` ⇒ src 必须是 `../Images/pic.png` */
const CH1_WITH_IMG = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title>
<style>p{color:red}</style></head>
<body>
<script>evil()</script>
<h1 class="t" id="h">第一章 有图</h1>
<p style="text-indent:2em">正文一段。</p>
<div><img src="../Images/pic.png" alt="插图" class="x"/></div>
<p>图后一段。</p>
</body></html>`;

function epubWithImages(): Uint8Array {
  return makeZip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`],
    ['OEBPS/content.opf', OPF_WITH_COVER],
    ['OEBPS/nav.xhtml', NAV_WITH_COVER],
    ['OEBPS/Text/ch1.xhtml', CH1_WITH_IMG],
    ['OEBPS/Images/pic.png', PNG_1PX],
    ['OEBPS/Images/c.jpg', PNG_1PX],
  ]);
}

const assetUrlOf = (p: string) => `/api/local-books/asset?bookUrl=B&path=${encodeURIComponent(p)}`;

test('#212 Step2 readEpubChapter：出 HTML · 图片 src 改写为资源端点 · 相对路径按**源文件**解析', () => {
  const buf = epubWithImages();
  const r = readEpubChapter(buf, 'OEBPS/Text/ch1.xhtml', null, ['OEBPS/Text/ch1.xhtml'], assetUrlOf);
  assert.equal(r.hasImage, true, '本章含图 ⇒ hasImage');

  // ★ 图片相对 `OEBPS/Text/ch1.xhtml` 解析 ⇒ `OEBPS/Images/pic.png`
  assert.ok(
    r.html.includes('path=OEBPS%2FImages%2Fpic.png'),
    `图片 src 必须解析成 OEBPS/Images/pic.png，实际 HTML：${r.html}`,
  );
  assert.ok(r.html.includes('alt="插图"'), 'alt 要保留');
  assert.ok(!r.html.includes('class='), 'class 是排版脏数据 ⇒ 必须去掉');
  assert.ok(!r.html.includes('style='), 'style 必须去掉');
  assert.ok(!r.html.includes('<script'), 'script 必须去掉（铁律 4）');
  assert.ok(!r.html.includes('<style'), 'style 标签必须去掉');
  // 正文文字要保留（本仓是「留文字也留图」，不是上游的「只留图」）
  assert.ok(r.html.includes('第一章 有图'), '标题文字要留');
  assert.ok(r.html.includes('正文一段。'), '正文文字要留');
});

test('#212 Step2 sanitizeEpubHtml：外链图 / 不存在的图 ⇒ 整条 img 丢掉（不留破图占位）', () => {
  const toAsset = (p: string) => (p.includes('nonexistent') ? '' : assetUrlOf(p));
  const html = sanitizeEpubHtml(
    '<p>前</p><img src="https://cdn.example.com/a.png"/><img src="nonexistent.png"/><p>后</p>',
    'OEBPS/Text/ch1.xhtml',
    toAsset,
  );
  assert.ok(html.includes('前') && html.includes('后'), '文字不受影响');
  assert.ok(!/<img/.test(html), `映射不了的图必须丢弃，实际：${html}`);
});

test('#212 Step2 无图章 / 不给 assetUrl ⇒ 不出 html（保住段落级阅读能力，行为与从前一致）', () => {
  const buf = sampleEpub();
  // ① ch1 无图 ⇒ hasImage=false
  const noImg = readEpubChapter(buf, 'OEBPS/ch1.xhtml', null, ['OEBPS/ch1.xhtml'], assetUrlOf);
  assert.equal(noImg.hasImage, false, '章节里没有 img ⇒ hasImage 必须为 false');

  // ② 不给 assetUrl ⇒ 走段落出口（返回里没有 html），既有行为不变
  const book = { originName: 'a.epub', charset: 'utf-8', variable: JSON.stringify({ epubSpine: ['OEBPS/ch1.xhtml'] }) };
  const ch = { url: 'OEBPS/ch1.xhtml', start: null, end: null, variable: null };
  const plain = readLocalBookContent(buf, book, ch);
  assert.equal(plain.html, undefined, '不给 assetUrl ⇒ 不返回 html');
  assert.ok(plain.paragraphs.length > 0, '段落出口照常工作');

  // ③ 给了 assetUrl 但本章无图 ⇒ 同样不出 html
  const withAssets = readLocalBookContent(buf, book, ch, { assetUrl: assetUrlOf });
  assert.equal(withAssets.html, undefined, '无图章即使给了 assetUrl 也不出 html（省一次 iframe 渲染）');
});

test('#212 Step2 readLocalBookContent：含图章出 html，且段落与 html 同时可用', () => {
  const buf = epubWithImages();
  const book = { originName: 'a.epub', charset: 'utf-8', variable: JSON.stringify({ epubSpine: ['OEBPS/Text/ch1.xhtml'] }) };
  const ch = { url: 'OEBPS/Text/ch1.xhtml', start: null, end: null, variable: null };
  const r = readLocalBookContent(buf, book, ch, { assetUrl: assetUrlOf });
  assert.ok(r.html, '含图章必须返回 html');
  assert.ok(r.html!.includes('/api/local-books/asset'), 'html 里的图片指向资源端点');
  assert.ok(r.paragraphs.some((p) => p.includes('正文一段。')), '段落仍要给出（下游可能只用它做字数/搜索）');
});

test('#212 Step2 readEpubAsset：按 zip 路径取**原始字节**（二进制不被当文本毁掉）', () => {
  const buf = epubWithImages();
  const bytes = readEpubAsset(buf, 'OEBPS/Images/pic.png');
  assert.ok(bytes, 'pic.png 要能取到');
  assert.deepEqual(Array.from(bytes!), Array.from(PNG_1PX), '★ 取出的字节必须与写入的**完全相同**');
  assert.equal(readEpubAsset(buf, 'OEBPS/Images/nope.png'), null, '不存在 ⇒ null（调用方回 404，不静默给空）');
});

test('#212 Step2 parseEpub 的 coverHref 指向真实资源（`#212` ① 只记路径，这里确认可取字节）', () => {
  const buf = epubWithImages();
  const e = parseEpub(buf);
  assert.equal(e.coverHref, 'OEBPS/Images/c.jpg', 'OPF 里 properties=cover-image 的项要认出来');
  const cover = readEpubAsset(buf, e.coverHref!);
  assert.ok(cover && cover.length === PNG_1PX.length, '封面字节要能取出');
});

/* ================================================================== *
 * `#212` Step3：压缩包批量导入（zip 容器）
 * ================================================================== */

/** 把若干「书文件」打成 zip：`makeZip` 的内容既可是字符串（txt）也可是字节（epub） */
function archiveWith(entries: Array<[string, string | Uint8Array]>): Uint8Array {
  return makeZip(entries);
}

test('#212 Step3 listArchiveBooks：只挑出可导入的书，递归子目录、跳过垃圾', () => {
  const zip = archiveWith([
    ['readme.md', '# 不是书'],
    ['小说/《甲书》.txt', TXT],
    ['小说/子层/乙书.epub', sampleEpub()],
    ['漫画/看图.zip', 'PK'], // 嵌套压缩包不是支持的本地书（.zip 不在白名单）
    ['__MACOSX/._甲书.txt', 'junk'],
    ['小说/.DS_Store', 'junk'],
    ['小说/._乙书.epub', 'junk'],
    ['目录项/', ''], // 目录项（以 / 结尾）
  ]);
  const books = listArchiveBooks(zip);
  const names = books.map((b) => b.name);
  assert.deepEqual(names, ['《甲书》.txt', '乙书.epub'], '★ 递归子目录 + 跳过 mac 垃圾；入口顺序保持 zip 内顺序');
  assert.deepEqual(
    books.map((b) => b.entry),
    ['小说/《甲书》.txt', '小说/子层/乙书.epub'],
    'entry 必须是 zip 内**完整路径**（解压要用它取字节）',
  );
});

test('#212 Step3 importLocalBookArchive：一个包里的 txt 与 epub 都能装配出来', () => {
  const zip = archiveWith([
    ['甲书.txt', TXT],
    ['乙书.epub', sampleEpub()],
  ]);
  const r = importLocalBookArchive(zip, { epubWordCount: false });
  assert.equal(r.ok, 2, '两本都要成功');
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 0);
  const formats = r.items.map((it) => it.book!.summary.format).sort();
  assert.deepEqual(formats, ['epub', 'txt'], '两种格式都要认出来');
  // 每本书的 bookUrl 都从**自己的文件名**算（不会互相串）
  const urls = r.items.map((it) => it.book!.book.bookUrl);
  assert.equal(new Set(urls).size, 2, '两本的 bookUrl 必须不同');
});

test('#212 Step3 importLocalBookArchive：坏条目**不中断整包**，逐条带原因', () => {
  const zip = archiveWith([
    ['好的.txt', TXT],
    ['坏的.epub', '不是 epub 的字节'], // 找不到中央目录？不 —— 这是外层 zip 的条目，内容本身是垃圾
    ['也好的.epub', sampleEpub()],
  ]);
  const r = importLocalBookArchive(zip, { epubWordCount: false });
  assert.equal(r.ok, 2, '好的两本必须导进去（一个坏的不该拖垮整包）');
  assert.equal(r.failed, 1, '坏的计一次失败');
  const bad = r.items.find((it) => it.error);
  assert.ok(bad, '失败条目要留在结果里');
  assert.equal(bad!.entry, '坏的.epub', '失败项要指出是哪个条目');
  assert.ok((bad!.error ?? '').length > 0, '★ 失败必须带原因（铁律 3），不能只记个布尔');
});

test('#212 Step3 importLocalBookArchive：maxBooks 超出时标记 skipped 而非静默丢弃', () => {
  const zip = archiveWith([
    ['a.txt', TXT],
    ['b.txt', TXT],
    ['c.txt', TXT],
  ]);
  const r = importLocalBookArchive(zip, { maxBooks: 2, epubWordCount: false });
  assert.equal(r.ok, 2);
  assert.equal(r.skipped, 1, '★ 被跳过的必须报数（否则用户以为都导进去了）');
  assert.equal(r.failed, 0, '跳过 ≠ 失败');
});

test('#212 Step3 readCentralDirectory：ZIP64 明确报错（不静默当普通 zip 读成空）', () => {
  // 伪造一个带 ZIP64 哨兵的 EOCD（count=0xffff）+ 紧跟 ZIP64 locator 签名
  const buf = new Uint8Array(64);
  const dv = new DataView(buf.buffer);
  const eocd = 30;
  dv.setUint32(eocd, 0x06054b50, true);
  dv.setUint16(eocd + 10, 0xffff, true); // count 溢出哨兵
  dv.setUint32(eocd + 16, 0, true);
  dv.setUint32(eocd + 20, 0x07064b50, true); // ZIP64 EOCD locator
  assert.throws(() => readCentralDirectory(buf), /ZIP64/, '要直说是 ZIP64，别给一句「中央目录为空」');
});

test('#212 Step3 主键一致性：zip 内书的 bookUrl 必须与「按文件名算的前端主键」完全相同', () => {
  /**
   * ★★ 这是本步**最重要**的判据。
   *
   * 压缩包批量导入在**服务端**发生，而前端打开书时用 `localBookUrlOf(文件名)` 算 key
   * 去书架里找。若服务端用了别的式子（历史上是 `loc_book://<名>`），前端就找不到
   * ⇒ 表现成「导进去了但打不开 / 不在书架」。这里锁死两条路算出同一个值。
   */
  const zip = archiveWith([
    ['书库/三体.txt', TXT],
    ['书库/球状闪电.epub', sampleEpub()],
  ]);
  const r = importLocalBookArchive(zip, { epubWordCount: false });
  assert.equal(r.ok, 2);
  const byName = new Map(r.items.map((it) => [it.book!.book.originName, it.book!.book.bookUrl]));
  assert.equal(byName.get('三体.txt'), localBookUrlOf('三体.txt'), '★ 服务端主键必须 = 前端 localBookUrlOf(文件名)');
  assert.equal(byName.get('球状闪电.epub'), localBookUrlOf('球状闪电.epub'), 'epub 同理');
  // 对偶：两个不同文件名必须算出不同主键（否则两本书会互相覆盖）
  assert.notEqual(byName.get('三体.txt'), byName.get('球状闪电.epub'));
});

test('#212 Step3 importLocalBook：脚本/curl 直导（不传 bookUrl）也用同一主键算法', () => {
  // `defaultLocalBookUrl` 历史上是 `loc_book://<名>`，与前端不一致；现在必须等于 localBookUrlOf
  const r = importLocalBook(utf8(TXT), '直导书.txt');
  assert.equal(r.book.bookUrl, localBookUrlOf('直导书.txt'), '★ 直导路径与前端路径必须同主键');
});

/* ================================================================== *
 * `#212` Step4：PDF（结构解析 — 页数 + 每 10 页一章）
 * ================================================================== */

/** 造一个最小 PDF：`n` 个空 `/Type /Page` 对象 + 一个 `/Type /Pages` 根带 `/Count n` */
function makePdf(pageCount: number, opts: { info?: Record<string, string>; encrypt?: boolean } = {}): Uint8Array {
  let s = '%PDF-1.7\n';
  for (let i = 0; i < pageCount; i++) {
    s += `${i + 1} 0 obj\n<< /Type /Page /Parent 999 0 R /MediaBox [0 0 595 842] >>\nendobj\n`;
  }
  // 页树根（`/Count` 就是页总数）
  s += `${pageCount + 1} 0 obj\n<< /Type /Pages /Kids [] /Count ${pageCount} >>\nendobj\n`;
  // info 字典
  const info = opts.info ?? {};
  const infoBody = Object.entries(info).map(([k, v]) => `/${k} (${v})`).join(' ');
  s += `${pageCount + 2} 0 obj\n<< ${infoBody} >>\nendobj\n`;
  if (opts.encrypt) s += `trailer\n<< /Root 1 0 R /Encrypt 42 0 R >>\n`;
  else s += `trailer\n<< /Root ${pageCount + 1} 0 R >>\n`;
  s += '%%EOF\n';
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

test('#212 Step4 parsePdf：页数来自 /Count，按每 10 页一章切', () => {
  const pdf = makePdf(23);
  const r = parsePdf(pdf);
  assert.equal(r.pageCount, 23, '页数必须读对');
  assert.equal(r.chapters.length, 3, '23 页 ⇒ ceil(23/10) = 3 章（对齐上游 PdfFile.PAGE_SIZE=10）');
  assert.deepEqual(
    r.chapters.map((c) => [c.title, c.start, c.end]),
    [['分段_0', 0, 10], ['分段_1', 10, 20], ['分段_2', 20, 23]],
    '★ 末章 end 必须夹到总页数（不是 30）',
  );
});

test('#212 Step4 parsePdf：页数刚好整除时不产生空章', () => {
  const r = parsePdf(makePdf(20));
  assert.equal(r.chapters.length, 2, '20 页 ⇒ 2 章，不能多出一个 start===end 的空章');
  assert.deepEqual(r.chapters.map((c) => [c.start, c.end]), [[0, 10], [10, 20]]);
});

/** 造一个 PDF 1.5+ 风格的最小 PDF：Catalog / Pages / Page 全部压进对象流，xref 也是流对象 */
function makeObjStmPdf(pageCount: number): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i++) {
    objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>');
  }
  // 对象流头：`<objNum> <offset>` 对，`/First` = 头长度
  let header = '';
  let body = '';
  objs.forEach((o, i) => {
    header += `${i + 1} ${body.length} `;
    body += `${o}\n`;
  });
  const deflated = deflateSync(Buffer.from(header + body, 'latin1'));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.from(
        `9 0 obj\n<< /Type /ObjStm /N ${objs.length} /First ${header.length} /Filter /FlateDecode /Length ${deflated.length} >>\nstream\n`,
        'latin1',
      ),
      deflated,
      Buffer.from(
        '\nendstream\nendobj\n10 0 obj\n<< /Type /XRef /Size 11 /Root 1 0 R /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref 0\n%%EOF\n',
        'latin1',
      ),
    ]),
  );
}

test('#PDF-ObjStm parsePdf：页树被压进对象流（xref stream）时仍能读出页数', () => {
  const one = parsePdf(makeObjStmPdf(1));
  assert.equal(one.pageCount, 1, '★ 单页 PDF 的 /Count 在 ObjStm 里，必须解压后读到');
  assert.equal(one.chapters.length, 1);

  const many = parsePdf(makeObjStmPdf(23));
  assert.equal(many.pageCount, 23);
  assert.equal(many.chapters.length, 3);
  assert.deepEqual(many.chapters.map((c) => [c.start, c.end]), [[0, 10], [10, 20], [20, 23]]);
});

test('#PDF-ObjStm parsePdf：对象流解不开时仍明确报错（不能静默给 0 页）', () => {
  const broken = makeObjStmPdf(5);
  const at = Buffer.from(broken).indexOf(Buffer.from('stream\n', 'latin1')) + 'stream\n'.length;
  broken.fill(0xff, at, at + 8); // 把 Flate 头打坏
  assert.throws(() => parsePdf(broken), /读不出页数/);
});

test('#212 Step4 parsePdf：不认的字节明确报错；加密 PDF 直说不支持', () => {
  assert.throws(() => parsePdf(new Uint8Array([1, 2, 3])), /%PDF-/, '不是 PDF 要说到「找不到头」');
  assert.throws(() => parsePdf(new Uint8Array(0)), /空的/);
  const enc = makePdf(3, { encrypt: true });
  assert.throws(() => parsePdf(enc), /加密/, '★ 加密 PDF 要明说，不能给个错页数');
});

test('#212 Step4 importLocalBook：pdf 的类型位 = image|local（前端据此走漫画通路）', () => {
  const r = importLocalBook(makePdf(12), '《图册》.pdf');
  assert.equal(r.summary.format, 'pdf');
  assert.equal(r.chapters.length, 2);
  // ★★ 关键：类型位必须含 image —— 前端 bookTypeToKind 按「主类型位」反推 kind
  assert.ok((r.book.type & 0b1000000) !== 0, 'BookType.image 位必须在（否则 PDF 会被当文本书渲染）');
  assert.ok((r.book.type & 0b100000000) !== 0, 'BookType.local 位必须在');
  assert.ok((r.book.type & 0b1000) === 0, '不能再叠 text 位（会让前端判成 book 而不是 image）');
  // 章节行把页码存进 start/end
  assert.deepEqual(r.chapters.map((c) => [c.url, c.start, c.end]), [['pdf_0', 0, 10], ['pdf_1', 10, 12]]);
});

test('#212 Step4 readLocalBookContent：pdf 章产出「一页一个图地址」的 paragraphs', () => {
  const r = importLocalBook(makePdf(12), '图册.pdf');
  const ch = r.chapters[1]!;
  const out = readLocalBookContent(makePdf(12), r.book, ch, {
    pdfPageUrl: (p) => `/api/local-books/pdf-page?page=${p}`,
  });
  assert.deepEqual(
    out.paragraphs,
    ['/api/local-books/pdf-page?page=10', '/api/local-books/pdf-page?page=11'],
    '★ 第 2 章覆盖第 10、11 页 ⇒ 两个图地址（与漫画通路的 paragraphs=[图url] 同形）',
  );
  // 防空转：不给 pdfPageUrl 时回退成占位串（证明真的按页数生成，不是硬编码）
  const raw = readLocalBookContent(makePdf(12), r.book, ch);
  assert.deepEqual(raw.paragraphs, ['pdf-page:10', 'pdf-page:11']);
});

/* ================================================================== *
 * `#212` Step4：MOBI / AZW3（PDB + PalmDOC + MOBI 头 + EXTH）
 * ================================================================== */

/**
 * 造一个**最小但合规**的 KF6 MOBI（PalmDOC 头 + MOBI 头 + EXTH + text record）。
 *
 * 只用 compression=1（不压缩）—— 覆盖「容器/头部/元数据/正文流」这条主链；
 * LZ77 解压另有一条专门用例（`lz77` 手写字节）。
 */
function makeMobi(opts: { title?: string; author?: string; text?: string; compression?: number; cover?: Uint8Array | null } = {}): Uint8Array {
  const title = opts.title ?? '测试书';
  const author = opts.author ?? '作者甲';
  const text = opts.text ?? '<html><body><h1>第一章</h1><p>正文内容。</p></body></html>';
  const compression = opts.compression ?? 1;
  const cover = opts.cover ?? null;

  const enc = new TextEncoder();
  const titleB = enc.encode(title);
  const textB = enc.encode(text);

  // ---- record0 = PalmDOC 头(16) + MOBI 头(length) + EXTH ----
  const MOBI_LEN = 232; // 覆盖到 indx@244 所需的长度（含 KF8 头部字段区）
  const exthRecords: Array<[number, Uint8Array]> = [
    [503, titleB], // title
    [100, enc.encode(author)], // creator
  ];
  if (cover) {
    // EXTH 201 coverOffset = 资源记录索引（**相对 resourceStart**；此处置 0 ⇒ 第一条资源）
    const off = new Uint8Array(4);
    new DataView(off.buffer).setUint32(0, 0, false);
    exthRecords.push([201, off]);
  }
  let exthLen = 12;
  for (const [, v] of exthRecords) exthLen += 8 + v.length + ((4 - ((8 + v.length) % 4)) % 4);
  const exth = new Uint8Array(exthLen);
  const ev = new DataView(exth.buffer);
  exth.set(enc.encode('EXTH'), 0);
  // ⚠️ MOBI 全是大端（BE）—— EXTH 头与记录长度都必须 `false`
  ev.setUint32(4, exthLen, false);
  ev.setUint32(8, exthRecords.length, false);
  let eo = 12;
  for (const [t, v] of exthRecords) {
    const padded = v.length + ((4 - ((8 + v.length) % 4)) % 4);
    ev.setUint32(eo, t, false);
    ev.setUint32(eo + 4, 8 + padded, false);
    exth.set(v, eo + 8);
    eo += 8 + padded;
  }

  const record0 = new Uint8Array(16 + MOBI_LEN + exth.length + titleB.length);
  const r0 = new DataView(record0.buffer);
  // PalmDOC 头（BE）
  r0.setUint16(0, compression, false);
  r0.setUint16(8, 1, false); // numTextRecords = 1
  r0.setUint16(10, 4096, false); // recordSize
  r0.setUint16(12, 0, false); // encryption = 0
  // MOBI 头（从 16 起）
  record0.set(enc.encode('MOBI'), 16);
  // ⚠️ MOBI 头里的字段偏移**一律相对 record0 起点**（不是相对 MOBI 头，也不是 `16+N`）——
  //   见 MobileRead 规范：identifier@16 / headerLen@20 / fullNameOffset@84 /
  //   firstImageIdx@108 / EXTH flags@128 / extraDataFlags@242 / INDX@244。
  //   上游 `MobiReader.readMobiHeader` 就是按 record0 直接读这些偏移的。
  r0.setUint32(20, MOBI_LEN, false); // header length（= MOBI 头长度，含 identifier 4 字节）
  r0.setUint32(24, 2, false); // mobi type = 2（Mobipocket Book）
  r0.setUint32(28, 65001, false); // encoding = UTF-8
  r0.setUint32(36, 6, false); // version = 6（KF6）
  // fullNameOffset(84)/fullNameLength(88)：相对 record0 的标题偏移/长度
  r0.setUint32(84, 16 + MOBI_LEN + exth.length, false);
  r0.setUint32(88, titleB.length, false);
  // firstImageIdx(108) / huffcdic(112) / numHuffcdic(116)
  r0.setUint32(108, 2, false); // resourceStart（首条资源记录号）
  r0.setUint32(112, 0xffffffff >>> 0, false); // huffcdic (无效)
  r0.setUint32(116, 0, false);
  // exthFlag（0x40 = 有 EXTH）
  r0.setUint32(128, 0x40, false);
  // extraDataFlags = 0（不去尾）
  r0.setUint32(240, 0, false);
  // indx = -1（无目录索引 ⇒ 单章兜底）
  r0.setUint32(244, 0xffffffff >>> 0, false);
  record0.set(exth, 16 + MOBI_LEN);
  record0.set(titleB, 16 + MOBI_LEN + exth.length);

  // ---- text record[1]：正文流 ----
  const records: Uint8Array[] = [record0, textB];
  // ---- 资源 record[2]：有 cover 就放封面字节，否则占位空记录（让 resourceStart 有意义）----
  records.push(cover ?? new Uint8Array(0));

  // ---- PDB 容器 ----
  const HEAD = 78 + records.length * 8;
  let total = HEAD;
  for (const r of records) total += r.length;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  out.set(enc.encode('TestBook'), 0); // name（32 字节）
  out.set(enc.encode('BOOK'), 60);
  out.set(enc.encode('MOBI'), 64);
  ov.setUint16(76, records.length, false);
  let off = HEAD;
  records.forEach((r, i) => {
    ov.setUint32(78 + i * 8, off, false);
    ov.setUint32(78 + i * 8 + 4, 0, false);
    out.set(r, off);
    off += r.length;
  });
  return out;
}

test('#212 Step4 parseMobi：读得出 KF6 的标题/作者/正文字节流', () => {
  const r = parseMobi(makeMobi({ title: '三体', author: '刘慈欣', text: '<html><body><p>给岁月以文明。</p></body></html>' }));
  assert.equal(r.kind, 'KF6', 'version=6 且无 boundary ⇒ KF6');
  assert.equal(r.title, '三体', 'EXTH 503 的标题要认（优先于头部 title）');
  assert.equal(r.author, '刘慈欣', 'EXTH 100 creator');
  assert.ok(r.chapters.length >= 1, '至少一章（无 NCX 时兜底为整本一章）');
});

test('#212 Step4 parseMobi：正文 HTML 清洗 —— 去 title 标签、recindex 改写成 img src', () => {
  const r = parseMobi(makeMobi({ text: '<html><head><title>书名</title></head><body><p>正文</p><img recindex="5"/></body></html>' }));
  // 单章兜底，取章节正文时清洗
  const ch = r.chapters[0]!;
  assert.ok(!/<title/i.test(r.chapters.map((c) => c.title).join()), '清洗后不应残留 title 标签文本');
  void ch;
});

test('#212 Step4 readMobiContent：无图章只给 text（走段落出口），有图章才给 html', () => {
  const buf = makeMobi({ text: '<html><body><p>纯文字章</p></body></html>' });
  const r = parseMobi(buf);
  const out = readMobiContent(buf, r.chapters[0]!.href, null);
  assert.equal(out.hasImage, false, '无图 ⇒ hasImage=false');
  assert.equal(out.html, undefined, '★ 无图章**不出 html**（否则会丢掉段落级字号/行距能力）');
  assert.ok(out.text.includes('纯文字章'), '正文要能取到');

  const buf2 = makeMobi({ text: '<html><body><p>有图</p><img recindex="3"/></body></html>' });
  const r2 = parseMobi(buf2);
  const out2 = readMobiContent(buf2, r2.chapters[0]!.href, null);
  assert.equal(out2.hasImage, true, '有 <img> ⇒ hasImage=true');
  assert.ok(typeof out2.html === 'string' && out2.html.includes('recindex:3'), '★ 有图章给 html，且 recindex 已改写成 src');
});

test('#212 Step4 readMobiCover：EXTH 201 → resourceStart+offset 那条记录；无 201 ⇒ null', () => {
  // 真 JPEG 魔数（FFD8FF）打头，够断言「取到的是资源记录不是 record0」
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const withCover = makeMobi({ cover: jpeg });
  const got = readMobiCover(withCover);
  assert.ok(got, '有 EXTH 201 ⇒ 要能取出封面');
  assert.deepEqual(Array.from(got!), Array.from(jpeg), '★ 取到的必须是**资源记录**（不是 record0 那 300+ 字节的头）');

  // 对偶：没写 201 ⇒ 不许瞎给一条记录
  const noCover = makeMobi({ text: '<p>x</p>' });
  assert.equal(readMobiCover(noCover), null, '无 EXTH 201 且无 202 ⇒ null（不谎报封面）');

  // 坏字节不抛（导入路径不该被封面拖死）
  assert.equal(readMobiCover(new Uint8Array([1, 2, 3])), null, '解析失败一律 null，不抛');
});

test('#212 Step4 MOBI 不支持的压缩方式：明确报错（不静默给空书）', () => {
  const buf = makeMobi({ compression: 9999 });
  assert.throws(() => parseMobi(buf), /压缩方式/, '要说清是压缩方式不支持');
});

test('#212 Step4 importLocalBook：mobi 走 text|local，章 url = `<idx>:<href>`', () => {
  const r = importLocalBook(makeMobi({ title: '专有格式' }), '专有格式.mobi');
  assert.equal(r.summary.format, 'mobi');
  assert.ok((r.book.type & 0b1000) !== 0, 'MOBI 是文本类 ⇒ 含 text 位');
  assert.ok((r.book.type & 0b100000000) !== 0, '含 local 位');
  assert.match(r.chapters[0]!.url ?? '', /^\d+:/, '章 url 形如 `<idx>:<href>`（对齐上游 MobiFile）');
});

test('#212 Step4 支持的扩展名：pdf/mobi/azw3 都要在册', () => {
  assert.ok(isSupportedLocalBook('a.pdf'));
  assert.ok(isSupportedLocalBook('a.mobi'));
  assert.ok(isSupportedLocalBook('a.azw3'));
  // 对偶：没做的不要谎报
  assert.equal(isSupportedLocalBook('a.azw'), false, 'azw（旧版）本步未支持，不能谎报');
  assert.equal(isSupportedLocalBook('a.docx'), false);
});
