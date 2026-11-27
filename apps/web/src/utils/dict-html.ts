/**
 * 字典结果 HTML 的**渲染前处理**（用户 2026-09-28）。
 *
 * 实测（海词中文 `https://hanyu.dict.cn/苹果`、汉典 `https://www.zdic.net/hans/苹果`）三个问题：
 *
 *  ① **图片不显示**：`src` 有相对路径（汉典 `/images/logo.png`）⇒ 在我们页面里会解析成
 *     `http://127.0.0.1:3000/images/logo.png` ⇒ 404；绝对地址的图站（`i1.haidii.com`）又常有防盗链。
 *     ⇒ 统一**按字典站 origin 补全 + 走 `/api/proxy`（带该站 Referer）**。
 *  ② **点链接把我们页面跳走**：`<a href>` 没有 `target`；而且有协议相对（`//zdic.net`）与根相对（`/ts/`）
 *     地址，不补全就是在打我们自己的服务。⇒ 补全为绝对地址 + `target="_blank" rel="noopener noreferrer"`。
 *  ③ **发音按钮失效**：汉典的发音是 `<button data-audio="//img.zdic.net/audio/…mp3,….mp3">` +
 *     **站点自己的 JS** 监听 click 播放 —— 我们只渲染 HTML、不跑站点脚本 ⇒ 按钮点了没反应。
 *     ⇒ 把 `data-audio` 补全为绝对地址并序列化到 `data-dict-audio`，由**我们自己的点击处理**顺序播放
 *     （`playDictAudio`，见下）。
 *  ④ **笔顺动画按钮失效**（用户 2026-09-28 追加）：汉典是
 *     `<div class="char-glyph-img" data-gif="https://img.zdic.net/kai/jbh/82F9.gif"><button class="char-glyph__play">`
 *     —— 站点 JS 点击后把 GIF 塞进容器。⇒ 把 `data-gif` 补全到 `data-dict-gif`，由 `playDictGif` 插入播放
 *     （再点一次重放）。
 *
 * 处理顺序：**先 `sanitizeHtml` 再 decorate** —— decorate 只做「URL 补全 + 加几个属性」，
 * 不引入新标签，所以**不必放宽 sanitize 的白名单**，安全边界不变。
 *
 * ⚠️ **不做 iframe 内嵌**（用户问过）：实测 海词中文 `X-Frame-Options: DENY`、汉典 `SAMEORIGIN`
 * ⇒ 浏览器**直接拒绝嵌框**（白屏），不是我们写错的问题；真要在浮窗里内嵌整页只能**服务端代理整页 + 重写
 * 全部资源 URL**，那会丢掉站点 CSS/JS（版式全乱、交互全失效），成本高且无必要 ⇒ 用「新标签打开」代替。
 */
import { sanitizeHtml } from './sanitize';
import { imgSrc } from './img';

/**
 * 结果像「正文 HTML」还是「站点返回的短文本」？
 *
 * 为什么要分：字典站对**未收录的词**会返回 404 / 一页索引 / 短提示文本。实测（2026-09-28）：
 * 查一个不成词的两字（如「她犹」）时，汉典 404，而**本机代理把响应替换成了 18 字节的
 * `route snapshot 不存在`** —— 我们原先把这段文案当正文渲染进字典窗，看着像「查词结果是一句莫名其妙的话」。
 * 现在：短且不含标签的文本 ⇒ 用「站点返回：…」的提示样式如实展示（对齐引擎侧 `UnifiedListResult.hint` 的思路）。
 */
export function dictResultIsPlain(text: unknown): boolean {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (t.length >= 200) return false; // 够长就当正文（站点错误页通常很短）
  return !/<[a-z!/][\s\S]*>/i.test(t); // 没有任何标签 ⇒ 不是 HTML
}

