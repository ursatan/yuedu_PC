/**
 * `#333` jsoup 仿真的**唯一 DOM 实现**（宿主侧：jsdom 活节点）。
 *
 * ## 为什么必须重做（旧实现的整类缺陷）
 * 旧模型是「**字符串快照**」：`select()` 返回 `{outerHTML, innerHTML, text, attrs}` POJO，
 * 每次子查询都拿 `outerHTML` 重新 `parseHtml`，`remove()` 靠「选择器 + 索引」在整篇文档里删。
 * 于是真实源脚本（次元小镇 ruleContent 是标准样本）**全线崩**：
 *   ① `doc.selectFirst('.content_left')` —— doc 上根本没有 selectFirst（报 `is not a function`）；
 *   ② `content.select('p').get(i).remove()` —— 索引 i 是相对 `content` 的，却拿去整篇文档删 ⇒ 误删；
 *   ③ `el.ownText()` / `el.getAllElements()` / `img.attr('style', v)`（**设值**）—— 全部缺失；
 *   ④ 删完 `content.html()` —— 快照是**删之前**的，改动看不见。
 *   ③ ④ 任何一种「字符串 + 索引」的补救都救不回来：节点在删除后 outerHTML 会变、索引会平移，
 *      **只有「节点身份」能跨越变更** —— 这就是本文件存在的理由。
 *
 * ## 设计
 * 节点身份 = `nid`（`JsoupDom` 内的自增 id，节点用 WeakMap 复用同一 id）。
 *  · **L1**：`makeElementList(dom, descs)` 直接持有 dom，方法全部**实时**读活节点；
 *  · **worker**：DOM 在宿主（jsdom 不可结构化克隆），worker 侧只拿 nid，每个方法经 RPC 回到**本类**。
 * ⇒ 两条路径共用**同一份**实现（铁律：同一判据写两处必然漂移）。
 *
 * 生命周期：`JsoupDom` 每次求值（L1 每 eval / worker 每个 evaluator）新建一份；
 * 另设 `CAP` 上限防止长生命周期求值器把节点表撑爆（超限丢最旧）。
 */
import { parseHtml } from '../dom';
import { selectJsoup } from './jsoup-select';
// `#563` abs:href 的绝对化用仓库唯一实现（铁律：同一判据不写两处）
import { resolveUrl } from '../net/url-resolve';

/** 一个 jsoup 元素的可序列化快照 + 身份（worker 侧只拿得到这个） */
export interface JsoupDesc {
  /** 节点身份；`null/undefined` 表示「无身份的旧描述符」（规则桥 `java.getElements` 产物） */
  nid: number | null;
  outerHTML: string;
  innerHTML: string;
  text: string;
  attrs: Record<string, string>;
}

export class JsoupDom {
  private nodes = new Map<number, Element>();
  private byNode = new WeakMap<Element, number>();
  /** parse 出来的原始 html：`html(id,'outer')` 用它决定要不要「脱壳」（见 unwrapDoc） */
  private orig = new Map<number, string>();
  private seq = 0;
  /** 节点表上限（超限从最旧开始丢；只影响很早以前的句柄，脚本不会同时持有几千个） */
  private static readonly CAP = 4096;

  private keep(n: Element): number {
    const id = ++this.seq;
    this.nodes.set(id, n);
    this.byNode.set(n, id);
    if (this.nodes.size > JsoupDom.CAP) {
      let drop = this.nodes.size - JsoupDom.CAP;
      for (const k of this.nodes.keys()) {
        this.nodes.delete(k);
        this.orig.delete(k);
        if (--drop <= 0) break;
      }
    }
    return id;
  }

  private idOf(n: Element): number {
    const hit = this.byNode.get(n);
    return hit === undefined ? this.keep(n) : hit;
  }

  private node(id: number): Element | undefined {
    return this.nodes.get(Number(id));
  }

