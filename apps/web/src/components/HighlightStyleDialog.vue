<script setup lang="ts">
/**
 * **高亮样式对话框**（`#256` 一期，`#258` 补齐高级通道）—— 点已有高亮 → 动作栏「样式」弹出。
 *
 * ## 上游对照
 * 上游是 `HighlightStyleDialog`（BottomSheet，`HighlightStyleDialog.kt`）+ 布局
 * `dialog_highlight_style.xml`（预设行 `fl_presets` + 通道列表 `ll_channels` + 字体行）。
 * 结构一一对应：
 *   · `fl_presets`   → 本组件顶部的预设行（`HIGHLIGHT_PRESETS`，`#258` 起 **7 条**）
 *   · `ll_channels`  → 上游 9 个通道**全部**：
 *       底色（含形状 6 种）/ 文字色 / 粗 / 斜 / 下划线（线型+颜色+粗细+距离）/
 *       删除线（含色）/ 方框 / 着重号 / 文字阴影（含编辑）
 *   · 字体行          → **本仓是字体族下拉**（`#258`）
 *     上游是「本机字体文件」（`fontPath` + `Typeface.createFromFile` + `preserveTextAdvance`
 *     保持整行宽度），浏览器没有对应物 ⇒ 用 `fontFamily` 白名单（见 `utils/highlight-style.ts` 头部）
 * 上游点是「改一下就 `apply()` 一次」（实时生效），本组件同样是**改即发 `change`**
 * （没有「确定/取消」——用户看着正文里的那条高亮变，比看对话框里的预览更直观）。
 *
 * ## 为什么自己画预览条（对话框里再显示一段示例文字）
 * 正文里的高亮在对话框遮罩**下面**，被压暗、也离眼睛远。预览条用**同一套** `highlightStyleVars`
 * / `highlightClass`（与正文渲染**同一份实现**，不是另写一份演示逻辑）⇒ 预览不会骗人。
 *
 * ## 与「阅读样式的全局下划线」互不相干
 * 这里产出的样式**只属于这一条高亮**（存 `BookHighlight.style`），不读也不写
 * `GlobalReaderPrefs.underline*`（理由见 `utils/highlight-style.ts` 头注释）。
 */
import { computed, ref, watch } from 'vue';
import {
  HIGHLIGHT_BG_SWATCHES,
  HIGHLIGHT_DECO_SWATCHES,
  HIGHLIGHT_FILL_SHAPES,
  HIGHLIGHT_FONT_OPTIONS,
  HIGHLIGHT_LINE_SWATCHES,
  HIGHLIGHT_PRESETS,
  HIGHLIGHT_SHADOW_SWATCHES,
  HIGHLIGHT_TEXT_SWATCHES,
  HIGHLIGHT_UNDERLINE_OPTIONS,
  highlightClass,
  highlightStyleVars,
  isHighlightStyleEmpty,
  normalizeHighlightStyle,
  shadowValue,
  type HighlightDeco,
  type HighlightStyleView,
  type HighlightUnderlineKind,
} from '../utils/highlight-style';

const props = defineProps<{
  /** 当前这条高亮的样式（父组件已解析成对象） */
  style: HighlightStyleView;
  /** 这条高亮的文字 —— 预览条就画它，比画「示例文本」更贴切 */
  text?: string;
}>();
const emit = defineEmits<{ change: [style: HighlightStyleView]; close: [] }>();

/** 本地草稿：改的是副本，`change` 发出去后父组件才落库 */
const draft = ref<HighlightStyleView>({ ...props.style });
watch(() => props.style, (s) => { draft.value = { ...s }; });

function apply(patch: Partial<HighlightStyleView>): void {
  draft.value = normalizeHighlightStyle({ ...draft.value, ...patch });
  emit('change', { ...draft.value });
}

/** 点预设 = **整套替换**（上游 `buildPresets()` 的 `apply(preset)` 同样不合并） */
function applyPreset(i: number): void {
  draft.value = normalizeHighlightStyle({ ...HIGHLIGHT_PRESETS[i].style });
  emit('change', { ...draft.value });
}

