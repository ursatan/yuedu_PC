/**
 * 分页切片 → Canvas 纹理。
 *
 * 阅读器已经用 `paged-layout.ts` 把一章切成「页 + 段落字符区间」，这里直接用
 * **同一份段落文本 + 同一份排版参数**重绘到 canvas，不依赖 html2canvas：
 *   · 不需要把真实 DOM 复制/内联样式，成本固定；
 *   · 字体、字号、行高、字距、段距、四边内边距、缩进都必须与 `.rd-content` 一致
 *     （由调用方从 `getComputedStyle` 取真实解析值传进来，见 `ReaderOverlay` 的 `curlStyleOf`）；
 *   · 高亮背景 / 行内图片不在本绘制器里（它们要额外传 run 信息，见文件末尾说明）。
 */

export interface CurlPageStyle {
  background?: string;
  color?: string;
  fontFamily?: string;
  fontWeight?: string | number;
  fontSize?: number;
  /** 行高，**px**（`--rd-lh` 是 `calc(1em + Npx)`，必须取 `getComputedStyle` 的解析值） */
  lineHeight?: number;
  /** 字距，**px**（`getComputedStyle` 的 `letter-spacing` 解析值；`normal` 记 0） */
  letterSpacing?: number;
  /** 兼容字段：左右内边距的共同默认值 */
  paddingX?: number;
  /** 兼容字段：上下内边距的共同默认值 */
  paddingY?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  /** 段间距 = `.rd-content p` 的 `margin-bottom`（px） */
  paragraphSpacing?: number;
  titleSize?: number;
  titleColor?: string;
  titleFontFamily?: string;
  titleWeight?: string | number;
  /** 标题行高（px）；≤ 0 时按 1.25 × 字号 */
  titleLineHeight?: number;
  titleAlign?: 'left' | 'center' | 'right';
  titleMarginTop?: number;
  /** 兼容字段 = 标题下间距 */
  titleGap?: number;
  titleMarginBottom?: number;
  indent?: number;
  pageNoSize?: number;
  pageNoColor?: string;
  /** 标题被设置隐藏（`titleMode=2` ⇒ `display:none`）时传 `false`，纹理里就不画标题 */
  paintTitle?: boolean;
}

export interface PagedChunkInput {
  /** 段下标；`-1` = 章标题块（标题由 `TextPageInput.title` 单独画，这里跳过） */
  para: number;
  /** 段内起始字符（含） */
  start: number;
  /** 段内结束字符（不含） */
  end: number;
  /** 段中续片（不缩进） */
  cont: boolean;
}

export interface TextPageInput {
  width: number;
  height: number;
  dpr?: number;
  paragraphs: readonly string[];
  chunks: readonly PagedChunkInput[];
  title?: string | null;
  pageNo?: number;
  style?: CurlPageStyle;
}

const DEFAULT_FONT =
  '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif';

const DEFAULT_STYLE: Required<CurlPageStyle> = {
  background: '#fbf8f0',
  color: '#2c2a25',
  fontFamily: DEFAULT_FONT,
  fontWeight: 400,
  fontSize: 21,
  lineHeight: 34,
  letterSpacing: 0,
  paddingX: 74,
  paddingY: 64,
  paddingLeft: 74,
  paddingRight: 74,
  paddingTop: 64,
  paddingBottom: 64,
  paragraphSpacing: 8,
  titleSize: 27,
  titleColor: '#1f1d19',
  titleFontFamily: DEFAULT_FONT,
  titleWeight: 600,
  titleLineHeight: 36,
  titleAlign: 'left',
  titleMarginTop: 0,
  titleGap: 26,
  titleMarginBottom: 26,
  indent: 42,
  pageNoSize: 13,
  pageNoColor: 'rgba(44,42,37,0.38)',
  paintTitle: true,
};

interface WrappedLine {
  text: string;
  /** 该行相对左边距的额外缩进（只有首行非零） */
  indent: number;
}

/** 英文/数字连续段算一个断行单元（中文逐字断行；不把单词从中间劈开） */
function isWordCode(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c === "'" ||
    c === '’' ||
    c === '-' ||
    (c >= '\u00c0' && c <= '\u024f')
  );
}