  /**
   * `org.jsoup.Jsoup.parse(html[, baseUri])` ⇒ 返回根 nid。
   *
   * `#563` **baseUri 必须收下**：真 jsoup 的第二参是**文档基址**，`attr('abs:href')` 靠它
   * 把相对地址解成绝对地址。旧实现把它扔掉 ⇒ 所有 `abs:` 取值恒空串 —— 黄金屋的
   * bookList JS 里 `if(!u) continue` 于是每项都跳过，「手机 App 正常、PC 0 卡片」
   * （App 用真 jsoup，PC 用本仿真）。
   */
  parse(html: string, baseUri?: string): number {
    const h = String(html ?? '');
    const base = String(baseUri ?? '').trim();
    const id = this.keep(parseHtml(h, base || undefined).root);
    this.orig.set(id, h);
    return id;
  }

  /**
   * `#640` `new org.jsoup.nodes.Element(tag)` —— 造一个**游离元素**（不在任何文档里），返回 nid。
   *
   * ## 为什么需要（用户实测「刺猬书库 RULE_PARSE@parse · Cannot read properties of undefined
   * (reading 'Element')」）
   * 该源 jsLib 里 `mkCard()` 是标准 jsoup **卡片拼装**套路：
   * ```js
   * var div = new org.jsoup.nodes.Element('div');
   * var h3  = new org.jsoup.nodes.Element('h3');
   * h3.appendChild(a); div.appendChild(h3);
   * ```
   * 上游 `org.jsoup.nodes.Element` 是**真 Java 类**，可以 new；我们只补了
   * `org.jsoup.select.Elements`（`#528`）没补 `nodes.Element` ⇒ `org.jsoup.nodes` 是 undefined
   * ⇒ 读 `.Element` 就抛这个错，整条规则挂掉。
   *
   * 实现：借 jsdom 解析一个空壳 `<tag></tag>` 再取出该元素（这样它天然带完整 DOM API，
   * 与 `Jsoup.parse` 造出来的节点同一套语义）。`orig` 不登记 ⇒ `html()` 不会走「脱壳」分支。
   */
  createElement(tag: string): number {
    const t = String(tag ?? 'div').trim().replace(/[^\w:.-]/g, '') || 'div';
    const root = parseHtml(`<${t}></${t}>`, undefined).root as unknown as Element;
    const el =
      (root as unknown as { querySelector?: (s: string) => Element | null }).querySelector?.(t) ?? root;
    return this.keep(el as Element);
  }

  /**
   * `#640` `Element.appendChild(child)` —— 把 child **移动**到 parent 末尾
   * （DOM/jsoup 同一语义：移动而非复制；child 原先在别处会先被摘下来）。
   */
  append(parentNid: number, childNid: number): boolean {
    const p = this.node(parentNid);
    const c = this.node(childNid);
    if (!p || !c) return false;
    try {
      (p as unknown as { appendChild?: (n: Node) => void }).appendChild?.(c as unknown as Node);
      return true;
    } catch {
      return false;
    }
  }

  private descOf(n: Element): JsoupDesc {    const attrs: Record<string, string> = {};
    for (const a of Array.from((n as unknown as { attributes?: NamedNodeMap }).attributes ?? [])) {
      attrs[a.name] = a.value;
    }
    const nid = this.idOf(n);
    return {
      nid,
      outerHTML: (n as unknown as { outerHTML?: string }).outerHTML ?? '',
      innerHTML: (n as unknown as { innerHTML?: string }).innerHTML ?? '',
      /**
       * `#745` 必须与 `text(nid)` **同一判据**：解析根（`orig` 登记过的 nid）取 body 文本，
       * 否则 `<head><title>` 的文字会混进根元素。worker 侧的读缓存直接复用这个字段
       * （与 `text()` 逐字相等才敢用），两处判据不能分叉。
       */
      text: this.text(nid),
      attrs,
    };
  }

  /** `Element.select(css)`：只查**后代**（jsoup 语义，不含自身） */
  select(id: number, sel: string): JsoupDesc[] {
    const root = this.node(id);
    if (!root) return [];
    const s = String(sel ?? '').trim();
    const els = s && s !== '*' ? selectJsoup(root, s) : Array.from(root.querySelectorAll('*'));
    return els.map((e) => this.descOf(e));
  }

