/**
 * MacCMS XML 接口（at/xml）→ 标准 JSON 形状转换
 *
 * XML 形态（苹果CMS classic）：
 *   <rss><class><type id="1">电影</type>...</class>
 *        <list page="1" pagecount="9" recordcount="120">
 *          <video><id>1</id><tid>1</tid><name>片名</name><type>电影</type><pic>..</pic>
 *                 <note>连载至..</note><year>2024</year><area>大陆</area>
 *                 <director>..</director><actor>..</actor><content>简介</content>
 *                 <dl><dd flag="qq">第01集$url#第02集$url2</dd><dd flag="m3u8">...</dd></dl>
 *          </video>...</list></rss>
 *
 * 转换目标：与 JSON 接口 V2 形态一致（{code:1, class, list, page, pagecount, total}），
 * 让 normalizeCmsList / normalizeCmsDetail / parsePlayList 全部复用，零改动。
 */

/** 是否 XML 文本（XML 声明 / rss 根 / 尖括号开头） */
export function isXmlText(body: string): boolean {
  const t = body.trimStart();
  return t.startsWith('<?xml') || /^<rss[\s>]/i.test(t) || /^<video[\s>]/i.test(t);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** 取第一个标签的内部文本（不含属性），无则 undefined */
function tagText(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return undefined;
  const t = decodeEntities(m[1]!.trim());
  return t.length ? t : undefined;
}

/** 取标签属性值 */
function tagAttr(block: string, tag: string, attr: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*\\b${attr}="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]!) : undefined;
}

export interface CmsXmlResult {
  code: number;
  class?: Array<{ type_id: string; type_name: string }>;
  list?: Array<Record<string, unknown>>;
  page?: number;
  pagecount?: number;
  limit?: number;
  total?: number;
}

/** MacCMS XML 文本 → 标准 V2 JSON 形状 */
export function cmsXmlToJson(body: string): CmsXmlResult {
  const out: CmsXmlResult = { code: 1 };

  // 分类：<type id="1" ...>名称</type>（跳过 <type>xxx</type> 无 id 的写法）
  const classes: Array<{ type_id: string; type_name: string }> = [];
  for (const m of body.matchAll(/<type\s+[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/type>/gi)) {
    const name = decodeEntities(m[2]!.trim());
    if (m[1] && name) classes.push({ type_id: m[1], type_name: name });
  }
  if (classes.length) out.class = classes;

  // 分页：<list page="1" pagecount="9" recordcount="120">
  const lm = body.match(/<list\s+([^>]*)>/i);
  if (lm) {
    const attrs = lm[1]!;
    const num = (a: string): number | undefined => {
      const v = tagAttr(`<list ${attrs}>`, 'list', a);
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    out.page = num('page');
    out.pagecount = num('pagecount');
    out.total = num('recordcount') ?? num('total');
    out.limit = num('pagesize') ?? num('limit');
  }

  // video 块 → CmsVod 形状
  const list: Array<Record<string, unknown>> = [];
  for (const vm of body.matchAll(/<video>([\s\S]*?)<\/video>/gi)) {
    const v = vm[1]!;
    const item: Record<string, unknown> = {
      vod_id: tagText(v, 'id') ?? tagText(v, 'vid') ?? '',
      vod_name: tagText(v, 'name') ?? '',
      vod_sub: tagText(v, 'sub'),
      vod_en: tagText(v, 'en'),
      vod_status: tagText(v, 'state'),
      vod_remarks: tagText(v, 'note'),
      vod_pic: tagText(v, 'pic'),
      vod_actor: tagText(v, 'actor'),
      vod_director: tagText(v, 'director'),
      vod_class: tagText(v, 'class'),
      vod_year: tagText(v, 'year'),
      vod_area: tagText(v, 'area'),
      vod_language: tagText(v, 'language'),
      vod_douban: tagText(v, 'douban'),
      vod_content: tagText(v, 'content') ?? tagText(v, 'info') ?? tagText(v, 'des'),
      vod_blurb: tagText(v, 'blurb'),
    };
    // 分类名：XML 里 <type> 分类 id——用 class 表回填 type_name
    const tid = tagText(v, 'tid') ?? tagAttr(v, 'video', 'tid');
    if (tid) item.vod_tid = tid;
    const cls = classes.find((c) => c.type_id === tid);
    if (cls) item.type_name = cls.type_name;

    // 播放组：<dl><dd flag="来源名">集1$url#集2$url</dd>...</dl>
    const froms: string[] = [];
    const urls: string[] = [];
    for (const dm of v.matchAll(/<dd\s+([^>]*)>([\s\S]*?)<\/dd>/gi)) {
      const flag = tagAttr(`<dd ${dm[1]!}>`, 'dd', 'flag') ?? '默认';
      const eps = decodeEntities(dm[2]!.trim());
      if (!eps) continue;
      froms.push(flag);
      urls.push(eps);
    }
    if (froms.length) {
      item.vod_play_from = froms.join('$$$');
      item.vod_play_url = urls.join('$$$');
    }
    list.push(item);
  }
  out.list = list;
  return out;
}
