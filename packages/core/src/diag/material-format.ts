/**
 * `#558` **物料格式化**：把取回来的页面 / 用户粘贴的内容排成人能读的样子。
 *
 * 用户口径：「取回的物料自动格式化；提供格式化按钮（用户粘贴内容也用）；自动识别 html/json」。
 *
 * ★★ 三条必须守住的：
 *  · **JSON 只是重排缩进**（`JSON.parse` → `stringify(…, 2)`），不删键、不换顺序、不补默认值。
 *    解析失败就**原样返回**并说明 —— 「看着像 JSON 但其实是 JS 字面量」的源很多，猜就是改坏。
 *  · **格式化只影响显示**，不回写物料（物料是源编辑的数据，改一个字就是改源）。
 *  · **绝不因格式化而丢内容**：解析不了、体积爆炸、抛异常 ⇒ 一律原样返回 + 说明原因。
 *
 * ## 为什么换成 `js-beautify`（`#681`）
 *
 * 用户问「有没有更美观的包」。实测对比（同一批真实页面）：
 *
 * | 方案 | 191KB 页面 | 行数 | 说明 |
 * |-|-|-|-|
 * | 自研（`#677` 那版） | 15~21ms | 4761 | 行内闭合标签被强行拆行（`</li>` 独占一行）⇒ 行数偏多、看着散 |
 * | `js-beautify` | 212ms | 3899 | 闭合标签跟随内容、`<style>/<script>` 各自成块、层级清晰 |
 * | `prettier` | 9.5MB 包 | — | 对**抓来的乱 HTML** 直接原样返回（它尊重空白敏感性），对本场景无效 |
 *
 * `js-beautify` 本来就在依赖里（`apps/web` 的 CodeField 高级编辑器用它美化 JS/JSON），
 * 所以这里**没有引入新包**。容错也实测过：坏 JS（缺右括号）、顶层 `return`、不闭合标签、
 * `</div>` 出现在 JS 字符串里 —— 全部不抛异常、内容不被改坏。
 *
 * ⚠️ 唯一要防的是**深层嵌套导致的体积膨胀**：`<div>` 套 5000 层时，输出 100MB（1.5s）。
 * 物料是站点给的，不能假设它规整 ⇒ `guard()` 里挡「输出超过输入 8 倍且超过 4MB」。
 */
import beautify from 'js-beautify';

export type MaterialKind = 'html' | 'json' | 'css' | 'js' | 'text';

export interface FormatResult {
  text: string;
  kind: MaterialKind;
  /** 是否真的改了（没改就说「已经是整齐的」，别假装做了事） */
  changed: boolean;
  /** 为什么没动 / 做了什么（原样返回时必须说明理由） */
  note?: string;
}

/** 输出体积上限（防止深层嵌套把一行缩进放大成几十 MB） */
const MAX_OUT_BYTES = 4_000_000;
/** 输出相对输入的倍数上限 */
const MAX_GROWTH = 8;

/**
 * 统一的「格式化 + 护栏」：抛异常 / 体积爆炸 / 结果为空 ⇒ 原样返回并说明。
 *
 * 一定要说明原因 —— 用户点了按钮却没变化时，沉默会被当成「按钮坏了」。
 */