  /** `Element.getAllElements()`：自身 + 全部后代（jsoup 语义含自身） */
  selectAll(id: number): JsoupDesc[] {
    const root = this.node(id);
    if (!root) return [];
    return [root, ...Array.from(root.querySelectorAll('*'))].map((e) => this.descOf(e));
  }

  /**
   * `html()`：实时序列化（删除/改属性后**立刻**可见 —— 旧快照模型做不到）。
   *
   * 「脱壳」：jsdom 会把片段 `<a>x</a>` 补成完整文档，而旧实现 `doc.html()` 返回**原始输入**。
   * 为不破坏既有源（大量 `return doc` / `doc.html()` 期望拿到片段），
   * 仅当**原始输入里没有 `<html`** 时，把 `<html>…<body>(…)</body></html>` 的外壳剥掉。
   */
  html(id: number, kind: 'outer' | 'inner' = 'outer'): string {
    const n = this.node(id);
    if (!n) return '';
    const u = n as unknown as { outerHTML?: string; innerHTML?: string };
    if (kind === 'inner') return u.innerHTML ?? '';
    let out = u.outerHTML ?? '';
    const o = this.orig.get(Number(id));
    if (o !== undefined && !/<html[\s>]/i.test(o)) {
      const m = /^\s*<html[^>]*>\s*(?:<head[^>]*>[\s\S]*?<\/head>\s*)?<body[^>]*>([\s\S]*)<\/body>\s*<\/html>\s*$/i.exec(out);
      if (m && m[1] !== undefined) out = m[1];
    }
    return out;
  }

  /** `Element.text()`；doc 上取 body（与旧实现 `jsoupSelect(h,'body')[0].text` 对齐） */
  text(id: number): string {
    const n = this.node(id);
    if (!n) return '';
    if (this.orig.has(Number(id))) {
      const body = n.querySelector('body');
      return ((body ?? n).textContent ?? '').trim();
    }
    return (n.textContent ?? '').trim();
  }

  /** `Element.ownText()`：只取**直接子文本节点**（jsoup 语义，不含后代元素的文字） */
  ownText(id: number): string {
    const n = this.node(id);
    if (!n) return '';
    let out = '';
    for (const c of Array.from(n.childNodes ?? [])) {
      if ((c as unknown as { nodeType?: number }).nodeType === 3) out += c.textContent ?? '';
    }
    return out.trim();
  }

  attr(id: number, name: string): string {
    const n = this.node(id);
    if (!n) return '';
    const raw = String(name ?? '');
    /**
     * `#563` jsoup 的 **`abs:` 属性协议**（`Element.absUrl`，`attr('abs:href')` 即它）：
     * 把属性值按**文档基址**解成绝对地址 —— 基址来自 `Jsoup.parse(html, baseUri)` 的第二参
     * （jsdom 侧由 `parseHtml(h, base)` 写进 `document.baseURI`，`<base href>` 标签也由 jsdom 一并处理，
     * 与真 jsoup 的 `Document.baseUri` 语义一致）。属性为空 / 基址缺失 / 解析失败 ⇒ 如实返回 `''`
     * （真 jsoup 的 `absUrl` 同样返回空串）。
     */
    if (/^abs:/i.test(raw)) {
      const v = ((n as unknown as { getAttribute?: (k: string) => string | null }).getAttribute?.(raw.slice(4)) ?? '').trim();
      if (!v) return '';
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v; // 已是绝对地址：原样（resolveUrl 同判据）
      const doc = (n as unknown as { ownerDocument?: { baseURI?: string } }).ownerDocument;
      const base = String(doc?.baseURI ?? '');
      if (!base || base === 'about:blank') return '';
      return resolveUrl(base, v);
    }
    const v = (n as unknown as { getAttribute?: (k: string) => string | null }).getAttribute?.(raw);
    return v ?? '';
  }