/** 按「断行单元」切分（`Array.from` 保证代理对不会被劈成两半） */
function splitUnits(text: string): string[] {
  const cps = Array.from(text);
  const units: string[] = [];
  let i = 0;
  while (i < cps.length) {
    const c = cps[i]!;
    if (isWordCode(c)) {
      let j = i + 1;
      while (j < cps.length && isWordCode(cps[j]!)) j += 1;
      units.push(cps.slice(i, j).join(''));
      i = j;
    } else {
      units.push(c);
      i += 1;
    }
  }
  return units;
}

/**
 * 逐单元换行。**只有首行**扣掉 `firstIndent`——早先的实现把缩进扣在所有行上，
 * 结果每一行都少 42px，右边缘参差且与测量切页的口径不一致。
 */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  firstIndent: number,
  letterSpacing: number,
): WrappedLine[] {
  const lines: WrappedLine[] = [];
  const units = splitUnits(text);
  let cur = '';
  let curW = 0;
  let first = true;
  const avail = (): number => maxWidth - (first ? firstIndent : 0);
  const pushLine = (): void => {
    lines.push({ text: cur, indent: first ? firstIndent : 0 });
    first = false;
    cur = '';
    curW = 0;
  };

  for (const u of units) {
    const w = ctx.measureText(u).width + letterSpacing * Array.from(u).length;
    if (!cur && w > avail()) {
      // 单个单元比整行还宽（超长英文串）：逐字硬切
      for (const ch of Array.from(u)) {
        const cw = ctx.measureText(ch).width + letterSpacing;
        if (cur && curW + cw > avail()) pushLine();
        cur += ch;
        curW += cw;
      }
      continue;
    }
    if (cur && curW + w > avail()) pushLine();
    cur += u;
    curW += w;
  }
  if (cur) pushLine();
  return lines;
}

/**
 * 一行文字的**基线**偏移（从行盒顶部算起）。
 *
 * CSS 的半行距 = `(lineHeight − (ascent + descent)) / 2`，基线 = 半行距 + ascent。
 * 直接用 `fontBoundingBox*` 的字体度量，比「(行高 − 字号) / 2」准得多 ——
 * 后者在行高 34 / 字号 20 时会把整页文字整体下移 2~3px，翻页首尾会看出「跳一下」。
 */
function baselineOf(ctx: CanvasRenderingContext2D, lineHeight: number, fontSize: number): number {
  const m = ctx.measureText('中Hg');
  let asc = Number(m.fontBoundingBoxAscent);
  let desc = Number(m.fontBoundingBoxDescent);
  if (!Number.isFinite(asc) || !Number.isFinite(desc) || asc + desc <= 0) {
    asc = fontSize * 0.88;
    desc = fontSize * 0.12;
  }
  return Math.max(0, (lineHeight - (asc + desc)) / 2 + asc);
}

