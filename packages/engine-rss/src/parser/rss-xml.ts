/**
 * RssParserDefault 移植（上游 `model/rss/RssParserDefault.kt`，逐条对齐行为）
 *
 * 上游行为要点（2026-10-06 精读源码）：
 *  - 只认 RSS 2.0 的 `<item>`（**Atom `<entry>` 不处理**——上游就没有）；标签名大小写不敏感。
 *  - 字段：title / link / media:thumbnail@url / enclosure(type 含 image/)@url /
 *    description（trim 存储 + 无图时从描述抠首图）/ content:encoded（同上）/
 *    pubDate（只取元素**直接** TEXT——子标签嵌套时跳过，让 `<time>` 规则兜）/ time（等价 pubDate）。
 *  - 图片优先级：media:thumbnail > enclosure(image/*) > description 首图 > content:encoded 首图。
 *  - 返回 Pair(articles, null)——第二位是分页 url 占位（default 路径恒 null）。
 *
 * 本仓实现注意：与 engine-maccms/xml.ts 同一风格（正则、无 XML 库，bundle 体积零增）。
 * CDATA 剥壳 + 实体解码；嵌套 `<item>` 在合法 RSS 中不存在，非贪婪块切分与上游流式行为等价。
 */

export interface RssArticle {
  /** 上游主构造器字段：origin(=sourceUrl) / sort(=分类名) 参与主键 */
  origin: string;
  sort: string;
  title: string;
  order: number;
  link: string;
  pubDate: string | null;
  description: string | null;
  content: string | null;
  image: string | null;
  /** 0网页 / 1图片 / 2视频（继承源 type） */
  type: number;
}

/** CDATA 剥壳 + 五类实体解码（对齐 maccms/xml.ts 的 decodeEntities） */
function decodeXmlText(s: string): string {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  const body = cdata ? cdata[1]! : s;
  return body
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** 元素内部文本（不递归剥子标签——调用方按字段语义决定是否需要） */
function elementText(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return undefined;
  return decodeXmlText(m[1]!);
}

/** 取标签属性值 */
function tagAttr(block: string, tag: string, attr: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*\\b${attr}="([^"]*)"`, 'i'));
  return m ? decodeXmlText(m[1]!) : undefined;
}

/** 描述/正文里抠首图（上游 getImageUrl：第一个 <img> 的 src，双引号形式） */
export function firstImageUrl(input: string): string | null {
  const img = input.match(/<img [^>]*>/i);
  if (!img) return null;
  const src = img[0]!.match(/src\s*=\s*"([^"]+)"/i);
  return src ? src[1]!.trim() : null;
}

/**
 * RssParserDefault.parseXML 移植。
 * @param sortName 分类名（上游 RssArticle.sort，参与主键）
 * @param sourceUrl 源 URL（上游写进 RssArticle.origin）
 */
export function parseRssDefaultXml(
  xml: string,
  sourceUrl: string,
  sortName: string,
  type = 0,
): { articles: RssArticle[]; nextUrl: string | null } {
  const articles: RssArticle[] = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]!;
    const title = elementText(block, 'title')?.trim() ?? '';
    const link = elementText(block, 'link')?.trim() ?? '';

    // 图片四级优先（上游一致）
    let image: string | null = tagAttr(block, 'media:thumbnail', 'url') ?? null;
    if (!image) {
      const enc = block.match(/<enclosure[^>]*>/i);
      if (enc) {
        const encType = tagAttr(enc[0]!, 'enclosure', 'type');
        if (encType && encType.includes('image/')) image = tagAttr(enc[0]!, 'enclosure', 'url') ?? null;
      }
    }
    const description = elementText(block, 'description');
    if (!image && description) image = firstImageUrl(description);
    const content = elementText(block, 'content:encoded');
    if (!image && content) image = firstImageUrl(content);

    // pubDate：只取直接 TEXT（元素内含子标签则跳过 → time 兜底），对齐上游 continue@loop 语义
    let pubDate: string | null = null;
    const pd = block.match(/<pubDate(?:\s[^>]*)?>([\s\S]*?)<\/pubDate>/i);
    if (pd && !pd[1]!.includes('<')) pubDate = decodeXmlText(pd[1]!).trim() || null;
    if (!pubDate) {
      const t = elementText(block, 'time');
      if (t) pubDate = t;
    }

    articles.push({
      origin: sourceUrl,
      sort: sortName,
      title,
      order: articles.length,
      link,
      pubDate,
      description: description?.trim() ?? null,
      content: content?.trim() ?? null,
      image,
      type,
    });
  }
  return { articles, nextUrl: null };
}