  /** `Element.attr(k, v)` 的**设值**形态（旧模型完全没有 ⇒ `img.attr('style', …)` 静默失效） */
  setAttr(id: number, name: string, value: string): void {
    const n = this.node(id);
    if (!n) return;
    (n as unknown as { setAttribute?: (k: string, v: string) => void }).setAttribute?.(String(name ?? ''), String(value ?? ''));
  }

  /** `Node.remove()`：按**身份**删，不受索引平移影响；批量即 `Elements.remove()` */
  remove(ids: number[]): void {
    for (const raw of ids ?? []) {
      const n = this.node(Number(raw));
      if (!n) continue;
      (n as unknown as { remove?: () => void }).remove?.();
    }
  }

  /**
   * `#528` `Element.clone()`：**深拷贝**，返回**新身份**（脱离原树）。
   *
   * jsoup 语义：`clone()` 得到一份独立副本（不插入任何父节点）。源里常见
   * 「克隆一份 → 在副本上删掉某些子节点 → 读 text」的净化套路（找书啦 ruleToc 用它去掉徽标）。
   */
  clone(id: number): number {
    const n = this.node(id);
    if (!n) return 0;
    const c = (n as unknown as { cloneNode: (deep: boolean) => Element }).cloneNode(true);
    return this.keep(c);
  }

  /**
   * `#528` `Element.text(String)` 的**设值形态**（此前只有 getter ⇒ 静默失效）。
   * jsoup 会清空子节点再放入一个文本节点；用 `textContent =` 等价（纯文本场景逐字一致）。
   */
  setText(id: number, text: string): void {
    const n = this.node(id);
    if (!n) return;
    n.textContent = String(text ?? '');
  }

  /** `#528` `Element.child(index)`：第 index 个**子元素**（跳过文本节点）；越界返回 null */
  child(id: number, index: number): JsoupDesc | null {
    const n = this.node(id);
    if (!n) return null;
    const kids = Array.from((n as unknown as { children?: ArrayLike<Element> }).children ?? []);
    const k = kids[Number(index)];
    return k ? this.descOf(k) : null;
  }

  /** `#528` 按 nid 取描述符（`Element.clone()` 造出的新元素要能立刻包装成可链式对象） */
  /**
   * `#673` **兄弟节点导航**（jsoup `Element.nextSibling()` / `previousSibling()` 的底座）。
   *
   * 返回 `{ nid }`（兄弟是元素，可继续当 Element 用）或 `{ text }`（兄弟是文本/注释节点）。
   * 为什么必须区分：源码里大量 `selectFirst('i.fa-eye').nextSibling().text()`，
   * 而 `<i></i> 1234` 的下一个兄弟**是文本节点**（媚色MM 的 viewCount 就这么写）
   * ⇒ 只支持元素会让整条 §kind 规则 `RULE_PARSE@parse`。
   */
  siblingNode(id: number, dir: 1 | -1): { nid?: number; text?: string } | null {
    const n = this.node(id);
    if (!n) return null;
    const s = (dir > 0 ? n.nextSibling : n.previousSibling) as Node | null;
    if (!s) return null;
    if (s.nodeType === 1) return { nid: this.idOf(s as Element) };
    return { text: String(s.nodeValue ?? '') };
  }

  /** `#673` jsoup `Element.parent()` / `Node.parentNode`：父**元素**的 nid（越界 null） */
  parentId(id: number): number | null {
    const p = (this.node(id)?.parentElement ?? null) as Element | null;
    return p ? this.idOf(p) : null;
  }

  /** `#673` jsoup `Element.siblingElements()`：同一父下**除自己以外**的元素 */
  siblingIds(id: number): number[] {
    const n = this.node(id);
    const p = (n?.parentElement ?? null) as Element | null;
    if (!n || !p) return [];
    return Array.from(p.children as unknown as Element[])
      .filter((c) => c !== n)
      .map((c) => this.idOf(c));
  }

  descById(id: number): JsoupDesc | undefined {
    const n = this.node(id);
    return n ? this.descOf(n) : undefined;
  }
}
