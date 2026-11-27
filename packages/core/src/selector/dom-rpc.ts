/**
 * `#743` org.jsoup RPC 的**唯一实现**（宿主 / DOM worker 两处共用）。
 *
 * 为什么抽出来：A 轮把 DOM 后端（jsdom 活节点）搬进常驻 worker 后，worker 内必须能
 * 执行**同一份** op 分派；若在 worker 里再写一份 switch，L1/worker/后台三条路径就会漂移
 * —— 这正是 `#333` 铁律禁止的。因此这里只做「`JsoupDom` 上的 op → 返回值」，
 * 不持有任何传输细节（宿主直接调，worker 用 postMessage 调，语义完全相同）。
 *
 * ⚠️ 节点身份：`JsoupDom` 实例 = 一棵/多棵活树的节点表（`nid` 自增）。**同一个求值器
 * 的所有 dom op 必须打到同一个实例**；因此 A 轮把**全部** op 转发到 backend，而不是
 * 只转发 `parse/select/html/text/attr`（拆表会让 `remove/append/clone` 拿到陌生 nid）。
 */
import { recordBlock } from '../diag/block-stats';
import { unescapeHtml4 } from './html-format';
import { JsoupDom, type JsoupDesc } from './jsoup-dom';
import { selectJsoup } from './jsoup-select';
import { parseHtml } from '../dom';

const htmlTreeCache = new WeakMap<object, Map<string, number>>();

/** `op:'select'` 的「无 nid」分支：取（或建）该 html 的缓存树，再按 jsoup 语义选。 */
function selectOnHtmlTree(dom: JsoupDom, html: string, sel: string): JsoupDesc[] {
  let m = htmlTreeCache.get(dom as unknown as object);
  if (!m) {
    m = new Map<string, number>();
    htmlTreeCache.set(dom as unknown as object, m);
  }
  let nid = m.get(html);
  if (nid == null) {
    nid = dom.parse(html);
    if (m.size >= 16) m.clear();
    m.set(html, nid);
  }
  const hit = dom.select(nid, sel);
  if (hit.length) return hit;
  /**
   * 兜底：`dom.select` 空而纯函数能命中（少数伪类/离奇选择器）时退回旧路径。
   * 注意这条结果**没有 nid**（后续 remove 对它无效）——只在「新路径一个都没命中」时发生，
   * 目的只是不让 `#108` 以来的可用性回退。
   */
  return jsoupSelect(html, sel) as unknown as JsoupDesc[];
}

/** `org.jsoup.Jsoup.select` 的**纯函数**实现（无节点身份；仅作为 `select` 的兜底）。 */
export function jsoupSelect(html: string, selector: string): Array<{ outerHTML: string; innerHTML: string; text: string; attrs: Record<string, string> }> {
  const root = parseHtml(String(html ?? '')).root;
  const els = selector && selector !== '*'
    ? selectJsoup(root, selector)
    : [root, ...Array.from(root.querySelectorAll('*'))];
  return els.map((e) => {
    const attrs: Record<string, string> = {};
    for (const a of Array.from((e as unknown as { attributes?: NamedNodeMap }).attributes ?? [])) {
      attrs[a.name] = a.value;
    }
    return { outerHTML: (e as unknown as { outerHTML: string }).outerHTML ?? '', innerHTML: (e as unknown as { innerHTML: string }).innerHTML ?? '', text: (e.textContent ?? '').trim(), attrs };
  });
}

export interface DomRpcArgs {
  op?: string;
  html?: string;
  /** `#563` Jsoup.parse 的文档基址（abs:href 的绝对化用） */
  baseUri?: string;
  sel?: string;
  idx?: number;
  nid?: number;
  nids?: number[];
  kind?: string;
  name?: string;
  value?: string;
  text?: string;
  /** `#640` `org.jsoup.nodes.Element(tag)` 的标签名 */
  tag?: string;
  /** `#640` `appendChild` 的子节点 nid（`nid` 是父节点） */
  child?: number;
}

/** `op:'describe'` / `op:'describeAll'` 的单元素实现：**实时**读 nid 对应的值。 */
function describeLive(dom: JsoupDom, nid: number): JsoupDesc | null {
  const d = dom.descById(nid);
  if (!d || d.nid === null || d.nid === undefined) return null;
  const id = d.nid;
  return { nid: id, outerHTML: dom.html(id, 'outer'), innerHTML: dom.html(id, 'inner'), text: dom.text(id), attrs: d.attrs };
}