/** 从字典规则的 `urlRule` 里取出站点 origin（用作相对地址的 base 与代理的 Referer） */
export function dictOrigin(urlRule: unknown): string {
  // ⚠️ urlRule 可能带 `,{options}` 尾巴（有道的 POST 形态），故 host 段不能吃掉 `,`
  const m = String(urlRule ?? '').match(/^\s*(https?:\/\/[^/?#,\s{}]+)/i);
  return m?.[1] ?? '';
}

/** 以 `base` 为基准补全为绝对 URL；不可用/危险协议返回空串 */
function absUrl(u: string, base: string): string {
  const s = String(u ?? '').trim();
  if (!s || /^(data:|blob:|javascript:|mailto:|tel:)/i.test(s)) return '';
  try {
    return new URL(s, `${base}/`).href;
  } catch {
    return '';
  }
}

/**
 * 把字典结果的 HTML 处理成**可直接 `v-html`** 的形态。
 * @param raw     字典站返回的 HTML（尚未消毒）
 * @param urlRule 该字典的 `urlRule`（用来推站点 origin）
 */
export function decorateDictHtml(raw: unknown, urlRule: unknown): string {
  const html = sanitizeHtml(String(raw ?? ''));
  const base = dictOrigin(urlRule);
  if (!base || typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(`<div id="yuedu-dict-root">${html}</div>`, 'text/html');
  const root = doc.getElementById('yuedu-dict-root');
  if (!root) return html;

  // ① 图片：补全 → 走代理（带字典站 Referer）→ 懒加载
  root.querySelectorAll('img[src]').forEach((el) => {
    const a = absUrl(el.getAttribute('src') ?? '', base);
    if (!a) {
      el.removeAttribute('src');
      return;
    }
    el.setAttribute('src', imgSrc(a, { referer: base }));
    el.setAttribute('loading', 'lazy');
    el.removeAttribute('srcset'); // srcset 里的相对地址我们没处理 ⇒ 宁可不用
  });

  // ② 链接：补全 + 新标签打开（不放走当前页面）
  root.querySelectorAll('a[href]').forEach((el) => {
    const raw2 = (el.getAttribute('href') ?? '').trim();
    if (/^(javascript:|#)/i.test(raw2)) {
      el.removeAttribute('href'); // 站点脚本链接（我们跑不了站点 JS）⇒ 去掉，别当锚点骗人
      return;
    }
    const a = absUrl(raw2, base);
    if (!a) {
      el.removeAttribute('href');
      return;
    }
    el.setAttribute('href', a);
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  });

  // ③ 发音按钮：补全媒体地址（逗号分隔 = 多音节，顺序播）并把行为交给我们自己
  root.querySelectorAll('[data-audio]').forEach((el) => {
    const urls = String(el.getAttribute('data-audio') ?? '')
      .split(',')
      .map((s) => absUrl(s.trim(), base))
      .filter(Boolean);
    el.removeAttribute('data-audio');
    if (!urls.length) return;
    el.setAttribute('data-dict-audio', urls.map((u) => imgSrc(u, { referer: base })).join('|'));
    el.setAttribute('role', 'button');
    el.setAttribute('title', '播放发音');
  });

  // ④ 笔顺动画（汉典）：`<div class="char-glyph-img" data-gif="https://img.zdic.net/kai/jbh/82F9.gif">
  //    <button class="char-glyph__play">` —— 站点用 JS 在点击时把 GIF 塞进容器，我们跑不了它的脚本，
  //    于是把 GIF 地址补全后由**我们自己的点击处理**插入播放（见 `playDictGif`）。
  root.querySelectorAll('[data-gif]').forEach((el) => {
    const g = absUrl(el.getAttribute('data-gif') ?? '', base);
    el.removeAttribute('data-gif');
    if (!g) return;
    el.setAttribute('data-dict-gif', imgSrc(g, { referer: base }));
    el.setAttribute('role', 'button');
    el.setAttribute('title', '点击播放笔顺动画');
  });

  return root.innerHTML;
}

/**
 * 播放某个发音按钮里的**全部音节**（顺序播放）。
 * 用临时的 `Audio` 元素逐个播；任一环节失败/超时都继续往下，避免队列卡死。
 */
export async function playDictAudio(el: Element): Promise<void> {
  const list = String(el.getAttribute('data-dict-audio') ?? '').split('|').filter(Boolean);
  for (const u of list) {
    await new Promise<void>((resolve) => {
      const a = new Audio(u);
      let done = false;
      const fin = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      a.onended = fin;
      a.onerror = fin;
      window.setTimeout(fin, 4000); // 兜底：单个音节最多等 4s
      void a.play().catch(fin);
    });
  }
}

/**
 * 播放笔顺动画（汉典 `data-gif`）。
 *
 * 站点原逻辑是「点按钮 → JS 把 GIF 塞进 `char-glyph-img` 容器」，我们直接做同一件事：
 * 往容器里插一张 `<img class="rd-dict-gif">`；**再点一次会重放**（重新赋 `src` 并加一个变化的
 * `_r` 查询参数 ⇒ 绕开缓存、GIF 从头播）。
 *
 * GIF 经 `/api/proxy` 取（服务端只做解密/content-type 纠正、**不做转码** ⇒ 动画保留）。
 */
export function playDictGif(el: Element): void {
  const src = el.getAttribute('data-dict-gif') ?? '';
  if (!src) return;
  let img = el.querySelector<HTMLImageElement>('img.rd-dict-gif');
  if (!img) {
    img = document.createElement('img');
    img.className = 'rd-dict-gif';
    img.alt = '笔顺动画';
    el.appendChild(img);
  }
  const sep = src.includes('?') ? '&' : '?';
  img.setAttribute('src', `${src}${sep}_r=${Date.now()}`);
  el.classList.add('playing');
}
