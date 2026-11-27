/**
 * `#625` URL → 书源识别（core `source-match.ts`）
 *
 * 覆盖上游三级链（`BookshelfViewModel.addBookByUrl:49-110`）的**每一条分支与每一个退化**，
 * 以及两条「看起来该命中但其实不该」的边界（整串匹配 / 非 http(s)）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchBookUrlPattern,
  resolveSourceByUrl,
  resolveSourceByUrls,
  urlBaseOf,
  urlBodyOf,
  urlOptionOrigin,
  type UrlSourceCandidate,
} from '../source-match';

const src = (over: Partial<UrlSourceCandidate> & { id: string }): UrlSourceCandidate => ({
  url: '',
  ...over,
});

test('#625 urlBaseOf：scheme://authority（保留端口 / 去路径查询 fragment）', () => {
  assert.equal(urlBaseOf('https://a.b.com/book/1?x=2#f'), 'https://a.b.com');
  assert.equal(urlBaseOf('http://a.b.com:8080/x'), 'http://a.b.com:8080');
  assert.equal(urlBaseOf('HTTPS://A.B.com/x'), 'https://a.b.com');
  // 上游 :196-197：`https://host@js:'data:...'` 先截到 @js: 之前，否则解析出假 host `data:`
  assert.equal(urlBaseOf("https://a.b.com@js:'data:text/html,hi'"), 'https://a.b.com');
  // 非 http(s) ⇒ undefined（上游 getBaseUrl 返 null ⇒ 调用方跳过该 URL）
  assert.equal(urlBaseOf('ftp://a.b.com/x'), undefined);
  assert.equal(urlBaseOf('not a url'), undefined);
  assert.equal(urlBaseOf(''), undefined);
});

test('#625 urlOptionOrigin：`,{...}` 尾巴里的 origin（含百分号编码 / 单引号 / 无引号键）', () => {
  assert.equal(urlOptionOrigin('https://h/b/1,{"origin":"https://s1"}'), 'https://s1');
  assert.equal(urlOptionOrigin("https://h/b/1,{'origin':'https://s2'}"), 'https://s2');
  assert.equal(urlOptionOrigin('https://h/b/1,{origin:"https://s3"}'), 'https://s3');
  // 尾巴被百分号编码（规则求值链路会编码 `{ " 空格`）
  assert.equal(
    urlOptionOrigin('https://h/b/1,%7B%20%22origin%22%20%3A%20%22https%3A%2F%2Fs5%22%20%7D'),
    'https://s5',
  );
  // 没有尾巴 / 尾巴里没有 origin
  assert.equal(urlOptionOrigin('https://h/b/1'), undefined);
  assert.equal(urlOptionOrigin('https://h/b/1,{"method":"POST"}'), undefined);
});

test('#625 matchBookUrlPattern：整串匹配（Kotlin String.matches 语义）+ NONE/invalid 三态', () => {
  assert.equal(matchBookUrlPattern('https://h/book/\\d+', 'https://h/book/123'), 'hit');
  // ★ 关键边界：不加 ^(?:…)$ 时 `\d+` 会把 `…/book/123/extra` 也判命中，上游不会
  assert.equal(matchBookUrlPattern('https://h/book/\\d+', 'https://h/book/123/extra'), 'miss');
  assert.equal(matchBookUrlPattern('', 'https://h/x'), 'none');
  assert.equal(matchBookUrlPattern('NONE', 'https://h/x'), 'none');
  assert.equal(matchBookUrlPattern(undefined, 'https://h/x'), 'none');
  // 写坏的正则不抛（上游会 PatternSyntaxException 打挂调用方；我们退化 + 留痕）
  assert.equal(matchBookUrlPattern('https://h/(unclosed', 'https://h/x'), 'invalid');
});

test('#625 ① 尾巴指定 origin + pattern 命中 ⇒ 走第一级（即使域名也能匹配别的源）', () => {
  const a = src({ id: 'a', url: 'https://host-a.com', bookUrlPattern: 'https://host-a\\.com/book/\\d+' });
  const b = src({ id: 'b', url: 'https://host-b.com' });
  const m = resolveSourceByUrl('https://host-a.com/book/9,{"origin":"https://host-a.com"}', [b, a]);
  assert.equal(m?.source.id, 'a');
  assert.equal(m?.by, 'url-option-origin');
  // bookUrl 原样保留尾巴（上游 Book.bookUrl 也带着；引擎 analyzeUrl 请求时才剥）
  assert.equal(m?.bookUrl, 'https://host-a.com/book/9,{"origin":"https://host-a.com"}');
});

test('#625 ① 校验按「地址本体」而非含尾巴的整串（上游此处是死代码，本仓显式修正）', () => {
  // origin 一定在尾巴里 ⇒ 上游拿带尾巴的整串去匹配地址本体 pattern **恒不命中**
  // ⇒ 上游这条分支永远退到 ②③。我们先用本体匹配，保住「校验这只源能处理这只 URL」的原意。
  const a = src({ id: 'a', url: 'https://host-a.com', bookUrlPattern: 'https://host-a\\.com/book/\\d+' });
  const other = src({ id: 'other', url: 'https://host-a.com/book/9' }); // 域名步骤本来会抢到它
  const m = resolveSourceByUrl('https://host-a.com/book/9,{"origin":"https://host-a.com"}', [other, a]);
  assert.equal(m?.source.id, 'a', '显式 origin 是用户最强信号，应压过域名猜测');
  assert.equal(m?.by, 'url-option-origin');
  assert.match(m?.steps[0]?.note ?? '', /按地址本体/);
  // urlBodyOf 的边界：没有尾巴时返回原串（trim）
  assert.equal(urlBodyOf('  https://h/b/1  '), 'https://h/b/1');
  assert.equal(urlBodyOf('https://h/b/1,{"origin":"x"}'), 'https://h/b/1');
});

test('#625 ① 尾巴指定 origin 但该源没配 pattern ⇒ 上游 NPE ⇒ 退到后续步骤', () => {
  // 上游写的是 `bs.bookUrlPattern!!`：没 pattern 时 NPE 被 catch，source 仍为 null
  const a = src({ id: 'a', url: 'https://host-a.com' });
  const m = resolveSourceByUrl('https://host-a.com/book/9,{"origin":"https://host-a.com"}', [a]);
  // ① 失败后 ② 域名严格等值命中同一个源 ⇒ by 必须是 base-url（不是 url-option-origin）
  assert.equal(m?.source.id, 'a');
  assert.equal(m?.by, 'base-url');
  const steps = (m?.steps ?? []).map((s) => s.step);
  assert.deepEqual(steps, ['url-option-origin', 'base-url']);
});

test('#625 ② 域名严格等值（上游 getBookSourceAddBook：bookSourceUrl == baseUrl）', () => {
  const a = src({ id: 'a', url: 'https://www.a.com' });
  const m = resolveSourceByUrl('https://www.a.com/book/1?from=list', [a]);
  assert.equal(m?.source.id, 'a');
  assert.equal(m?.by, 'base-url');
});

test('#625 ② 归一化兜底：bookSourceUrl 带尾斜杠 / 带路径也能命中（本仓显式超集）', () => {
  // 数据依据：语料 99/483 源带尾斜杠、54 个带路径 ⇒ 上游 `=` 对它们恒不命中
  const slash = src({ id: 'slash', url: 'https://b.com/' });
  assert.equal(resolveSourceByUrl('https://b.com/book/1', [slash])?.by, 'base-url');
  const withPath = src({ id: 'path', url: 'https://c.com/index.html' });
  assert.equal(resolveSourceByUrl('https://c.com/book/1', [withPath])?.by, 'base-url');
});

test('#625 ② 同 host 多源：严格等值优先，其次按 customOrder 取第一只（可复现）', () => {
  const p1 = src({ id: 'p1', url: 'https://d.com/', order: 30 });
  const p2 = src({ id: 'p2', url: 'https://d.com/', order: 10 });
  const exact = src({ id: 'exact', url: 'https://d.com' });
  // 有严格等值的那只 ⇒ 一定选它（与 order 无关）
  assert.equal(resolveSourceByUrl('https://d.com/book/1', [p1, p2, exact])?.source.id, 'exact');
  // 只有带斜杠的两只 ⇒ 按 customOrder 升序取 p2（不依赖数组顺序）
  assert.equal(resolveSourceByUrl('https://d.com/book/1', [p1, p2])?.source.id, 'p2');
});

test('#625 ③ bookUrlPattern 遍历：按 customOrder 升序，第一个命中即用', () => {
  // 域名谁都匹配不上（bookSourceUrl 是别的站），只能靠 pattern 捞
  const pa = src({ id: 'pa', url: 'https://site-a.com', bookUrlPattern: 'https://img\\.site\\.com/chapter/\\d+', order: 5 });
  const pb = src({ id: 'pb', url: 'https://site-b.com', bookUrlPattern: 'https://img\\.site\\.com/.+', order: 9 });
  const m = resolveSourceByUrl('https://img.site.com/chapter/77', [pb, pa]);
  assert.equal(m?.source.id, 'pa', 'order 5 的 pa 更短更准，且排在前面');
  assert.equal(m?.by, 'bookUrlPattern');
});

test('#625 ③ NONE / 空 pattern 的源不参与遍历（上游 `trim <> \'\' and <> \'NONE\'`）', () => {
  const bad = src({ id: 'bad', url: 'https://x.com', bookUrlPattern: 'NONE', order: 1 });
  const blank = src({ id: 'blank', url: 'https://y.com', bookUrlPattern: '   ', order: 2 });
  assert.equal(resolveSourceByUrl('https://z.com/book/1', [bad, blank]), undefined);
});

test('#625 ③ 写坏的正则不参与匹配、也不抛（退化为「没命中」）', () => {
  const broken = src({ id: 'broken', url: 'https://x.com', bookUrlPattern: 'https://z\\.com/(unclosed', order: 1 });
  const ok = src({ id: 'ok', url: 'https://y.com', bookUrlPattern: 'https://z\\.com/book/\\d+', order: 2 });
  assert.equal(resolveSourceByUrl('https://z.com/book/1', [broken, ok])?.source.id, 'ok');
});

test('#625 全链未命中 ⇒ undefined（上游 `source ?: continue` 跳过该 URL）', () => {
  const a = src({ id: 'a', url: 'https://a.com' });
  assert.equal(resolveSourceByUrl('https://nobody.com/book/1', [a]), undefined);
});

test('#625 禁用源不参与（enabled === false 直接被过滤）', () => {
  const off = src({ id: 'off', url: 'https://a.com', enabled: false });
  assert.equal(resolveSourceByUrl('https://a.com/book/1', [off]), undefined);
});

test('#625 多行粘贴：保留顺序、空白行跳过、未命中也留条目（便于逐行报错）', () => {
  const a = src({ id: 'a', url: 'https://a.com' });
  const rows = resolveSourceByUrls('https://a.com/book/1\n\n  https://nobody.com/b/2  \n', [a]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.url, 'https://a.com/book/1');
  assert.equal(rows[0]!.match?.source.id, 'a');
  assert.equal(rows[1]!.url, 'https://nobody.com/b/2');
  assert.equal(rows[1]!.match, undefined);
});

test('#625 steps 留痕可解释（每一步都记 tested 与原因）', () => {
  const a = src({ id: 'a', url: 'https://a.com' });
  const m = resolveSourceByUrl('https://a.com/book/9,{"origin":"https://other.com"}', [a]);
  assert.ok(m);
  assert.equal(m.steps[0]!.step, 'url-option-origin');
  assert.match(m.steps[0]!.note, /不在候选集/);
  assert.equal(m.steps[1]!.step, 'base-url');
  assert.match(m.steps[1]!.note, /严格等值/);
});
