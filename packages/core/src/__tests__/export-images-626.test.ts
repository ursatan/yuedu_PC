/**
 * `#626` 导出 epub 的正文图片转存
 *
 * 验收口径（都要能独立复核）：
 *  1. 图片确实**进了 zip**（`OEBPS/Images/…`）、章节正文改成 `../Images/…`、manifest 有 `media-type`；
 *  2. **段评图不下载**（净化的判据与转存的判据同源）—— 收集阶段就应该没有它；
 *  3. 拿不到字节的图**保持原 URL**（不阻断导出、不产生坏路径）；
 *  4. 封面进 `cover.xhtml` 且是 spine 第一项 + `<meta name="cover">`（EPUB2 兼容）；
 *  5. 没有图片时**结构与 `#620` 完全一致**（不引入空目录/空 manifest 项）。
 *
 * 与 `#620` 同一手法：epub 用仓内**只读** zip 解析器反向解包（自己写自己读 = 自证）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCentralDirectory, readEntryBy } from '../local-book/zip';
import {
  buildEpub,
  collectExportImages,
  imageFileNameOf,
  imageSuffixOf,
  rewriteImgSrc,
  sniffImageType,
  type ExportChapterLike,
} from '../export';

const dec = new TextDecoder();
const enc = new TextEncoder();

/** 最小合法魔数（只要能嗅出类型；zip 里不校验图片本体） */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);
const RIFF_WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

function unzip(bytes: Uint8Array): { names: string[]; read: (n: string) => Uint8Array; text: (n: string) => string } {
  const ar = readCentralDirectory(bytes);
  return {
    names: ar.entries.map((e) => e.name),
    read: (n: string) => {
      const e = ar.entries.find((x) => x.name === n);
      assert.ok(e, `zip 里没有 ${n}；实际有 ${ar.entries.map((x) => x.name).join(', ')}`);
      return readEntryBy(bytes, e);
    },
    text: (n: string) => dec.decode(readEntryBy(bytes, ar.entries.find((x) => x.name === n)!)),
  };
}

const chapters: ExportChapterLike[] = [
  { title: '第一章', paragraphs: ['正文一', '<img src="https://img.example/a.jpg">'] },
  { title: '第二章', paragraphs: ['<img src="https://img.example/b.png">', '正文二'] },
];

test('#626 imageSuffixOf：剥 `,{…}` 尾巴 + 非法后缀回落 jpg（上游 UrlUtil.getSuffix）', () => {
  assert.equal(imageSuffixOf('https://a/b/c.PNG'), 'png');
  assert.equal(imageSuffixOf('https://a/b/c.jpg?x=1#frag'), 'jpg');
  assert.equal(imageSuffixOf('https://a/b/c,{"headers":{"Referer":"x"}}'), 'jpg', '无后缀 ⇒ 默认 jpg');
  assert.equal(imageSuffixOf('https://a/b/c.webp,{"headers":{"Referer":"x"}}'), 'webp', '先剥尾巴再取后缀');
  assert.equal(imageSuffixOf('https://a/b/toolongext'), 'jpg');
  assert.equal(imageSuffixOf('https://a/b/x.jpeg?'), 'jpeg');
});