/* ---------------- 底色 ---------------- */
const fillOn = computed(() => !!draft.value.fill);
function toggleFill(): void {
  apply({ fill: fillOn.value ? null : HIGHLIGHT_BG_SWATCHES[0] });
}
/** 自定义底色：`<input type=color>` 只能给**不透明**色 ⇒ 统一折成 50% 透明（上游 `withAlpha=true`） */
function fillFromHex(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},.5)`;
}

/* ---------------- 文字色 / 线色 ---------------- */
const textColorOn = computed(() => !!draft.value.textColor);
function toggleTextColor(): void {
  apply({ textColor: textColorOn.value ? null : HIGHLIGHT_TEXT_SWATCHES[0] });
}

/* ---------------- 下划线 ---------------- */
const ul = computed(() => draft.value.underline ?? null);
function toggleUnderline(): void {
  apply({
    underline: ul.value ? null : { kind: 'solid', color: null, width: 1, distance: 2 },
  });
}
function setUnderlineKind(kind: HighlightUnderlineKind | null): void {
  if (kind === null) { apply({ underline: null }); return; }
  const cur = ul.value ?? { kind, color: null, width: 1, distance: 2 };
  apply({ underline: { ...cur, kind } });
}
function setUnderlineColor(color: string | null): void {
  const cur = ul.value ?? { kind: 'solid' as const, color: null, width: 1, distance: 2 };
  apply({ underline: { ...cur, color } });
}
function setUnderlineNum(key: 'width' | 'distance', e: Event): void {
  const n = Number((e.target as HTMLInputElement).value);
  const cur = ul.value ?? { kind: 'solid' as const, color: null, width: 1, distance: 2 };
  // 非法输入（空 / 字母）⇒ 回落到该字段的默认值，不写 NaN 进 JSON
  apply({ underline: { ...cur, [key]: Number.isFinite(n) ? n : (key === 'width' ? 1 : 0) } });
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 193, 7];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* ---------------- 单色装饰：删除线 / 方框 / 着重号 ----------------
 * 上游这三个通道**共用同一个形状** `Deco(val color: Int)`（`HighlightStyle.kt:59`）
 * ⇒ 这里也用同一套读写函数（三份手写代码必然漂移）。
 */
type DecoKey = 'strike' | 'box' | 'emphasis';

/** 取某通道的 `Deco`。★ `strike` 在 `#256` 的老形态是**布尔** ⇒ 统一过一遍归一化再读 */
function decoOf(key: DecoKey): HighlightDeco | null {
  const v = (normalizeHighlightStyle(draft.value) as unknown as Record<DecoKey, unknown>)[key];
  return v && typeof v === 'object' ? (v as HighlightDeco) : null;
}
function decoOn(key: DecoKey): boolean {
  return !!draft.value[key];
}
function toggleDeco(key: DecoKey): void {
  // 开 = 给一个空 `Deco`（color 缺省 ⇒ 跟随文字色，上游 `Deco(color = 0)`）
  apply({ [key]: decoOn(key) ? null : {} } as Partial<HighlightStyleView>);
}
function setDecoColor(key: DecoKey, color: string | null): void {
  apply({ [key]: { color } } as Partial<HighlightStyleView>);
}

/**
 * ★★ 着重号是否被下划线挡住 —— 上游 `TextColumn.kt:95` / `TextHtmlColumn.kt:101`：
 * `style?.takeIf { it.underline == null }?.emphasis` ⇒ **只要有下划线通道，着重号就不画**
 * （两者都落在字下方，会重叠）。这里把开关**禁掉并说明原因**，
 * 而不是「让用户点半天没反应」（那正是 `#256` 反复强调的「别静默」）。
 * ⚠️ 判据是 `underline != null`，与「下划线会不会真的画出来（width > 0）」**无关**。
 */
const emphasisBlocked = computed(() => !!ul.value);

/**
 * 三个「单色装饰」通道在界面上的排列（上游 `HighlightStyleDialog.channels` 里也是三行同构的）。
 * 用数据驱动而不是**手抄三遍模板**：手抄必然漂移（`#248` 的教训：手写控件与被删 Tab 漂移）。
 */