function guard(
  input: string,
  kind: MaterialKind,
  run: () => string,
  why?: { grow?: string; empty?: string },
): FormatResult {
  let out = '';
  try {
    out = run();
  } catch (e) {
    return { text: input, kind, changed: false, note: `格式化失败，保持原样：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!out.trim()) {
    return { text: input, kind, changed: false, note: why?.empty ?? '格式化结果为空，保持原样' };
  }
  if (out.length > MAX_OUT_BYTES && out.length > input.length * MAX_GROWTH) {
    return {
      text: input,
      kind,
      changed: false,
      note:
        why?.grow ??
        `排版后体积膨胀到 ${Math.round(out.length / input.length)} 倍（${(out.length / 1048576).toFixed(1)}MB，多半是嵌套过深），`
          + '保持原样以免卡住界面',
    };
  }
  return { text: out, kind, changed: out !== input };
}

/**
 * HTML 排版（`js-beautify`）。
 *
 * 选项逐条都有理由：
 *  · `indent_inner_html: true` —— 否则 `<head>/<body>` 顶格、`<html>` 的子节点不缩进（默认行为很难看）；
 *  · `preserve_newlines: false` + `max_preserve_newlines: 0` —— 抓来的页面里换行是「源码排版」而非语义，
 *    保留它们会得到「空一行、一行」的碎片；HTML 里连续空白本就等价，压掉不改变语义；
 *  · `wrap_line_length: 0` —— **不按宽度重排**。物料的超长属性（签名、base64 图片）被折成十几行反而更难读，也不好和源码对照；
 *  · `content_unformatted: ['pre','textarea']` —— `<pre>` 里的空白是内容，一个字符都不能动；
 *  · `extra_liners: []` —— 默认会在 `</head>` / `<body>` 前插空行，物料查看器不需要那些空行。
 */
function formatHtml(text: string): FormatResult {
  return guard(text, 'html', () =>
    beautify.html(text, {
      indent_size: 2,
      indent_inner_html: true,
      wrap_line_length: 0,
      preserve_newlines: false,
      max_preserve_newlines: 0,
      content_unformatted: ['pre', 'textarea'],
      extra_liners: [],
      end_with_newline: false,
    }),
  );
}

/** CSS 排版（`js-beautify`）：选择器/声明各占一行，`@media` 内的块缩进 */
function formatCss(text: string): FormatResult {
  return guard(text, 'css', () =>
    beautify.css(text, {
      indent_size: 2,
      preserve_newlines: false,
      max_preserve_newlines: 0,
      end_with_newline: false,
    }),
  );
}

/**
 * JS 排版（`js-beautify`）。
 *
 * ★ 它能处理**语法不完整**的片段（源规则里的脚本常常是 `return …` 结尾的片段、或有语法错），
 * 因为它做的是「分词后重新拼空白」，不是把代码解析成 AST ⇒ 不会因为语法错就整个失败。
 * 也正因为如此，它**不会**改变字符串字面量内容（`"</div>"` 不会被当成标签）。
 */
function formatJs(text: string): FormatResult {
  return guard(text, 'js', () =>
    beautify.js(text, {
      indent_size: 2,
      preserve_newlines: false,
      max_preserve_newlines: 1,
      end_with_newline: false,
    }),
  );
}

function formatJson(text: string): FormatResult {
  const t = text.trim();
  try {
    const v = JSON.parse(t) as unknown;
    const pretty = JSON.stringify(v, null, 2);
    return { text: pretty, kind: 'json', changed: pretty !== text };
  } catch {
    // 解析不了就**不要动**：GSON 宽松语法（单引号/裸标识符）不是 JSON，重排一定会改坏
    return { text, kind: 'text', changed: false, note: '看着像 JSON 但解析不了（可能是 JS 字面量），保持原样' };
  }
}

/**
 * 自动识别 + 格式化。
 * `kind` 显式给出时**只按它格式化**（用户可能想强制当 JSON / JS 看），否则自动判定。
 */
export function formatMaterial(text: string, kind?: MaterialKind): FormatResult {
  if (!text.trim()) return { text, kind: kind ?? 'text', changed: false };
  const k = kind ?? detectMaterialKind(text);
  if (k === 'json') return formatJson(text);
  if (k === 'html') return formatHtml(text);
  if (k === 'css') return formatCss(text);
  if (k === 'js') return formatJs(text);
  const collapsed = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  /**
   * 「看着像 JSON 但解析不了」要说一句：用户粘贴 GSON 宽松语法（单引号 / 裸标识符）时，
   * 点格式化什么都不会发生 —— 不说清就成了「按钮没反应」。
   */
  const looksJson = /^[{[]/.test(text.trim());
  return {
    text: collapsed,
    kind: 'text',
    changed: collapsed !== text,
    ...(looksJson ? { note: '看着像 JSON 但解析不了（单引号 / 裸标识符是 GSON 宽松语法，不是 JSON），保持原样' } : {}),
  };
}

/**
 * 内容形态判定（`material-chain` 与本文件的格式化共用这一份判据）。
 *
 * ⚠️ **只自动判 html / json / text**：CSS 与 JS **不做自动判定** ——
 * 任意一段文字都「像 JS」，猜错就会把正常文本按代码重排（还会加缩进），比不格式化更糟。
 * 需要格式化 CSS/JS 时由调用方显式传 `kind`（物料查看器有「自动/HTML/CSS/JS/JSON」选择）。
 */
export function detectMaterialKind(text: string): MaterialKind {
  const t = text.trim();
  if (!t) return 'text';
  if (t.startsWith('<')) return 'html';
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t);
      return 'json';
    } catch {
      return 'text';
    }
  }
  return 'text';
}