test('#626 sniffImageType：按魔数判类型（URL 后缀不可信）', () => {
  assert.deepEqual(sniffImageType(PNG), { mediaType: 'image/png', ext: 'png' });
  assert.deepEqual(sniffImageType(JPEG), { mediaType: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(sniffImageType(GIF), { mediaType: 'image/gif', ext: 'gif' });
  assert.deepEqual(sniffImageType(RIFF_WEBP), { mediaType: 'image/webp', ext: 'webp' });
  assert.deepEqual(sniffImageType(enc.encode('\uFEFF<?xml version="1.0"?><svg width="1"></svg>')), {
    mediaType: 'image/svg+xml',
    ext: 'svg',
  });
  assert.equal(sniffImageType(enc.encode('<html>不是图</html>')), undefined);
  assert.equal(sniffImageType(new Uint8Array(0)), undefined);
  // ★ 真实场景：URL 说 png、字节是 jpeg ⇒ 以字节为准（否则阅读器不显示）
  assert.equal(sniffImageType(JPEG)!.ext, 'jpg');
});

test('#626 imageFileNameOf：16 位 hex + 嗅到的扩展名，同 src 稳定同值', () => {
  const a = imageFileNameOf('https://img.example/a.jpg', sniffImageType(PNG));
  assert.match(a, /^Images\/[0-9a-f]{16}\.png$/);
  assert.equal(a, imageFileNameOf('https://img.example/a.jpg', sniffImageType(PNG)), '同输入必须同输出');
  assert.notEqual(a, imageFileNameOf('https://img.example/b.jpg', sniffImageType(PNG)));
  // 嗅不出类型 ⇒ 退回 URL 后缀
  assert.match(imageFileNameOf('https://img.example/x.webp', undefined), /\.webp$/);
});

test('#626 collectExportImages：去重保序、段评图不收（与渲染同一条判据）', () => {
  const ps = [
    '纯文字',
    '<img src="https://img.example/a.jpg">',
    '<img src="https://img.example/a.jpg">', // 重复
    '<img src="https://img.example/cut.jpg,{&quot;click&quot;:&quot;getDP(1,2)&quot;}">', // 段评图
    '<img src="https://img.example/b.png">',
  ];
  assert.deepEqual(collectExportImages(ps), ['https://img.example/a.jpg', 'https://img.example/b.png']);
  assert.deepEqual(collectExportImages(['没有图']), []);
});

test('#626 rewriteImgSrc：命中的改成 ../Images/…，未命中的原样留着', () => {
  const html = '<img class="x" src="https://a/1.jpg" width="100"><img src="https://a/none.jpg">';
  const out = rewriteImgSrc(html, new Map([['https://a/1.jpg', 'Images/0123456789abcdef.jpg']]));
  assert.ok(out.includes('src="../Images/0123456789abcdef.jpg"'), out);
  assert.ok(out.includes('class="x"') && out.includes('width="100"'), '其它属性必须保住');
  assert.ok(out.includes('src="https://a/none.jpg"'), '没取到字节的图保持原地址');
});

test('#626 buildEpub：图片进 zip、章节改相对路径、manifest 有 media-type、mimetype 仍第一且 STORED', async () => {
  const epub = await buildEpub(
    {
      name: '图文混排',
      author: '某人',
      chapters,
      images: [
        { src: 'https://img.example/a.jpg', data: PNG }, // URL 说 jpg、实际 png
        { src: 'https://img.example/b.png', data: PNG },
      ],
    },
    { deflate: null } as never,
  );
  const z = unzip(epub);
  const imgs = z.names.filter((n) => n.startsWith('OEBPS/Images/'));
  assert.equal(imgs.length, 2, `应有 2 张图，实际 ${imgs.join(',')}`);
  assert.ok(imgs.every((n) => /^OEBPS\/Images\/[0-9a-f]{16}\.png$/.test(n)), '扩展名以字节为准（png）');
  // mimetype 第一且 STORED 的硬要求不能被图片破坏
  const ar = readCentralDirectory(epub);
  assert.equal(ar.entries[0]!.name, 'mimetype');
  assert.equal(ar.entries[0]!.method, 0);
  // 章节引用了相对路径
  const ch1 = z.text('OEBPS/text/chapter-0001.xhtml');
  assert.match(ch1, /src="\.\.\/Images\/[0-9a-f]{16}\.png"/, ch1);
  assert.ok(!ch1.includes('https://img.example/a.jpg'), '已转存的图不应再指远程地址');
  // manifest 里要有 image 项且 media-type 正确
  const opf = z.text('OEBPS/content.opf');
  assert.match(opf, /media-type="image\/png"/);
  assert.equal((opf.match(/media-type="image\/png"/g) ?? []).length, 2);
});

test('#626 buildEpub：封面 ⇒ cover.xhtml + spine 第一项 + <meta name="cover">', async () => {
  const epub = await buildEpub(
    { name: '带封面', chapters, cover: { src: 'https://img.example/cover', data: JPEG } },
    { deflate: null } as never,
  );
  const z = unzip(epub);
  assert.ok(z.names.includes('OEBPS/Images/cover.jpg'), '(URL 无后缀也能定名：嗅到 jpeg)');
  assert.ok(z.names.includes('OEBPS/text/cover.xhtml'));
  const opf = z.text('OEBPS/content.opf');
  assert.match(opf, /id="cover-img"[^>]*properties="cover-image"/);
  assert.match(opf, /<meta name="cover" content="cover-img"\/>/);
  // spine 第一项必须是封面页
  const spine = opf.slice(opf.indexOf('<spine'));
  assert.match(spine, /<itemref idref="cover"\/>/, spine);
  assert.ok(spine.indexOf('idref="cover"') < spine.indexOf('idref="ch0001"'), '封面必须排在正文前');
  assert.match(z.text('OEBPS/text/cover.xhtml'), /<img src="\.\.\/Images\/cover\.jpg"/);
});

test('#626 buildEpub：没有图/封面时结构不额外长东西（与 #620 一致）', async () => {
  const epub = await buildEpub(
    { name: '纯文字', chapters: [{ title: '第一章', paragraphs: ['只有字'] }] },
    { deflate: null } as never,
  );
  const z = unzip(epub);
  assert.equal(z.names.filter((n) => n.startsWith('OEBPS/Images/')).length, 0);
  assert.ok(!z.names.includes('OEBPS/text/cover.xhtml'));
  assert.ok(!z.text('OEBPS/content.opf').includes('cover-image'));
});