const DECO_CHANNELS: ReadonlyArray<{ key: DecoKey; label: string; hint: string }> = [
  { key: 'strike', label: '删除线', hint: '一条直线划过文字' },
  { key: 'box', label: '方框', hint: '围住文字的矩形框（上游 box）' },
  { key: 'emphasis', label: '着重号', hint: '每个字下方一个圆点（上游 emphasis）' },
];

/** 三个通道的当前 `Deco`（只算一次；模板里直接用 `decos[key]?.color`） */
const decos = computed(() => ({
  strike: decoOf('strike'),
  box: decoOf('box'),
  emphasis: decoOf('emphasis'),
}));

/* ---------------- 文字阴影 / 外发光 ---------------- */
const shadowOn = computed(() => !!draft.value.shadow);
function toggleShadow(): void {
  apply({ shadow: shadowOn.value ? null : {} });
}
/** 三个数值字段：非法输入回落该字段的**默认值**（不是 0 —— 0 在 Android 侧根本不画阴影） */
function setShadowNum(key: 'radius' | 'dx' | 'dy', e: Event): void {
  const n = Number((e.target as HTMLInputElement).value);
  const cur = draft.value.shadow ?? {};
  apply({ shadow: { ...cur, [key]: Number.isFinite(n) ? n : shadowValue(cur, key) } });
}
function setShadowColor(color: string): void {
  apply({ shadow: { ...(draft.value.shadow ?? {}), color } });
}
/** 「外发光」= 偏移归 0（上游同一个 `setShadowLayer(radius, dx, dy, color)`，没有单独的 glow 通道） */
function makeGlow(): void {
  apply({ shadow: { ...(draft.value.shadow ?? {}), dx: 0, dy: 0 } });
}

/* ---------------- 字体 ---------------- */
function setFont(v: string): void {
  apply({ fontFamily: v || null });
}

/** 预览条上的文字：这条高亮的原文（截断，避免长段把对话框撑爆） */
const previewText = computed(() => (props.text && props.text.trim() ? props.text.trim().slice(0, 60) : '这段文字就是高亮效果预览'));
const previewVars = computed(() => highlightStyleVars(draft.value));
const previewClass = computed(() => ['rd-hl', ...highlightClass(draft.value)]);
/** 当前是无样式的空样式时提示一句（否则用户会以为「改了没反应」） */
// ★ 用 `isHighlightStyleEmpty`（与渲染**同一条判据**）而不是手抄一串 `!x &&`：
//   `#258` 加了 4 个通道，手抄版本必然漏（漏了的表现是「改了但提示还在」/「没改却提示」）
const isEmpty = computed(() => isHighlightStyleEmpty(draft.value));
</script>