/**
 * 执行一次 dom op。`dom` 为空（无 DOM 后端）时返回空值，与旧行为一致。
 * `track` 为 true 时把这次调用记进 `dom-select`（仅**宿主内执行**时调用；worker 路径
 * 由 backend 记 `dom-async`，避免把异步等待混进「主线程阻塞」口径）。
 */
export function handleDomCall(dom: JsoupDom | null | undefined, args: unknown, track = true): unknown {
  const a = (args ?? {}) as DomRpcArgs;
  const t0 = Date.now();
  // `#773` 临时取证（默认关）：`op=parse` 的长耗时一直没有输入尺寸可查，
  // 只能看到「dom-select 22494ms / parse」——补上 htmlLen / 节点数 / 输出数才能对上页面。
  const trace = process.env.YUEDU_DOM_TRACE === '1';
  try {
    if (!dom) return [];
    const op = String(a.op ?? '');
    // `#563` baseUri 一并传给 JsoupDom（abs:href 的绝对化基址）
    if (op === 'parse') return dom.parse(String(a.html ?? ''), typeof a.baseUri === 'string' && a.baseUri.trim() ? a.baseUri.trim() : undefined);
    /**
     * `#522` worker 侧 `org.jsoup.parser.Parser.unescapeEntities` 回宿主解码
     * （worker 模板里没有 commons-text 实体表，且不该再写第二份 ⇒ 走这条 RPC）。
     */
    if (op === 'unescapeEntities') return unescapeHtml4(String(a.text ?? ''));
    if (op === 'select') {
      /**
       * `#646` **无 nid 的列表也要有稳定身份**：按 HTML 文本缓存一棵游离树，同一份 html
       * 复用同一棵树 ⇒ 元素身份稳定，后续 remove/html/htmlAll 都作用在这棵树上。
       * 缓存上限 16 棵（一次规则求值里 html 文本个数是常数级），超了整表清空。
       */
      if (a.nid == null) return selectOnHtmlTree(dom, String(a.html ?? ''), String(a.sel ?? ''));
      return dom.select(Number(a.nid), String(a.sel ?? ''));
    }
    if (op === 'selectAll') return dom.selectAll(Number(a.nid));
    /** `#528` `Element.clone()` → **新元素描述符**（worker 侧 `mkList([d])[0]` 直接包成元素） */
    if (op === 'clone') return dom.descById(dom.clone(Number(a.nid))) ?? null;
    /** `#528` `Element.text(String)` 设值形态 */
    if (op === 'setText') { dom.setText(Number(a.nid), String(a.text ?? '')); return ''; }
    /** `#528` `Element.child(index)` → 描述符（越界 null） */
    if (op === 'child') return dom.child(Number(a.nid), Number(a.idx)) ?? null;
    /** `#523` 按 nid 取单个描述符（`document.documentElement` / `getElementsByTagName` 需要「解析根自身」） */
    if (op === 'desc') return dom.descById(Number(a.nid)) ?? null;
    if (op === 'html') return dom.html(Number(a.nid), a.kind === 'inner' ? 'inner' : 'outer');
    /**
     * `#743` **活节点整体回流**（A 轮的跨线程收尾）。
     *
     * 场景：`#531` 的「JS 返回 Elements」——worker 里 `attr(k,v)` 写过之后把元素交回宿主，
     * 宿主必须拿到**写完之后的**值。`__yueduSendable` 送的 `__desc` 是 select 时的**快照**
     * （那时还没写），所以宿主不能直接用快照的 outerHTML 重建，而要按 nid 向节点表要一次
     * **实时**的 `outerHTML/innerHTML/text/attrs`。
     * 注意：这里的 nid 属于**执行该 op 的那张表**（宿主直连时是宿主表；A 轮整段转发时
     * 是 DOM worker 表），所以调用方随后必须把返回值 parse 回自己那张表（见 js.ts
     * `rehydrateWorkerJsoup`），不能把 nid 直接带过去。
     */
    if (op === 'describe') return describeLive(dom, Number(a.nid));
    /**
     * `#745` **批量 describe**（一次往返取 N 个活描述，逐项可为 null）。
     *
     * 为什么必须批量：`#531` 的「JS 返回 Elements」收尾要按 nid 逐个要实时描述 ——
     * 1500 个元素就是 1500 次跨线程往返；而每次往返都要等宿主事件循环，量级上比
     * 解析本身还贵。批量后一次往返即可（宿主再一次性 parse 回自己的表，见 js.ts
     * `rehydrateWorkerJsoup`）。
     */
    if (op === 'describeAll') {
      const list = Array.isArray(a.nids) ? (a.nids as unknown[]) : [];
      return list.map((id) => {
        const n = Number(id);
        return Number.isFinite(n) ? describeLive(dom, n) : null;
      });
    }
    /** `#745` 批量实时 text（一次往返取 N 个元素；未知/越界 nid 给空串） */
    if (op === 'textAll') {
      const list = Array.isArray(a.nids) ? (a.nids as unknown[]) : [];
      return list.map((id) => dom.text(Number(id)));
    }
    /**
     * `#745` 批量 `Elements.select(sel)`：逐元素子查询后**拼接**成一条结果。
     *
     * 与 worker 侧逐元素 `rpc('select')` 的结果顺序/内容完全一致（同一个 `dom.select`），
     * 只是把 N 次往返压成 1 次 —— 正文规则里 `paragraphs.select(...)` 是常见写法。
     */
    if (op === 'selectList') {
      const list = Array.isArray(a.nids) ? (a.nids as unknown[]) : [];
      const out: JsoupDesc[] = [];
      for (const id of list) {
        const n = Number(id);
        if (Number.isFinite(n)) out.push(...dom.select(n, String(a.sel ?? '')));
      }
      return out;
    }
    /** `#646` 批量实时 outerHTML（一次往返取 N 个元素；未知/越界 nid 给空串） */
    if (op === 'htmlAll') {
      const list = Array.isArray(a.nids) ? (a.nids as unknown[]) : [];
      return list.map((id) => {
        const n = Number(id);
        return Number.isFinite(n) ? dom.html(n, 'outer') : '';
      });
    }
    if (op === 'text') return dom.text(Number(a.nid));
    if (op === 'ownText') return dom.ownText(Number(a.nid));
    if (op === 'attr') return dom.attr(Number(a.nid), String(a.name ?? ''));
    if (op === 'setAttr') {
      dom.setAttr(Number(a.nid), String(a.name ?? ''), String(a.value ?? ''));
      return '';
    }
    /** `#745` 批量写属性（`Elements.attr(k, v)` 一次往返写完 N 个元素） */
    if (op === 'setAttrAll') {
      const list = Array.isArray(a.nids) ? (a.nids as unknown[]) : [];
      const name = String(a.name ?? '');
      const value = String(a.value ?? '');
      for (const id of list) {
        const n = Number(id);
        if (Number.isFinite(n)) dom.setAttr(n, name, value);
      }
      return '';
    }
    if (op === 'remove') {
      dom.remove((Array.isArray(a.nids) ? a.nids : [a.nid]).map(Number));
      return '';
    }
    /** `#640` `new org.jsoup.nodes.Element(tag)` → 新元素 nid（游离节点） */
    if (op === 'create') return dom.createElement(String(a.tag ?? 'div'));
    /** `#640` `Element.appendChild(child)`（child 走 `child` 字段，`nid` 是父节点） */
    if (op === 'append') { dom.append(Number(a.nid), Number(a.child)); return ''; }
    return [];
  } finally {
    // 埋点：jsdom 是**同步 CPU**（宿主直接阻塞）—— 量出来才好判断要不要再优化。
    const ms = Date.now() - t0;
    if (track) recordBlock('dom-select', ms, `${String(a.op ?? '')} ${String(a.sel ?? '')}`);
    if (trace) {
      console.log(
        `[dom-op] op=${JSON.stringify(String(a.op ?? ''))} sel=${JSON.stringify(String(a.sel ?? '').slice(0, 60))} `
        + `htmlLen=${String(a.html ?? '').length} nid=${a.nid ?? '-'} ${ms}ms`,
      );
    }
  }
}