/** 把一页的段落切片重绘成纹理；返回 canvas（同源，可直接 texImage2D / drawImage） */
export function paintTextPage(input: TextPageInput): HTMLCanvasElement {
  const given = input.style ?? {};
  const st: Required<CurlPageStyle> = {
    ...DEFAULT_STYLE,
    ...given,
    // 旧字段（paddingX / paddingY / titleGap）只在没给逐边值时生效
    paddingLeft: given.paddingLeft ?? given.paddingX ?? DEFAULT_STYLE.paddingLeft,
    paddingRight: given.paddingRight ?? given.paddingX ?? DEFAULT_STYLE.paddingRight,
    paddingTop: given.paddingTop ?? given.paddingY ?? DEFAULT_STYLE.paddingTop,
    paddingBottom: given.paddingBottom ?? given.paddingY ?? DEFAULT_STYLE.paddingBottom,
    titleMarginBottom: given.titleMarginBottom ?? given.titleGap ?? DEFAULT_STYLE.titleMarginBottom,
    titleFontFamily: given.titleFontFamily ?? given.fontFamily ?? DEFAULT_STYLE.titleFontFamily,
    titleWeight: given.titleWeight ?? given.fontWeight ?? DEFAULT_STYLE.titleWeight,
  };

  const dpr = input.dpr ?? 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(input.width * dpr);
  canvas.height = Math.round(input.height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = st.background;
  ctx.fillRect(0, 0, input.width, input.height);

  // 纸边：极淡的一圈，让纹理边界不是硬切口
  ctx.strokeStyle = 'rgba(90,70,40,0.10)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, input.width - 1, input.height - 1);

  const contentW = Math.max(1, input.width - st.paddingLeft - st.paddingRight);
  const bottom = input.height - st.paddingBottom;
  let y = st.paddingTop;

  if (st.paintTitle && input.title) {
    y += st.titleMarginTop;
    const tlh = st.titleLineHeight > 0 ? st.titleLineHeight : st.titleSize * 1.25;
    ctx.fillStyle = st.titleColor;
    ctx.font = `${st.titleWeight} ${st.titleSize}px ${st.titleFontFamily}`;
    const lines = wrapLines(ctx, input.title, contentW, 0, 0);
    for (const ln of lines) {
      if (y + tlh > bottom) break;
      const tw = ctx.measureText(ln.text).width;
      const x =
        st.titleAlign === 'center'
          ? st.paddingLeft + (contentW - tw) / 2
          : st.titleAlign === 'right'
            ? st.paddingLeft + contentW - tw
            : st.paddingLeft;
      ctx.fillText(ln.text, x, y + baselineOf(ctx, tlh, st.titleSize));
      y += tlh;
    }
    y += st.titleMarginBottom;
  }

  ctx.fillStyle = st.color;
  ctx.font = `${st.fontWeight} ${st.fontSize}px ${st.fontFamily}`;

  for (const chunk of input.chunks) {
    if (chunk.para < 0) continue; // 章标题块由上面单独画
    const para = input.paragraphs[chunk.para] ?? '';
    const text = para.slice(chunk.start, chunk.end);
    if (!text) continue;
    const lines = wrapLines(ctx, text, contentW, chunk.cont ? 0 : st.indent, st.letterSpacing);
    for (const ln of lines) {
      if (y + st.lineHeight > bottom) break;
      ctx.fillText(ln.text, st.paddingLeft + ln.indent, y + baselineOf(ctx, st.lineHeight, st.fontSize));
      y += st.lineHeight;
    }
    if (y + st.lineHeight > bottom) break;
    y += st.paragraphSpacing;
  }

  if (input.pageNo != null) {
    ctx.fillStyle = st.pageNoColor;
    ctx.font = `${st.pageNoSize}px ${st.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.fillText(`— ${input.pageNo} —`, input.width / 2, input.height - 30);
    ctx.textAlign = 'left';
  }

  return canvas;
}

/** 纸张背面：稍微暗一点，叠一层正面的「透字」镜像，再加页码 */
export function paintBackOf(
  front: HTMLCanvasElement,
  opts?: { background?: string; bleed?: number; pageNo?: number },
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = front.width;
  canvas.height = front.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const w = front.width;
  const h = front.height;

  // 背面 = 同一张纸的另一面（底色跟随当前阅读主题，不再写死浅色 —— 夜间档会看出割裂）
  ctx.fillStyle = opts?.background ?? '#f3efe4';
  ctx.fillRect(0, 0, w, h);

  // 透字：正面镜像 + 极低不透明度（纸够厚时几乎看不见，这里保留 5% 的纸感）
  ctx.save();
  ctx.globalAlpha = opts?.bleed ?? 0.05;
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(front, 0, 0, w, h);
  ctx.restore();

  // 左缘（装订侧）一点压暗，避免背面像一张全新的纸
  const g = ctx.createLinearGradient(0, 0, w * 0.18, 0);
  g.addColorStop(0, 'rgba(70,55,30,0.10)');
  g.addColorStop(1, 'rgba(70,55,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w * 0.18, h);

  ctx.strokeStyle = 'rgba(90,70,40,0.08)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  if (opts?.pageNo != null) {
    ctx.fillStyle = 'rgba(44,42,37,0.28)';
    ctx.font = `13px "Songti SC", "SimSun", serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`— ${opts.pageNo} —`, w / 2, h - 30);
    ctx.textAlign = 'left';
  }
  return canvas;
}

/**
 * 边界说明：
 * · 段内高亮：`paged-layout` 的 chunk 只有字符区间，`ReaderOverlay` 还要把 `items`
 *   的 run 边界一起传进来才能画出底色；本文件暂不画高亮（文字位置与真实页一致）；
 * · 行内图片（`uiMarks`）：需要额外传图片位图与锚点，暂不画；
 * · 页面背景图（`--rd-bg-img`）：canvas 只画底色，背景图在卷曲期间会被底色替代；
 * · 若后续要求「像素级与 DOM 完全一致」，再评估 html2canvas（MIT，约 200KB gzip）
 *   并把它只放在**换页前的一次性纹理生成**里，而不是每帧。
 */