<template>
  <div class="hls-mask" data-hls-dlg @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="hls" role="dialog" aria-modal="true">
      <div class="hls-head">
        <strong>高亮样式</strong>
        <span style="flex: 1"></span>
        <button class="btn mini" data-hls-close @click="emit('close')">关闭</button>
      </div>

      <div class="hls-body">
        <!-- 预览条：与正文渲染走**同一套** vars/class -->
        <div class="hls-preview-box">
          <span :class="previewClass" :style="previewVars" data-hls-preview>{{ previewText }}</span>
        </div>
        <p v-if="isEmpty" class="hls-note">当前是「没有样式」—— 正文会按默认样式（黄底 + 一条实线下划线）显示。</p>

        <!-- 预设：整套替换 -->
        <div class="hls-sec">
          <span class="hls-sec-label">预设</span>
          <div class="hls-presets">
            <button
              v-for="(p, i) in HIGHLIGHT_PRESETS" :key="p.label"
              class="hls-preset" :title="p.label" :data-hls-preset="i"
              @click="applyPreset(i)"
            >
              <span class="hls-preset-dot" :class="highlightClass(p.style)" :style="highlightStyleVars(p.style)">文</span>
              <span class="hls-preset-name">{{ p.label }}</span>
            </button>
          </div>
        </div>

        <!-- 底色 + 形状 -->
        <div class="hls-sec">
          <label class="hls-sec-label">
            <input type="checkbox" :checked="fillOn" data-hls-fill-toggle @change="toggleFill()" /> 底色
          </label>
          <div class="hls-controls">
            <button
              v-for="c in HIGHLIGHT_BG_SWATCHES" :key="c"
              class="hls-swatch" :class="{ on: draft.fill === c }" :style="{ background: c }"
              :data-hls-fill-swatch="c" :title="c" @click="apply({ fill: c })"
            ></button>
            <input
              type="color" class="hls-color" data-hls-fill-custom
              :value="draft.fill && draft.fill.startsWith('#') ? draft.fill : '#ffc107'"
              title="自定义底色（自动按 50% 透明度）"
              @input="apply({ fill: fillFromHex((($event.target as HTMLInputElement).value)) })"
            />
            <span class="hls-sep"></span>
            <button
              v-for="s in HIGHLIGHT_FILL_SHAPES" :key="s.value"
              class="hls-chip" :class="{ on: (draft.fillShape ?? 'rectangle') === s.value }"
              :data-hls-shape="s.value" @click="apply({ fillShape: s.value })"
            >{{ s.label }}</button>
          </div>
        </div>

        <!-- 文字色 -->
        <div class="hls-sec">
          <label class="hls-sec-label">
            <input type="checkbox" :checked="textColorOn" data-hls-text-toggle @change="toggleTextColor()" /> 文字色
          </label>
          <div class="hls-controls">
            <button
              v-for="c in HIGHLIGHT_TEXT_SWATCHES" :key="c"
              class="hls-swatch" :class="{ on: draft.textColor === c }" :style="{ background: c }"
              :data-hls-text-swatch="c" :title="c" @click="apply({ textColor: c })"
            ></button>
            <button class="hls-chip" :class="{ on: draft.textColor === null }" data-hls-text-none @click="apply({ textColor: null })">跟随</button>
            <input
              type="color" class="hls-color" data-hls-text-custom
              :value="draft.textColor && draft.textColor.startsWith('#') ? draft.textColor : '#d32f2f'"
              title="自定义文字色"
              @input="apply({ textColor: (($event.target as HTMLInputElement).value) })"
            />
          </div>
        </div>

        <!-- 粗 / 斜 -->
        <div class="hls-sec">
          <span class="hls-sec-label">文字</span>
          <div class="hls-controls">
            <button class="hls-chip" :class="{ on: !!draft.bold }" data-hls-bold @click="apply({ bold: !draft.bold })">加粗</button>
            <button class="hls-chip" :class="{ on: !!draft.italic }" data-hls-italic @click="apply({ italic: !draft.italic })">斜体</button>
          </div>
        </div>

        <!-- 下划线（线型 / 颜色 / 粗细 / 距离） -->
        <div class="hls-sec">
          <label class="hls-sec-label">
            <input type="checkbox" :checked="!!ul" data-hls-ul-toggle @change="toggleUnderline()" /> 下划线
          </label>
          <div class="hls-controls">
            <button
              v-for="o in HIGHLIGHT_UNDERLINE_OPTIONS" :key="String(o.value)"
              class="hls-chip" :class="{ on: (ul?.kind ?? null) === o.value }"
              :data-hls-ul-kind="String(o.value)" @click="setUnderlineKind(o.value)"
            >{{ o.label }}</button>
          </div>
          <div v-if="ul" class="hls-controls hls-sub">
            <button
              v-for="c in HIGHLIGHT_LINE_SWATCHES" :key="c"
              class="hls-swatch" :class="{ on: ul.color === c }" :style="{ background: c }"
              :data-hls-ul-color="c" :title="c" @click="setUnderlineColor(c)"
            ></button>
            <button class="hls-chip" :class="{ on: ul.color === null }" data-hls-ul-color-none @click="setUnderlineColor(null)">跟文字</button>
            <span class="hls-sep"></span>
            <label class="hls-num">
              粗细
              <input
                type="number" min="0" max="10" step="0.5" :value="ul.width ?? 1"
                data-hls-ul-width @change="setUnderlineNum('width', $event)"
              />
            </label>
            <label class="hls-num">
              距离
              <input
                type="number" min="0" max="30" step="1" :value="ul.distance ?? 0"
                data-hls-ul-distance @change="setUnderlineNum('distance', $event)"
              />
            </label>
            <span class="hls-hint">粗细 0 = 不画</span>
          </div>
        </div>

        <!-- 单色装饰：删除线 / 方框 / 着重号（上游共用 `Deco(color)`，界面结构同构 ⇒ 数据驱动） -->
        <div v-for="d in DECO_CHANNELS" :key="d.key" class="hls-sec">
          <label class="hls-sec-label">
            <input
              type="checkbox" :checked="decoOn(d.key)" :data-hls-deco="d.key"
              :disabled="d.key === 'emphasis' && emphasisBlocked"
              @change="toggleDeco(d.key)"
            /> {{ d.label }}
          </label>
          <div class="hls-controls">
            <button
              v-for="c in HIGHLIGHT_DECO_SWATCHES" :key="c"
              class="hls-swatch" :class="{ on: decos[d.key]?.color === c }" :style="{ background: c }"
              :data-hls-deco-swatch="d.key + ':' + c" :title="c"
              @click="setDecoColor(d.key, c)"
            ></button>
            <button
              class="hls-chip" :class="{ on: decoOn(d.key) && decos[d.key]?.color == null }"
              :data-hls-deco-follow="d.key" title="用这段文字自己的颜色"
              @click="setDecoColor(d.key, null)"
            >跟随文字</button>
            <input
              type="color" class="hls-color" :data-hls-deco-custom="d.key"
              :value="decos[d.key]?.color && decos[d.key]!.color!.startsWith('#') ? decos[d.key]!.color! : '#9e9e9e'"
              title="自定义颜色"
              @input="setDecoColor(d.key, (($event.target as HTMLInputElement).value))"
            />
            <span v-if="d.key === 'emphasis' && emphasisBlocked" class="hls-hint" data-hls-emphasis-blocked>
              已有下划线 ⇒ 着重号不显示（上游两者互斥：都落在字下方）
            </span>
            <span v-else class="hls-hint">{{ d.hint }}</span>
          </div>
        </div>

        <!-- 文字阴影 / 外发光 -->
        <div class="hls-sec">
          <label class="hls-sec-label">
            <input type="checkbox" :checked="shadowOn" data-hls-shadow @change="toggleShadow()" /> 文字阴影
          </label>
          <div v-if="draft.shadow" class="hls-controls">
            <button
              v-for="c in HIGHLIGHT_SHADOW_SWATCHES" :key="c"
              class="hls-swatch" :class="{ on: draft.shadow?.color === c }" :style="{ background: c }"
              :data-hls-shadow-swatch="c" :title="c" @click="setShadowColor(c)"
            ></button>
            <button class="hls-chip" data-hls-shadow-glow title="水平/垂直偏移归 0 ⇒ 四面发散（外发光）" @click="makeGlow()">
              外发光
            </button>
            <span class="hls-sep"></span>
            <label class="hls-num">
              模糊
              <input
                type="number" min="0" max="10" step="0.5" :value="shadowValue(draft.shadow, 'radius')"
                data-hls-shadow-radius @change="setShadowNum('radius', $event)"
              />
            </label>
            <label class="hls-num">
              右移
              <input
                type="number" min="-10" max="10" step="0.5" :value="shadowValue(draft.shadow, 'dx')"
                data-hls-shadow-dx @change="setShadowNum('dx', $event)"
              />
            </label>
            <label class="hls-num">
              下移
              <input
                type="number" min="-10" max="10" step="0.5" :value="shadowValue(draft.shadow, 'dy')"
                data-hls-shadow-dy @change="setShadowNum('dy', $event)"
              />
            </label>
          </div>
          <p v-else class="hls-hint">开启后可调模糊半径与偏移；点「外发光」把偏移归 0 就是四面发散。</p>
        </div>

        <!-- 字体（★ 本仓是**字体族**，上游是**本机字体文件**，见 utils/highlight-style.ts 头部） -->
        <div class="hls-sec">
          <span class="hls-sec-label">字体</span>
          <div class="hls-controls">
            <select
              class="hls-select" data-hls-font :value="draft.fontFamily ?? ''"
              @change="setFont((($event.target as HTMLSelectElement).value))"
            >
              <option value="">跟随正文</option>
              <option v-for="f in HIGHLIGHT_FONT_OPTIONS" :key="f.value" :value="f.value">{{ f.label }}</option>
            </select>
            <span class="hls-hint">上游是字体文件（Android 本地字体），浏览器改用系统字体族</span>
          </div>
        </div>

        <div class="hls-foot">
          <button class="btn mini" data-hls-reset @click="applyPreset(0)">重置为默认</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hls-mask {
  position: fixed; inset: 0; z-index: 1300; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-start; justify-content: center; padding: 5vh 16px;
}
.hls {
  width: min(520px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); box-shadow: var(--shadow);
}
.hls-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.hls-head strong { font-size: 15px; color: var(--text-0); }
.hls-body { padding: 12px 16px 16px; overflow: auto; }
.hls-preview-box {
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
  padding: 12px; font-size: 15px; line-height: 1.9; color: var(--text-0); word-break: break-all;
}
.hls-note { margin: 8px 0 0; font-size: 12px; color: var(--muted); }
.hls-sec { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
.hls-sec-label { font-size: 12px; color: var(--text-1); display: flex; align-items: center; gap: 4px; }
.hls-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hls-sub { margin-top: 2px; }
.hls-sep { width: 1px; height: 18px; background: var(--border-strong); margin: 0 2px; }
.hls-presets { display: flex; gap: 10px; flex-wrap: wrap; }
.hls-preset {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  background: none; border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; cursor: pointer;
}
.hls-preset:hover { border-color: var(--brand); }
.hls-preset-dot { font-size: 14px; padding: 1px 4px; }
.hls-preset-name { font-size: 11px; color: var(--muted); }
.hls-swatch {
  width: 24px; height: 24px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border-strong);
}
.hls-swatch.on { outline: 2px solid var(--brand); outline-offset: 1px; }
.hls-color { width: 30px; height: 24px; padding: 0; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-2); cursor: pointer; }
.hls-chip {
  font-size: 12px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
  background: var(--bg-2); color: var(--text-1); border: 1px solid var(--border-strong);
}
.hls-chip.on { background: var(--brand-soft); border-color: var(--brand); color: var(--brand); font-weight: 700; }
.hls-num { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-1); }
.hls-num input {
  width: 58px; background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border-strong);
  border-radius: 6px; padding: 3px 6px; font-size: 12px;
}
/* 字体下拉（`#258`） */
.hls-select {
  background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border-strong);
  border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer;
}
.hls-hint { font-size: 11px; color: var(--faint); }
.hls-foot { margin-top: 16px; display: flex; justify-content: flex-end; }

/* ── 形状（与正文 `.rd-hl-shape-*` 保持同一套数值）────────────────────
   预览条用的是 `highlightClass()` 产出的 `rd-hl-shape-*`，而那条 class 的样式定义在
   `ReaderOverlay.vue` 里（`scoped`）⇒ 这里必须**重复一份**，否则预览条只有底色、没有形状。
   ⚠️ 两处数值必须同步（改形状就得改两边）—— 这是 `scoped` 的代价，已在此注明。 */
.hls-preview-box :deep(.rd-hl-shape-rectangle) { border-radius: 0; }
.hls-preview-box :deep(.rd-hl-shape-rounded) { border-radius: 3px; }
.hls-preview-box :deep(.rd-hl-shape-pill) { border-radius: 999px; }
.hls-preview-box :deep(.rd-hl-shape-marker) {
  border-radius: 6px 10px 4px 12px / 10px 5px 12px 6px;
  padding: 1px 2px;
}
/* 下半 / 基线带（`#258`）：位置靠 inline 的 `background-image`，这里只管取消圆角 */
.hls-preview-box :deep(.rd-hl-shape-half),
.hls-preview-box :deep(.rd-hl-shape-baseline) { border-radius: 0; }
</style>
