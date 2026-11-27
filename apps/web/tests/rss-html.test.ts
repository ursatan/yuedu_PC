/**
 * `#345` RSS 正文 `<img>` 改写（`decorateRssHtml`）的回归锁。
 *
 * ## 为什么这么测
 * 该函数只在「有 `DOMParser` 的浏览器」里真正改写；Node 测试环境没有 DOM。
 * 于是注入一个**最小假 DOMParser**（只实现用到的 `querySelectorAll/getAttribute/
 * setAttribute/removeAttribute/innerHTML`），断言**语义**：
 *  · 相对地址被补全为绝对 + 改写成 `/api/proxy`（这一条是 24 系列图片全失败的正解）；
 *  · `data:`/`blob:`/`javascript:` 原样不动；
 *  · `srcset` 被移除（未处理的相对地址不能留给浏览器）；
 *  · 无 `base` / 无 `DOMParser` 时**原样返回**（退化旧行为，不炸）。
 *
 * ⚠️ 断言的是「改写成什么」，不是「DOM 怎么实现」——所以假 DOM 足够。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 假 <img>：记录属性读写 */
class FakeEl {
  constructor(public attrs: Record<string, string>) {}
  getAttribute(n: string): string | null {
    return n in this.attrs ? this.attrs[n]! : null;
  }
  setAttribute(n: string, v: string): void {
    this.attrs[n] = v;
  }
  removeAttribute(n: string): void {
    delete this.attrs[n];
  }
}

/**
 * 极简 DOMParser：把 HTML 里的 `<img ...>` 正则抽成 FakeEl，并支持回写 innerHTML。
 * 只覆盖本函数用到的选择器（`img[src]` / `source[src]` / `video[poster]`）。
 */
function installFakeDom(html: string, imgs: FakeEl[], sources: FakeEl[] = [], videos: FakeEl[] = []) {
  const body = {
    querySelectorAll(sel: string): FakeEl[] {
      if (sel.startsWith('img')) return imgs.filter((e) => e.getAttribute('src') != null);
      if (sel.startsWith('source')) return sources.filter((e) => e.getAttribute('src') != null);
      if (sel.startsWith('video')) return videos.filter((e) => e.getAttribute('poster') != null);
      return [];
    },
    get innerHTML(): string {
      // 回写：把每个 FakeEl 渲染成 `<img ...>`（够断言用）
      return imgs
        .map((e) => '<img ' + Object.entries(e.attrs).map(([k, v]) => `${k}="${v}"`).join(' ') + '>')
        .join('');
    },
  };
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
    parseFromString(): { body: typeof body } {
      return { body };
    }
  };
  return { html, body };
}

/** 还原：删掉全局 DOMParser，避免污染其它测试 */
function uninstallFakeDom() {
  delete (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
}

test('#345：相对路径 `<img>` 补全为绝对 + 走 /api/proxy', async () => {
  const { decorateRssHtml } = await import('../src/utils/rss-html');
  const img = new FakeEl({ src: '/LoadImage.ashx/AAA.jpg' });
  installFakeDom('', [img]);
  try {
    const out = decorateRssHtml('<img src="/LoadImage.ashx/AAA.jpg">', {
      base: 'https://www.24ao.cc/Articles/Content/3536.html',
      sid: 'https___www.24ao.cc_',
    });
    // 关键断言：src 被改成 /api/proxy，且 u= 是**绝对地址**（/LoadImage 相对地址必须先补全）
    assert.match(out, /src="\/api\/proxy\?/, 'src 必须走 /api/proxy');
    const u = decodeURIComponent(/u=([^&"]+)/.exec(out)?.[1] ?? '');
    assert.equal(u, 'https://www.24ao.cc/LoadImage.ashx/AAA.jpg', '相对地址必须补全为文章 origin 下的绝对地址');
    assert.match(out, /sid=https___www\.24ao\.cc_/, 'sid 必须带上（代理据此取源头 Referer/UA/Cookie）');
  } finally {
    uninstallFakeDom();
  }
});

test('#345：data: 原样不动；相对地址被改写时 srcset 一并移除', async () => {
  const { decorateRssHtml } = await import('../src/utils/rss-html');
  // data: 图不碰（危险协议/内联资源）
  const dataImg = new FakeEl({ src: 'data:image/png;base64,AAAA' });
  installFakeDom('', [dataImg]);
  try {
    const out = decorateRssHtml('<img src="data:image/png;base64,AAAA">', { base: 'https://a.com/p/' });
    assert.match(out, /src="data:image\/png;base64,AAAA"/, 'data: 必须原样保留');
  } finally {
    uninstallFakeDom();
  }
  // 相对地址改写时，srcset 必须移除（未处理的相对地址不能留给浏览器）
  const relImg = new FakeEl({ src: '/x.jpg', srcset: '/x.jpg 1x' });
  installFakeDom('', [relImg]);
  try {
    const out = decorateRssHtml('<img src="/x.jpg" srcset="/x.jpg 1x">', { base: 'https://a.com/p/' });
    assert.match(out, /src="\/api\/proxy\?/, '相对地址必须改写成 /api/proxy');
    assert.doesNotMatch(out, /srcset=/, 'srcset 必须被移除');
  } finally {
    uninstallFakeDom();
  }
});

test('#345：无 base / 无 DOMParser ⇒ 原样返回（退化旧行为，不炸）', async () => {
  const { decorateRssHtml } = await import('../src/utils/rss-html');
  uninstallFakeDom(); // 确保没有 DOMParser
  const raw = '<img src="/x.jpg">';
  assert.equal(decorateRssHtml(raw, { base: 'https://a.com/' }), raw, '无 DOMParser ⇒ 原样返回');
  const img = new FakeEl({ src: '/x.jpg' });
  installFakeDom('', [img]);
  try {
    assert.equal(decorateRssHtml(raw, {}), raw, '无 base ⇒ 原样返回');
  } finally {
    uninstallFakeDom();
  }
});
