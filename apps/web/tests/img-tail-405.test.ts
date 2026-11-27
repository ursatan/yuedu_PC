/**
 * `#405①` 回归锁：封面/图片 URL 尾部的 `,{...}` 选项尾巴必须被拆开（上游在图片加载器里拆）。
 *
 * 实证（🎨咚漫 `ruleSearch.coverUrl` 尾段 `@js:`）：
 *   `https://cdn…/x.jpg?x-oss-process=image/resize,limit_0,m_fill,w_240,h_254/quality,q_70,{"headers":"{\"Referer\":\"https://m.dongmanmanhua.cn/dailySchedule\"}"}`
 * 旧行为：整串当 `<img src>` ⇒ 非法 URL ⇒ 封面 404/塌缩。
 * 修法：拆出主 URL + `Referer`（走 `/api/proxy` 的 `r=`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imgSrc, splitImageUrlTail } from '../src/utils/img';

const COVER =
  'https://cdn.dongmanmanhua.cn/ce2c.jpg?x-oss-process=image/resize,limit_0,m_fill,w_240,h_254/quality,q_70,' +
  '{"headers":"{\\"Referer\\":\\"https://m.dongmanmanhua.cn/dailySchedule\\"}"}';

test('#405① splitImageUrlTail：拆出主 URL 与 Referer', () => {
  const r = splitImageUrlTail(COVER);
  assert.equal(r.url, 'https://cdn.dongmanmanhua.cn/ce2c.jpg?x-oss-process=image/resize,limit_0,m_fill,w_240,h_254/quality,q_70');
  assert.equal(r.referer, 'https://m.dongmanmanhua.cn/dailySchedule');
});

test('#405① imgSrc：URL 内 `,` 不受影响（只认 `,{` 尾巴），且 Referer 进 `r=`', () => {
  const out = imgSrc(COVER, { sourceId: 'src1', cover: true });
  assert.ok(out.startsWith('/api/proxy?'), out);
  const q = new URLSearchParams(out.slice(out.indexOf('?') + 1));
  assert.equal(q.get('u'), 'https://cdn.dongmanmanhua.cn/ce2c.jpg?x-oss-process=image/resize,limit_0,m_fill,w_240,h_254/quality,q_70');
  assert.equal(q.get('r'), 'https://m.dongmanmanhua.cn/dailySchedule');
  assert.equal(q.get('sid'), 'src1');
  assert.equal(q.get('cover'), '1');
});

test('#405① 对偶：无尾巴 → 原样；显式 referer 优先于尾巴', () => {
  assert.deepEqual(splitImageUrlTail('https://x/y.jpg?a=1,b=2'), { url: 'https://x/y.jpg?a=1,b=2' });
  const out = imgSrc(COVER, { referer: 'https://explicit/' });
  const q = new URLSearchParams(out.slice(out.indexOf('?') + 1));
  assert.equal(q.get('r'), 'https://explicit/');
});

test('#405① 对偶：尾巴不是合法 JSON ⇒ 原样返回（不猜、不改未知形态）', () => {
  const bad = 'https://x/y.jpg,{not-json';
  assert.deepEqual(splitImageUrlTail(bad), { url: bad });
});

test('#405① headers 为对象形态（非字符串）也认', () => {
  const r = splitImageUrlTail('https://x/y.jpg,{"headers":{"referer":"https://r/"}}');
  assert.equal(r.url, 'https://x/y.jpg');
  assert.equal(r.referer, 'https://r/');
});

// ---------------------------------------------------------------------------
// `#441` 内联 `data:image/…`（91视频：src 是 AES 密文的 base64 ⇒ 要经服务端解密）
// ---------------------------------------------------------------------------

const DATA_IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

test('#441 imgSrc：`data:image/…` **带源 id** ⇒ 走 `/api/proxy`（源可声明解密规则）', () => {
  const out = imgSrc(DATA_IMG, { sourceId: 'src9', cover: true });
  assert.ok(out.startsWith('/api/proxy?'), out);
  const q = new URLSearchParams(out.slice(out.indexOf('?') + 1));
  assert.equal(q.get('u'), DATA_IMG);
  assert.equal(q.get('sid'), 'src9');
  assert.equal(q.get('cover'), '1');
});

test('#441 对偶：无源 id 的内联图**原样返回**（主题壁纸 / 本地书插图不吃这一跳）', () => {
  assert.equal(imgSrc(DATA_IMG), DATA_IMG);
  assert.equal(imgSrc('data:image/png;base64,iVBORw0KGgo=', { cover: true }), 'data:image/png;base64,iVBORw0KGgo=');
});

test('#441 对偶：非图片的 `data:`（本地书文本/字体）即使带源 id 也不代理', () => {
  assert.equal(imgSrc('data:text/plain;base64,aGVsbG8=', { sourceId: 'src9' }), 'data:text/plain;base64,aGVsbG8=');
  assert.equal(imgSrc('blob:http://x/1', { sourceId: 'src9' }), 'blob:http://x/1');
});

// ---------------------------------------------------------------------------
// `#742` 哔咔封面「IP 进 URL + `Host` 头」：必须还原成「域名 URL + dnsIp」
//   实测（真实封面样本）：IP 进 URL + Host ⇒ CF `error code: 1003`；
//   域名 + dnsIp(https) ⇒ 200 / 207799B / 1058ms。http 版 ⇒ 20s 超时。
// ---------------------------------------------------------------------------

const PICA_IP_COVER =
  'http://104.21.235.3/static/sub_storage_1/b4/b5/b4b5042d-4a5c-4cbb-8a2c-13060b05b990.jpg,' +
  '{"headers":{"Host":"storage-b.picacomic.com"}}';

test('#742 splitImageUrlTail：认出 `Host` 头（不区分大小写）与 `dnsIp`', () => {
  const r = splitImageUrlTail(PICA_IP_COVER);
  assert.equal(r.url, 'http://104.21.235.3/static/sub_storage_1/b4/b5/b4b5042d-4a5c-4cbb-8a2c-13060b05b990.jpg');
  assert.equal(r.host, 'storage-b.picacomic.com');
  assert.equal(splitImageUrlTail('https://a/b.jpg,{"headers":{"host":"h1"}}').host, 'h1');
  assert.equal(splitImageUrlTail('https://a/b.jpg,{"dnsIp":"1.2.3.4"}').dnsIp, '1.2.3.4');
});

test('#742 imgSrc：IP 进 URL + Host ⇒ 还原域名（https）+ `dnsIp=<该 IP>`，不塞 `h=`', () => {
  const out = imgSrc(PICA_IP_COVER, { sourceId: 'pica', cover: true });
  const q = new URLSearchParams(out.slice(out.indexOf('?') + 1));
  assert.equal(
    q.get('u'),
    'https://storage-b.picacomic.com/static/sub_storage_1/b4/b5/b4b5042d-4a5c-4cbb-8a2c-13060b05b990.jpg',
  );
  assert.equal(q.get('dnsIp'), '104.21.235.3');
  assert.equal(q.get('h'), null, 'Host 由域名天然决定，不该再传 h');
});

test('#742 imgSrc：域名 URL + `{"dnsIp":…}` ⇒ 域名不动，只带 dnsIp', () => {
  const u = 'https://picaapi.picacomic.com/comics?page=1';
  const out = imgSrc(`${u},{"dnsIp":"104.19.53.76"}`, { sourceId: 'pica' });
  const q = new URLSearchParams(out.slice(out.indexOf('?') + 1));
  assert.equal(q.get('u'), u);
  assert.equal(q.get('dnsIp'), '104.19.53.76');
});

test('#742 对偶：显式 dnsIp 优先于 IP 字面量；域名 URL + 仅 Host ⇒ 原样 u + `h=` 兜底', () => {
  const explicit = imgSrc(`${PICA_IP_COVER.slice(0, -1)},"dnsIp":"172.67.194.19"}`, { sourceId: 'pica' });
  const q1 = new URLSearchParams(explicit.slice(explicit.indexOf('?') + 1));
  assert.equal(q1.get('dnsIp'), '172.67.194.19');
  assert.equal(q1.get('u'), 'https://storage-b.picacomic.com/static/sub_storage_1/b4/b5/b4b5042d-4a5c-4cbb-8a2c-13060b05b990.jpg');

  const hostOnly = imgSrc('https://a.com/x.jpg,{"headers":{"Host":"b.com"}}', { sourceId: 's' });
  const q2 = new URLSearchParams(hostOnly.slice(hostOnly.indexOf('?') + 1));
  assert.equal(q2.get('u'), 'https://a.com/x.jpg');
  assert.equal(q2.get('h'), 'b.com');
  assert.equal(q2.get('dnsIp'), null);
});

test('#742 对偶：普通图片（无尾巴 / 非 IP 主机）行为完全不变', () => {
  assert.equal(imgSrc('https://cdn/x.jpg', { sourceId: 's' }).includes('dnsIp='), false);
  const q = new URLSearchParams(imgSrc('https://cdn/x.jpg', { sourceId: 's' }).split('?')[1]!);
  assert.equal(q.get('u'), 'https://cdn/x.jpg');
});

// ---------------------------------------------------------------------------
// `#744` 哔咔**正文内联 `<img>`**（阅读器，非封面）：`ruleContent` 产出的整串
//   `http://<CF IP>/static/…jpg,{"method":"GET","timeout":30000,"headers":{"Host":"storage-b…"}}`
//   引擎侧已改为**保留尾巴**（否则阅读器拿不到 Host ⇒ 代理按 IP 建连 ⇒ CF `error code: 1003`）。
//   真机：改写后 200 image/jpeg 269525 / 251754 / 250525 字节（2271/1561/1664ms）；
//   未改写（裸 `http://IP/…`）⇒ 403 `error code: 1003`。
// ---------------------------------------------------------------------------

const PICA_CHAPTER_IMG =
  'http://104.21.91.145/static/sub_storage_1/ee/9d/ee9d3f08-4714-4ed2-9f33-ee97e591b94f.jpg,' +
  '{"method":"GET","timeout":30000,"headers":{"Host":"storage-b.picacomic.com"}}';

test('#744 正文内联 img 带 Host ⇒ 改写域名(https) + 透传 `dnsIp`（阅读器与封面同一判定）', () => {
  const out = imgSrc(PICA_CHAPTER_IMG, { sourceId: 'pica' });
  assert.ok(out.startsWith('/api/proxy?'), out);
  const q = new URLSearchParams(out.slice(out.indexOf('?') + 1));
  assert.equal(
    q.get('u'),
    'https://storage-b.picacomic.com/static/sub_storage_1/ee/9d/ee9d3f08-4714-4ed2-9f33-ee97e591b94f.jpg',
    'IP 字面量必须换成域名（否则 Host 头与 SNI 不匹配，CF 1003）',
  );
  assert.equal(q.get('dnsIp'), '104.21.91.145', '按 IP 建连，Host/SNI 仍是域名');
  assert.equal(q.get('h'), null, '有域名就不该再传 h');
  assert.equal(q.get('cover'), null);
});

test('#744 正文内联 `http://IP` 无尾巴 ⇒ 行为不变（原样交给代理，不做猜测）', () => {
  const noTail = 'http://104.21.91.145/static/a.jpg';
  assert.deepEqual(splitImageUrlTail(noTail), { url: noTail });
  const q = new URLSearchParams(imgSrc(noTail, { sourceId: 'pica' }).split('?')[1]!);
  assert.equal(q.get('u'), noTail);
  assert.equal(q.get('dnsIp'), null);
});

test('#744 正文内联 域名 + `{"dnsIp":…}` ⇒ 域名/协议不动、只带 dnsIp', () => {
  const out = imgSrc('https://storage-b.picacomic.com/a.jpg,{"dnsIp":"104.19.53.76"}', { sourceId: 'pica' });
  const q = new URLSearchParams(out.slice(out.indexOf('?') + 1));
  assert.equal(q.get('u'), 'https://storage-b.picacomic.com/a.jpg');
  assert.equal(q.get('dnsIp'), '104.19.53.76');
  assert.equal(q.get('h'), null);
});

test('#744 正文内联 `data:image` 内联图不吃这一跳（无源 id 时原样）', () => {
  const d = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  assert.equal(imgSrc(d), d);
});
