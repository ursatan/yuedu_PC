<script setup lang="ts">
/**
 * **阅读样式面板**（`#223` 重构）。
 *
 * ## 为什么整体重写而不是接着加分类
 * 用户 2026-10-03 报「部分功能失效、共用布局丢失、预设不生效」。逐条查下来：
 *  · **预设不生效**的真因在**颜色写死在白天槽**（真修复体是 `utils/read-style-presets.ts`，
 *    对齐上游 `ReadBookConfig.kt:1075-1094` 的「按当前模式写对应槽」）；
 *  · 「共用布局丢失」是这个面板的老设计（`shareLayout` 一个开关同时管「改谁的」和「显隐」），
 *    换新 Tab 架构时一并拆开。
 * 继续在旧结构上加 Tab，只会把这两处病根留在里面。
 *
 * ## 七个 Tab（用户 2026-10-03 指定的划分）
 * 排版｜字体｜简繁｜边距｜信息｜动画｜样式预设
 *  · **信息** Tab 是 `#221` 新增页眉/页脚之后的归属地（显隐 + 三段信息位 + 模板 + 字号/颜色/分隔线）。
 *  · 章节标题与下划线归入**排版**（Legado 也把它们当排版项）。
 *  · 移动端硬件专属项（电量图标等）保留占位符但不给默认模板，见契约注释。
 */
import { computed, ref, watch } from 'vue';
import type { ReadStyleKey, ReadStyleOverride } from '@yuedu/core/contract';
import { READ_TIP_OPTIONS, READER_INFO_PLACEHOLDERS, TIP_LINE_STYLE_OPTIONS, tipTextSizeOf } from '@yuedu/core/contract';
import { useReaderStore } from '../stores/reader';
import { UNDERLINE_MODE_OPTIONS } from '../styles/reader-theme';
import { toRrGgBb } from '../styles/ui-theme';
import { CHINESE_CONVERT_OPTIONS } from '../utils/chinese-convert';
import { redirectPresetColors } from '../utils/read-style-presets';
// `#224` 用户自定义预设（双击进编辑器；读写与白名单校验都在那个模块里）
import {
  addUserPreset, loadUserPresets, removeUserPreset, saveUserPresets, updateUserPreset,
  type UserPreset,
} from '../utils/read-style-user-presets';
// `#224` 翻页动画档位文案（`PageAnim.kt:9-17`）
import { PAGE_ANIM_OPTIONS } from '../utils/reader-view-mode';
// `#249` 内置背景图清单（14 张照抄上游 `assets/bg/`）+ 取值解析 + 本机图片体积上限
import { READER_BG_IMAGES, isBuiltinBgId, MAX_LOCAL_BG_BYTES } from '../utils/reader-bg';

const props = withDefaults(defineProps<{ target?: 'global' | 'book' }>(), { target: 'global' });
const reader = useReaderStore();

/**
 * 「共用布局」开 ⇒ 改全局默认（所有书共用）；关 ⇒ 改当前书的覆盖。
 *
 * ## 上游依据（`ReadBookConfig.kt:434`）
 * `val config get() = if (shareLayout) shareConfig else durConfig`
 * —— 上游是**同一个开关**决定「读哪一份配置」：共用时读 `shareConfig`（全局），
 * 不共用时读 `durConfig`（**这本书**的，即书籍条目上的覆盖层）。
 * 本仓的表达与之同构：`prefs.shareLayout` = 共用；`ShelfBook.readStyle` = 本书覆盖。
 *
 * ★ 顺带说明上游那个覆盖层的形态：`Book.readConfig: ReadConfig?`（`Book.kt:124`）是
 * **书籍实体上的可选覆盖层**，19 个字段**全部可空**（`pageAnim: Int?` …），
 * 「可空」就是「不覆盖，用全局」（`Book.kt:198-204` 的 `config` getter 只是懒初始化兜底）。
 * ⚠️ 上游那个 `ReadConfig` **不含字号/字距/行距/颜色** ⇒ 「每本书独立排版」在上游没有对应实体，
 * 本仓的 `ShelfBook.readStyle` 是**显式标注的扩展字段**（理由见契约 `readStyle` 的长注释）。
 */
const effectiveTarget = computed<'global' | 'book'>(() =>
  reader.prefs.shareLayout ? 'global' : props.target,
);

/**
 * ★★ `#248-B` **「共用布局」只管「样式预设」这一个 Tab**（用户 2026-10-03 22:00 明确）：
 * 「共用布局复选框，**针对的是样式预设，不包含其他样式 Tab**（排版/字体/简繁/边距/信息/标题/动画）
 * 的设置项，其他样式 Tab 的设置是**默认应用全部书籍**」。
 *
 * ## 为什么原来那样是错的
 * 原来 `effectiveTarget` 是**整个面板共用一个开关** ⇒ 取消勾选后，排版/字体/边距……
 * **全都跟着写成本书覆盖**。后果有两层：
 * ① 用户只想给一本书调字号，结果那本书的**颜色/下划线**也悄悄变成了「这本书专用」；
 * ② 覆盖一旦写上，本书的颜色就**不再跟全局**（`mergeReadStyle` 覆盖优先）
 *    ⇒ 这正是用户报的「**只有『病宠成瘾』这本书的样式不生效**」：
 *    它被写过一次覆盖（9 个颜色键 + 下划线 + 透明度），之后改全局对它没有任何作用，
 *    而其余书 `readStyle` 为 `null` ⇒ 全部跟全局 ⇒ 全部生效。
 *
 * ## 所以
 * `scopedByShare` 决定「这次提交要不要看共用布局开关」：**只有预设区为 true**，
 * 其余 Tab 一律走全局（`patchReadStyle`）。
 */
const PRESET_ONLY_TAB = 'preset';

/** 这次提交是否受「共用布局」开关管（`#248-B`：只有样式预设） */
function scopedByShare(sectionKey: string): boolean {
  return sectionKey === PRESET_ONLY_TAB;
}

/**
 * 当前模式的人话说明（复选框旁边那行；`#247`：原来只有复选框、没有说明 ⇒ 用户看不出它在管什么）。
 *
 * ⚠️ **不带「共用布局：」/「本书覆盖：」前缀** —— 模板里已经在 `<b>` 里写了模式名，
 *   前缀重复会显示成「本书覆盖：本书覆盖：…」（探针实测抓到）。
 * ⚠️ `#248-B` 措辞已改成**只讲样式预设**（别让用户以为排版/边距也归它管）。
 */
const shareHint = computed(() =>
  reader.prefs.shareLayout
    ? '所有书籍共用一套预设（背景 / 文字 / 强调色 / 下划线 / 透明度）。取消勾选可只给这一本书单独设置。'
    : '预设只在本书生效，其他书不受影响。勾选后所有书共用。',
);

const src = computed<Record<string, unknown>>(() =>
  effectiveTarget.value === 'book'
    ? (reader.readStyle as unknown as Record<string, unknown>)
    : (reader.prefs as unknown as Record<string, unknown>),
);

/** 本书覆盖模式下，书不在书架 ⇒ 没有地方存覆盖 */
const blocked = computed(() => effectiveTarget.value === 'book' && !reader.canOverrideReadStyle);

/**
 * 提交一次改动。
 * @param sectionKey 改的是哪个 Tab —— 决定**要不要看共用布局开关**（`#248-B`，见 `scopedByShare`）。
 */
function commit(patch: ReadStyleOverride, sectionKey = activeSection.value): void {
  const byBook = scopedByShare(sectionKey) && effectiveTarget.value === 'book';
  if (byBook && !reader.canOverrideReadStyle) return;
  if (byBook) reader.patchBookReadStyle(patch);
  else reader.patchReadStyle(patch);
}

const TEXT_BOLD_OPTIONS = [
  { value: '0', label: '正常' },
  { value: '1', label: '粗体' },
  { value: '2', label: '细体' },
] as const;

const INDENT_OPTIONS = [
  { value: '', label: '无缩进' },
  { value: '　', label: '1 个全角空格' },
  { value: '　　', label: '2 个全角空格' },
] as const;

const TITLE_MODE_OPTIONS = [
  { value: '0', label: '居左' },
  { value: '1', label: '居中' },
  { value: '2', label: '隐藏' },
  { value: '3', label: '居右' },
] as const;

const UNDERLINE_OPTIONS = UNDERLINE_MODE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }));

/**
 * `#224` 翻页动画选项。
 *
 * ★ 原先这里有一份**本地** `PAGE_ANIM_OPTIONS`，且第一项写的是
 *   「滚动（连续滚动，滚动条在窗口最右侧）」—— 那其实是**视图模式**（`#224` 已独立出去），
 *   混进「翻页动画」里就是**假设置**（滚动模式下另外四档不参与渲染）。
 * ⇒ 档位表统一搬到 `utils/reader-view-mode.ts`（与 `PageAnim.kt:9-17` 一一对应 + 每档一句说明），
 *   这里只做「数字 → 字符串」的转换，因为 `FieldDef.options` 要的是字符串值。
 */
const PAGE_ANIM_FIELD_OPTIONS = PAGE_ANIM_OPTIONS.map((o) => ({
  value: String(o.value),
  label: o.label,
  hint: o.hint,
}));

/** 页眉/页脚显示模式（`ReadTipConfig.getHeaderModes` / `getFooterModes`） */
const HEADER_MODE_OPTIONS = [
  { value: '0', label: '自动隐藏（向下滚动时收起）' },
  { value: '1', label: '始终显示' },
  { value: '2', label: '隐藏' },
] as const;
const FOOTER_MODE_OPTIONS = [
  { value: '0', label: '显示' },
  { value: '1', label: '隐藏' },
] as const;

/**
 * 字体候选（`#223` 字体 Tab）。
 *
 * ⚠️ Web 与 Android 的根本差别：Legado 存的是**设备上的字体名**，本仓在浏览器里，
 * 用户机器上**没有**那些字体 ⇒ 直接照搬上游字体名会得到「设了但看不出变化」。
 * 所以这里给的是「Windows/Chromium 上基本都有的字体族 + CSS 通用族」，
 * 并保留**自定义输入**（用户可以粘任何 font-family 串，`cssFontFamily` 会补回退）。
 */
const FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '系统默认' },
  { value: 'system-ui', label: '系统界面字体' },
  { value: '"Microsoft YaHei"', label: '微软雅黑' },
  { value: '"SimSun"', label: '宋体' },
  { value: '"SimHei"', label: '黑体' },
  { value: '"KaiTi"', label: '楷体' },
  { value: '"FangSong"', label: '仿宋' },
  { value: 'serif', label: '衬线（serif）' },
  { value: 'sans-serif', label: '无衬线（sans-serif）' },
  { value: 'monospace', label: '等宽（monospace）' },
  { value: '"Source Han Serif SC"', label: '思源宋体' },
  { value: '"Noto Serif CJK SC"', label: 'Noto 宋体' },
];

/** 文字颜色和背景预设（照抄上游 `defaultData/readConfig.json` 的 6 套命名样式） */
const READ_STYLE_PRESETS = [
  { key: 'wechat', label: '微信读书', patch: { bgStr: '#c0edc6', textColor: '#0b0b0b', textAccentColor: '#E53935', bgStrNight: '#000000', textColorNight: '#ADADAD', textAccentColorNight: '#FE4D55', bgStrEInk: '#FFFFFF', textColorEInk: '#000000', textAccentColorEInk: '#000000', bgAlpha: 100,underlineMode: 0, underlineColor: null, underlineWidth: 1, underlineDistance: 2, underlineBodyEnabled: false, underlineTitleEnabled: false, textSize: 24, textBold: 0, letterSpacing: 0, lineSpacingExtra: 10, paragraphIndent: '　　', paragraphSpacing: 6, paddingTop: 5, paddingBottom: 4, paddingLeft: 22, paddingRight: 22, titleMode: 0, titleSize: 4, titleTopSpacing: 0, titleBottomSpacing: 0, headerMode: 0, footerMode: 0, showHeaderLine: true, showFooterLine: true, headerPaddingTop: 10, headerPaddingLeft: 19, headerPaddingRight: 16, headerPaddingBottom: 0, footerPaddingTop: 0, footerPaddingLeft: 13, footerPaddingRight: 17, footerPaddingBottom: 10, tipColor: '#606060', tipHeaderLeft: 1, tipHeaderMiddle: 0, tipHeaderRight: 2, tipFooterLeft: 7, tipFooterMiddle: 0, tipFooterRight: 6 } },
  { key: 'p1', label: '预设1', patch: { bgStr: '#FFFFFF', textColor: '#000000', textAccentColor: '#E53935', bgStrNight: '#000000', textColorNight: '#FFFFFF', textAccentColorNight: '#FE4D55', bgStrEInk: '#FFFFFF', textColorEInk: '#000000', textAccentColorEInk: '#000000', bgAlpha: 100,underlineMode: 0, underlineColor: null, underlineWidth: 1, underlineDistance: 2, underlineBodyEnabled: false, underlineTitleEnabled: false } },
  { key: 'p2', label: '预设2', patch: { bgStr: '#DDC090', textColor: '#3E3422', textAccentColor: '#834E00', bgStrNight: '#3C3F43', textColorNight: '#DCDFE1', textAccentColorNight: '#FE4D55', bgStrEInk: '#FFFFFF', textColorEInk: '#000000', textAccentColorEInk: '#000000', bgAlpha: 100,underlineMode: 0, underlineColor: null, underlineWidth: 1, underlineDistance: 2, underlineBodyEnabled: false, underlineTitleEnabled: false } },
  { key: 'p3', label: '预设3', patch: { bgStr: '#C2D8AA', textColor: '#596C44', textAccentColor: '#E53935', bgStrNight: '#3C3F43', textColorNight: '#88C16F', textAccentColorNight: '#FE4D55', bgStrEInk: '#FFFFFF', textColorEInk: '#000000', textAccentColorEInk: '#000000', bgAlpha: 100,underlineMode: 0, underlineColor: null, underlineWidth: 1, underlineDistance: 2, underlineBodyEnabled: false, underlineTitleEnabled: false } },
  { key: 'p4', label: '预设4', patch: { bgStr: '#DBB8E2', textColor: '#68516C', textAccentColor: '#801314', bgStrNight: '#3C3F43', textColorNight: '#F6AEAE', textAccentColorNight: '#90BFF5', bgStrEInk: '#FFFFFF', textColorEInk: '#000000', textAccentColorEInk: '#000000', bgAlpha: 100,underlineMode: 0, underlineColor: null, underlineWidth: 1, underlineDistance: 2, underlineBodyEnabled: false, underlineTitleEnabled: false } },
  { key: 'p5', label: '预设5', patch: { bgStr: '#ABCEE0', textColor: '#3D4C54', textAccentColor: '#E53935', bgStrNight: '#3C3F43', textColorNight: '#90BFF5', textAccentColorNight: '#FE4D55', bgStrEInk: '#FFFFFF', textColorEInk: '#000000', textAccentColorEInk: '#000000', bgAlpha: 100,underlineMode: 0, underlineColor: null, underlineWidth: 1, underlineDistance: 2, underlineBodyEnabled: false, underlineTitleEnabled: false } },
] as const;

/**
 * 应用预设：★ **颜色按当前生效的颜色集重定向**（`#223` 的真修复体）。
 * 用户在夜间主题点预设，改白天的槽是**看不见效果**的 —— 上游正是按当前模式写槽
 * （`ReadBookConfig.kt:1075-1094`），这里对齐它。
 */
function applyPreset(p: (typeof READ_STYLE_PRESETS)[number]): void {
  commit(redirectPresetColors(p.patch as ReadStyleOverride, reader.readerColorSetName));
}

/* ---------------- `#224` **样式预设编辑器**（双击预设）----------------
 * ## 交互约定（用户口径：「双击进入编辑」）
 * · **单击** = 应用（保持原行为，用户天天在用，不能变）
 * · **双击** = 打开编辑器（改这套预设的三个颜色 + 改名 + 删除 / 另存）
 * · 内置 6 套**不可删**（它们照抄上游 `defaultData/readConfig.json`），
 *   但**可以「另存为」**成一条自定义的（不污染内置常量）。
 * · 面板顶部提供「＋ 新建」，从**当前生效的颜色**起手 —— 这是最快的路径：
 *   用户已经调好一套满意的配色，存下来即可，不必再一个个点色盘。
 */
const userPresets = ref<UserPreset[]>(loadUserPresets());
const editorOpen = ref(false);
/** 正在编辑的预设（`null` = 编辑器关着） */
const editing = ref<UserPreset | null>(null);
/** 新建时的草稿（还没有 id/createdAt） */
const draft = ref<{ name: string; patch: ReadStyleOverride }>({ name: '', patch: {} });

/**
 * 编辑器里的三个颜色槽，按**当前颜色集**取（与 `redirectPresetColors` 同一条口径）。
 * 索引 0=白天 / 1=夜间 / 2=墨水屏，**顺序不能变**（与契约里的 `bgStr / bgStrNight / bgStrEInk` 一致）。
 */
const EDITOR_COLOR_SET: ReadonlyArray<readonly [string, string, string]> = [
  ['bgStr', 'textColor', 'textAccentColor'],
  ['bgStrNight', 'textColorNight', 'textAccentColorNight'],
  ['bgStrEInk', 'textColorEInk', 'textAccentColorEInk'],
] as const;

const editorSlot = computed(() => {
  const set = reader.readerColorSetName === 'eink' ? 2 : reader.readerColorSetName === 'night' ? 1 : 0;
  return { keys: EDITOR_COLOR_SET[set]!, set };
});

function currentColor(key: string): string {
  const v = (src.value as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? (v as string) : '#FFFFFF';
}

/** 打开编辑器：编辑已有的 / 以当前配色新建 */
function openEditor(p: UserPreset | null): void {
  if (p) {
    editing.value = p;
    draft.value = { name: p.name, patch: { ...p.patch } };
  } else {
    editing.value = null;
    const k = editorSlot.value.keys;
    draft.value = {
      name: '',
      patch: {
        [k[0]]: currentColor(k[0]),
        [k[1]]: currentColor(k[1]),
        [k[2]]: currentColor(k[2]),
      } as ReadStyleOverride,
    };
  }
  editorOpen.value = true;
}
function closeEditor(): void {
  editorOpen.value = false;
  editing.value = null;
}

/**
 * 保存。
 *
 * ★ `#248-B` 原来只保存**三个颜色**，其余字段一律丢弃 ⇒ 用户在编辑器里调下划线/透明度，
 *   保存后什么都没变（这是「预设编辑改了没反应」的一半原因）。现在按
 *   {@link PRESET_FIELDS} **逐字段**保存，颜色类**只写当前颜色集那三个槽**
 *   （与 `redirectPresetColors` 同一纪律 —— 写另外两套等于替用户决定夜间长什么样）。
 */
function savePreset(): void {
  const patch: Record<string, unknown> = {};
  for (const f of PRESET_FIELDS) {
    const raw = (draft.value.patch as Record<string, unknown>)[f.key];
    if (raw === undefined) continue; // 没动过的字段不进 patch（合并语义：不覆盖）
    if (f.kind === 'color') {
      // 颜色：只认当前颜色集的槽，且必须是合法 6 位 hex
      // ★ 放宽到 3/4/6/8 位：上游预设的颜色是 **8 位 ARGB**（`#ffc0edc6`），
      //   只认 6 位会把它们**静默丢弃**（用户看到「存了但颜色没变」）。
      if (typeof raw === 'string' && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw)) patch[f.key] = raw;
      else if (raw === null) patch[f.key] = null; // 「跟随正文色」是合法取值
    } else if (f.kind === 'num') {
      if (Number.isFinite(Number(raw))) patch[f.key] = Number(raw);
    } else {
      patch[f.key] = raw; // sel 的 string / bool 的 boolean
    }
  }
  if (!Object.keys(patch).length) {
    window.alert('还没有设置任何项 —— 存一个空预设没有意义。');
    return;
  }
  // ★★ `#249` **背景图片单独并进来**：它不在 `PRESET_FIELDS` 里（那一组是「颜色+下划线+透明度」），
  //   但用户要求「预设里能配背景」⇒ 保存时必须带上，否则选了图一保存就没了。
  //   ⚠️ **体积如实提示**：内置图只存 id（几十字节），但**本机图片是 data URL**（≈原体积 1.37 倍），
  //   localStorage 约 5MB ⇒ 存 4~5 张大图就会写失败，而 `saveUserPresets` 写失败**只返回旧列表**（不抛）。
  const bgRaw = (draft.value.patch as Record<string, unknown>)[pfBgImgKey()];
  if (typeof bgRaw === 'string' && bgRaw) patch[pfBgImgKey()] = bgRaw;
  else if (bgRaw === null) patch[pfBgImgKey()] = null;
  const bgHeavy = typeof bgRaw === 'string' && bgRaw.startsWith('data:image');
  if (bgHeavy) {
    const kb = Math.round(bgRaw.length / 1024);
    if (!window.confirm(`这个预设会内嵌一张约 ${kb}KB 的本机图片。\n预设存在浏览器本地存储（上限约 5MB），存太多会写不进去。\n\n仍要保存吗？`)) return;
  }
  const list = editing.value
    ? updateUserPreset(userPresets.value, editing.value.id, patch as ReadStyleOverride)
    : addUserPreset(userPresets.value, draft.value.name, patch as ReadStyleOverride);
  const saved = saveUserPresets(list);
  // ★ `saveUserPresets` 写失败时**原样返回旧列表**（不抛）—— 所以要比对内容才知道存上没有。
  //   否则隐私模式 / 配额满时用户会以为「保存了」，刷新后才发现没了（本地书那条链路踩过同类坑）。
  const persisted = saved.length === list.length && saved.every((p, k) => p.id === list[k]?.id);
  userPresets.value = saved;
  window.alert(persisted ? '预设已保存。' : '⚠️ 没能存到本机（浏览器隐私模式或存储已满）—— 这次改动刷新后会丢。');
  closeEditor();
}

/** 内置预设「另存为」：起手色 = 内置那套在**当前颜色集**下的三个值 */
function forkBuiltin(p: (typeof READ_STYLE_PRESETS)[number]): void {
  const k = editorSlot.value.keys;
  const patch: Record<string, unknown> = { ...(p.patch as Record<string, unknown>) };
  // 内置预设的颜色写的是**白天**槽（`read-style-presets.ts` 的定义即如此），
  // 另存为自建预设时按当前颜色集重定向，否则「我在夜间另存」会存下一个白天的背景。
  for (let i = 0; i < 3; i += 1) {
    const v = (p.patch as Record<string, unknown>)[EDITOR_COLOR_SET[0]![i]!];
    if (typeof v === 'string') patch[k[i]!] = v;
  }
  editing.value = null;
  draft.value = { name: `${p.label} 副本`, patch: patch as ReadStyleOverride };
  editorOpen.value = true;
}

function deletePreset(id: string): void {
  const target = userPresets.value.find((p) => p.id === id);
  if (!target) return;
  if (!window.confirm(`删除预设「${target.name}」？\n（内置预设不受影响）`)) return;
  userPresets.value = saveUserPresets(removeUserPreset(userPresets.value, id));
  if (editing.value?.id === id) closeEditor();
}

/** 编辑器里改色（`:color` 的 input 事件） */
function onEditorColor(key: string, e: Event): void {
  draft.value = { ...draft.value, patch: { ...draft.value.patch, [key]: (e.target as HTMLInputElement).value } as ReadStyleOverride };
}
function onEditorName(e: Event): void {
  draft.value = { ...draft.value, name: (e.target as HTMLInputElement).value };
}

/* ---------------- `#248-B` 预设编辑器的字段读写 ----------------
 * 颜色三槽需要**重定向**（白天的键 → 当前颜色集对应的键），其余字段**原样**。
 * 这一层是刻意分开的：`redirectPresetColors` 管「应用时怎么重定向」，
 * 这里管「编辑器里读写的是哪个键」—— 两条都靠同一份 `EDITOR_COLOR_SET`，不会漂移。
 */

/** 白天槽键 → 当前颜色集的实际键（`bgStr` 在夜间是 `bgStrNight`，其余原样） */
function pfColorKey(dayKey: string): string {
  const k = editorSlot.value.keys;
  const i = (EDITOR_COLOR_SET[0] as readonly string[]).indexOf(dayKey);
  return i >= 0 ? k[i]! : dayKey;
}

/** 编辑器读颜色：取当前颜色集那一槽；没有就用 `currentColor`（取生效值）兜底 */
function editorColorOf(dayKey: string): string | null {
  const raw = (draft.value.patch as Record<string, unknown>)[pfColorKey(dayKey)];
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

/** 编辑器读数值：没设就用**当前生效值**（这样滑块起点是用户眼前的值，不是 0） */
function editorNumOf(key: string): number {
  const raw = (draft.value.patch as Record<string, unknown>)[key];
  if (Number.isFinite(Number(raw))) return Number(raw);
  const cur = (src.value as Record<string, unknown>)[key];
  return Number.isFinite(Number(cur)) ? Number(cur) : 0;
}

/** 编辑器读枚举 / 布尔 */
function editorRawOf(key: string): unknown {
  return (draft.value.patch as Record<string, unknown>)[key];
}

/** 「跟随正文色」是否勾上（颜色为 `null`） */
function isEditorFollowing(dayKey: string): boolean {
  return (draft.value.patch as Record<string, unknown>)[pfColorKey(dayKey)] === null;
}
function toggleEditorFollow(dayKey: string): void {
  const k = pfColorKey(dayKey);
  draft.value = { ...draft.value, patch: { ...draft.value.patch, [k]: null } as ReadStyleOverride };
}

function onEditorNum(key: string, e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  draft.value = { ...draft.value, patch: { ...draft.value.patch, [key]: Number.isFinite(v) ? v : 0 } as ReadStyleOverride };
}
function onEditorRaw(key: string, v: unknown): void {
  draft.value = { ...draft.value, patch: { ...draft.value.patch, [key]: v } as ReadStyleOverride };
}

/* ---------------- `#249` 背景图片 ---------------- */

/**
 * 背景图字段的**当前颜色集**键（白天 `bgImgPath` / 夜间 `bgImgPathNight` / 墨水屏 `bgImgPathEInk`）。
 *
 * ★ 与颜色槽不同：**图片键本身就是三套，没有「白天的键」需要重定向**
 *   （`pfColorKey` 处理的是 `bgStr` → `bgStrNight` 那一族）。
 *   保持两套函数分开，别为了「统一」把图片也塞进 `EDITOR_COLOR_SET` ——
 *   那个表的语义是「同一槽的三套颜色」，图片是三个独立字段。
 */
function pfBgImgKey(): ReadStyleKey {
  const set = editorSlot.value.set;
  return (set === 2 ? 'bgImgPathEInk' : set === 1 ? 'bgImgPathNight' : 'bgImgPath') as ReadStyleKey;
}

/** 当前值的显示名（内置图给中文名，data URL 给出体积，http 给域名） */
function bgImgLabel(v: string): string {
  if (isBuiltinBgId(v)) return `内置图「${v}」`;
  if (/^data:image\//i.test(v)) return `本机图片（约 ${Math.round(v.length / 1024)} KB，data URL）`;
  if (/^https?:\/\//i.test(v)) {
    try { return `网络图片 ${new URL(v).host}`; } catch { return '网络图片'; }
  }
  return '（无效值）';
}

/* ---------------- `#250` 常驻背景调节区（写生效值，不进编辑器 draft） ---------------- */

/**
 * 当前生效的背景图（`null` = 纯色）。
 *
 * ★ 读 `reader.readStyle`（**生效值**）而不是 `src`：这一区是直接改当前配色，
 *   显示的必须是「现在到底用的哪张图」，否则用户会看到「选了这张但显示的是另一张」。
 */
function bgImgValue(): string | null {
  const v = src.value[pfBgImgKey()];
  return typeof v === 'string' && v ? v : null;
}

/** 写背景图。`null` = 清除（回到纯色）。 */
function setBgImg(v: string | null): void {
  commit({ [pfBgImgKey()]: v } as ReadStyleOverride);
}

/** 生效的背景图片不透明度（0–100；非法值回落 100，理由同 store 的 `clampBgAlpha`） */
function bgAlphaValue(): number {
  const v = src.value.bgAlpha;
  if (v === null || v === undefined || typeof v === 'boolean') return 100;
  if (typeof v === 'string' && v.trim() === '') return 100;
  const n = Number(v);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}

function onQuickBgAlpha(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  if (!Number.isFinite(v)) return;
  commit({ bgAlpha: Math.min(100, Math.max(0, v)) } as ReadStyleOverride);
}

function nudgeBgAlpha(delta: number): void {
  applyValue('bgAlpha', Math.min(100, Math.max(0, bgAlphaValue() + delta)));
}

/**
 * 本机图片 → data URL **直接写到生效值**（常驻区版；编辑器里那份走 draft）。
 *
 * ⚠️ 体积上限同口径（`MAX_LOCAL_BG_BYTES` 400KB）：预设走 localStorage，
 *   base64 约是原体积的 1.37 倍；写失败是**静默**的 ⇒ 必须在这里挡住并如实提示。
 */
function onQuickLocalBg(e: Event): void {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  el.value = ''; // 允许重复选同一个文件
  if (!f) return;
  if (f.size > MAX_LOCAL_BG_BYTES) {
    window.alert(`图片 ${Math.round(f.size / 1024)}KB 超过 ${Math.round(MAX_LOCAL_BG_BYTES / 1024)}KB 上限 —— 请压缩后再选。`);
    return;
  }
  const fr = new FileReader();
  fr.onload = () => setBgImg(String(fr.result));
  fr.onerror = () => window.alert('读取图片失败。');
  fr.readAsDataURL(f);
}

/**
 * 本机图片 → data URL 写进 draft。
 *
 * ⚠️ 限额 {@link MAX_LOCAL_BG_BYTES}（400KB，与界面壁纸同一口径）：预设走 localStorage，
 * 一张 base64 约等于原体积的 1.37 倍；不设限会把 localStorage 写爆，**而且失败是静默的**
 * （`saveUserPresets` 写失败只返回旧列表）⇒ 必须在这里挡住并如实提示。
 */
function onLocalBgFile(e: Event): void {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  el.value = ''; // 允许重复选同一个文件
  if (!f) return;
  if (f.size > MAX_LOCAL_BG_BYTES) {
    window.alert(`图片 ${Math.round(f.size / 1024)}KB 超过 ${Math.round(MAX_LOCAL_BG_BYTES / 1024)}KB 上限 —— 请压缩后再选。`);
    return;
  }
  const fr = new FileReader();
  fr.onload = () => onEditorRaw(pfBgImgKey(), String(fr.result));
  fr.onerror = () => window.alert('读取图片失败。');
  fr.readAsDataURL(f);
}

/** 编辑器滑块改动 ⇒ **实时预览**（`#248-B`：实时生效是硬要求） */
watch(draft, () => {
  if (!editorOpen.value || blocked.value) return;
  const patch = editorColorRedirect(draft.value.patch);
  if (Object.keys(patch).length) commit(patch);
}, { deep: true });

/** 把 draft 里白天的颜色键重定向到当前颜色集（其余键原样） */
function editorColorRedirect(patch: ReadStyleOverride): ReadStyleOverride {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const isColorSlot = (EDITOR_COLOR_SET[0] as readonly string[]).includes(k);
    out[isColorSlot ? pfColorKey(k) : k] = v;
  }
  return out as ReadStyleOverride;
}

/* ---------------- 字段定义（数据驱动渲染） ---------------- */

type FieldDef =
  | { kind: 'num'; key: ReadStyleKey | 'chineseConverterType'; label: string; min: number; max: number; step?: number; unit?: string; nullable?: boolean }
  | {
      kind: 'sel';
      key: ReadStyleKey | 'chineseConverterType';
      label: string;
      options: readonly { value: string; label: string }[];
    }
  | { kind: 'bool'; key: ReadStyleKey | 'chineseConverterType'; label: string }
  | { kind: 'color'; key: ReadStyleKey | 'chineseConverterType'; label: string; nullable?: boolean }
  | { kind: 'text'; key: ReadStyleKey | 'chineseConverterType'; label: string; placeholder?: string };

/** 信息 Tab 的三段（页眉/页脚 × 左中右） */
function tipFields(zone: 'header' | 'footer'): FieldDef[] {
  const z = zone === 'header' ? 'Header' : 'Footer';
  const out: FieldDef[] = [];
  for (const pos of ['Left', 'Middle', 'Right'] as const) {
    out.push({ kind: 'sel', key: `tip${z}${pos}` as ReadStyleKey, label: `${pos === 'Left' ? '左' : pos === 'Middle' ? '中' : '右'}侧内容`, options: READ_TIP_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })) });
    out.push({ kind: 'text', key: `tip${z}${pos}Template` as ReadStyleKey, label: `${pos === 'Left' ? '左' : pos === 'Middle' ? '中' : '右'}侧模板`, placeholder: '留空 = 用上面选的内容的默认模板' });
  }
  return out;
}

type Section = {
  key: string;
  label: string;
  fields: FieldDef[];
  note?: string;
  /**
   * `#224` 本节要额外渲染「视图模式」下拉（滚动 / 分页）。
   *
   * 为什么用标志位而不是塞进 `fields`：视图模式**不在契约里**（上游没这个开关，见
   * `utils/reader-view-mode.ts` 的注释）⇒ 塞进 `fields` 就得给 `FieldDef` 加一个
   * 「值不来自 readStyle」的特例，那种特例会在渲染处开分支 ⇒ 后面每加一个
   * 「本地偏好型字段」都要复制一遍。标志位 + 模板里单独一段，边界更清楚。
   */
  viewMode?: boolean;
};

const SECTIONS: Section[] = [
  {
    key: 'layout',
    label: '排版',
    fields: [
      { kind: 'num', key: 'textSize', label: '字号', min: 8, max: 80, unit: 'px' },
      { kind: 'sel', key: 'textBold', label: '字重', options: TEXT_BOLD_OPTIONS },
      { kind: 'num', key: 'letterSpacing', label: '字距', min: -0.2, max: 2, step: 0.05, unit: 'em' },
      { kind: 'num', key: 'lineSpacingExtra', label: '行距', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'paragraphSpacing', label: '段距', min: 0, max: 200, unit: 'px' },
      { kind: 'sel', key: 'paragraphIndent', label: '首行缩进', options: INDENT_OPTIONS },
    ],
  },
  {
    key: 'font',
    label: '字体',
    note: 'Web 上只能用**本机装了的字体**；不在列表里可以自己粘 font-family 串。',
    fields: [
      { kind: 'sel', key: 'textFont', label: '正文字体', options: FONT_OPTIONS.map((f) => ({ value: f.value, label: f.label })) },
      { kind: 'text', key: 'textFont', label: '正文字体（自定义）', placeholder: '例："Noto Serif SC", serif' },
      { kind: 'sel', key: 'titleFont', label: '标题字体', options: FONT_OPTIONS.map((f) => ({ value: f.value, label: f.label })) },
      { kind: 'text', key: 'titleFont', label: '标题字体（自定义）', placeholder: '留空 = 跟随正文' },
    ],
  },
  { key: 'convert', label: '简繁', fields: [{ kind: 'sel', key: 'chineseConverterType', label: '简繁转换', options: CHINESE_CONVERT_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })) }] },
  {
    key: 'padding',
    label: '边距',
    fields: [
      { kind: 'num', key: 'paddingTop', label: '正文上', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'paddingLeft', label: '正文左', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'paddingRight', label: '正文右', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'paddingBottom', label: '正文下', min: 0, max: 200, unit: 'px' },
    ],
  },
  {
    key: 'info',
    label: '信息',
    note: '页眉 / 页脚（`#221`）。模板里可用：{书名} {章节} {时间} {页码} {总页数} {阅读进度} {章节序号} {章节总数} {电量} {正文字数}。'
      + '（`#235`）页眉与页脚的字号 / 文字色 / 分隔线色**各自独立**；某一侧留空 = 跟随末尾的「两侧共用」值。'
      + '（`#250`）末尾的「透明」开关控制标题栏 / 页眉 / 页脚**是否透出背景图**：'
      + '关掉透明后，「不透明度」才生效（100 = 完全盖住背景图）。',
    fields: [
      // ── 页眉（`#235`：字号 / 文字色 / 分隔线色**各自独立**，不再是三者共用一份）
      { kind: 'sel', key: 'headerMode', label: '页眉', options: HEADER_MODE_OPTIONS },
      ...tipFields('header'),
      { kind: 'num', key: 'headerTextSize', label: '页眉字号', min: 5, max: 50, unit: 'px', nullable: true },
      { kind: 'color', key: 'headerTextColor', label: '页眉文字颜色', nullable: true },
      { kind: 'bool', key: 'showHeaderLine', label: '页眉下画线' },
      { kind: 'sel', key: 'headerLineStyle', label: '页眉线型', options: TIP_LINE_STYLE_OPTIONS },
      { kind: 'color', key: 'headerDividerColor', label: '页眉分隔线颜色', nullable: true },
      { kind: 'num', key: 'headerPaddingTop', label: '页眉上边距', min: 0, max: 60, unit: 'px' },
      { kind: 'num', key: 'headerPaddingLeft', label: '页眉左边距', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'headerPaddingRight', label: '页眉右边距', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'headerPaddingBottom', label: '页眉下边距', min: 0, max: 60, unit: 'px' },
      // ── 页脚（同样独立）
      { kind: 'sel', key: 'footerMode', label: '页脚', options: FOOTER_MODE_OPTIONS },
      ...tipFields('footer'),
      { kind: 'num', key: 'footerTextSize', label: '页脚字号', min: 5, max: 50, unit: 'px', nullable: true },
      { kind: 'color', key: 'footerTextColor', label: '页脚文字颜色', nullable: true },
      { kind: 'bool', key: 'showFooterLine', label: '页脚上画线' },
      { kind: 'sel', key: 'footerLineStyle', label: '页脚线型', options: TIP_LINE_STYLE_OPTIONS },
      { kind: 'color', key: 'footerDividerColor', label: '页脚分隔线颜色', nullable: true },
      { kind: 'num', key: 'footerPaddingTop', label: '页脚上边距', min: 0, max: 60, unit: 'px' },
      { kind: 'num', key: 'footerPaddingLeft', label: '页脚左边距', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'footerPaddingRight', label: '页脚右边距', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'footerPaddingBottom', label: '页脚下边距', min: 0, max: 60, unit: 'px' },
      // ── 两侧共用（上游 `ReadBookConfig.kt:944-946` 只有这一份，页眉页脚同值）
      //    ★ `#235`：这三个是**回落源** —— 上面某一侧的独立项留空时就用它们。
      //    保留它们是为了兼容老配置与「我只想两侧一起改」的场景。
      { kind: 'num', key: 'tipTextSize', label: '两侧共用字号（回落）', min: 5, max: 50, unit: 'px' },
      { kind: 'color', key: 'tipColor', label: '两侧共用文字色（回落）', nullable: true },
      { kind: 'color', key: 'tipDividerColor', label: '两侧共用分隔线色（回落）', nullable: true },
      // ── `#250` 栏位透明（用户 2026-10-04：页眉页脚/标题栏「是否透明应有开关入口，透明度可调」）
      //    上游 `ll_header`/`ll_footer` 自身无 background ⇒ **恒透明、不可配**（详见契约注释），
      //    本仓 Web 把三者收在同一浮层里才需要这组开关。默认透明 = 与上游观感一致。
      { kind: 'bool', key: 'toolbarTransparent', label: '标题栏透明（透背景图）' },
      { kind: 'num', key: 'toolbarAlpha', label: '标题栏不透明度', min: 0, max: 100, unit: '%' },
      { kind: 'bool', key: 'headerTransparent', label: '页眉透明（透背景图）' },
      { kind: 'num', key: 'headerAlpha', label: '页眉不透明度', min: 0, max: 100, unit: '%' },
      { kind: 'bool', key: 'footerTransparent', label: '页脚透明（透背景图）' },
      { kind: 'num', key: 'footerAlpha', label: '页脚不透明度', min: 0, max: 100, unit: '%' },
    ],
  },
  {
    key: 'anim',
    label: '动画',
    fields: [
      { kind: 'sel', key: 'pageAnim', label: '翻页动画', options: PAGE_ANIM_FIELD_OPTIONS },
    ],
    // `#224` 视图模式**不进契约**（上游没这个开关，本仓自有的「这台机器怎么读」）⇒
    // 走 `utils/reader-view-mode.ts` 的 localStorage，与 navMode / discoverViewMode 同类。
    viewMode: true,
  },
  {
    key: 'preset',
    label: '样式预设',
    // ★ `#248-B` 「下划线」「背景与颜色」不再独立成 Tab，全部收进这里（用户 2026-10-03 22:00）。
    //   理由对齐上游：`ReadBookConfig` 里「背景 + 文字色 + 强调色 + 下划线 + 背景图」本来就是
    //   **同一套阅读外观**，Legado 的「更多 → 背景」对话框也是把它们放在一起编辑的。
    //   拆成独立 Tab 会让人以为「预设 = 只管颜色」，于是「点了预设但下划线没跟着变」显得像 bug。
    //   ⚠️ 这里**不用 `fields`** —— 预设区是**自定义渲染**的（色块网格 + 双击编辑面板），
    //   字段由 `PRESET_FIELDS` 提供给编辑器用（见下）。
    fields: [],
    note: '★ 单击＝整套应用（背景 / 正文色 / 强调色 / 下划线全套 / 背景图片透明度 / 背景图片一次生效）；'
      + '双击＝展开编辑。**下划线与颜色只在预设里设**，不再单独分 Tab。',
  },
  {
    key: 'title',
    label: '标题',
    note: '章节标题区（在「信息」页眉之上的那一行标题）。',
    fields: [
      { kind: 'sel', key: 'titleMode', label: '位置', options: TITLE_MODE_OPTIONS },
      { kind: 'num', key: 'titleSize', label: '字号', min: 0, max: 120, unit: 'px' },
      { kind: 'color', key: 'titleColor', label: '颜色', nullable: true },
      { kind: 'num', key: 'titleTopSpacing', label: '上间距', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'titleBottomSpacing', label: '下间距', min: 0, max: 200, unit: 'px' },
      { kind: 'num', key: 'titleLineSpacingExtra', label: '行高偏移', min: -20, max: 30 },
    ],
  },
];

/**
 * `#248-B` **预设编辑器里能改的字段**（原来只有三个颜色）。
 *
 * ## 为什么把「下划线全套」纳入
 * 用户需求：单击预设要「一次性全部生效」⇒ 预设里必须能带下划线，
 * 否则「点了预设但下划线没变」永远是半个功能。
 * 字段与被删掉的 `underline` Tab **逐条一致**（不多不少），只是换了归属。
 *
 * ## 为什么「背景图片」是一个字段
 * 上游 `ReadBookConfig` 的 `bgType`/`bgStr` 是「色或图」二选一；本仓 `#164` 只做了**颜色背景**
 * （契约 `readStyle` 注释里写明「`bgType` 那一组见本组末尾的暂缓说明」），
 * 而 `bgType`/`bg` 路径字段在契约里**没有对应项** ⇒ 这里给出入口但**明确标注未实现**，
 * 不做一个「点了没反应」的假设置。
 */
const PRESET_FIELDS: FieldDef[] = [
  { kind: 'color', key: 'bgStr', label: '背景' },
  { kind: 'color', key: 'textColor', label: '正文' },
  { kind: 'color', key: 'textAccentColor', label: '强调色' },
  // ★ `#250` 标签改成「背景图片透明度」：上游 `PageView.kt:343` 只给 `bg`（当前背景 Drawable）
  //   设 alpha ⇒ **有背景图时它淡的是图，底色不动**；无图（纯色）时才等价于底色不透明度。
  //   旧标签「背景透明度」让用户以为调的是整个背景区（用户 2026-10-04 正是这么报的）。
  { kind: 'num', key: 'bgAlpha', label: '背景图片透明度', min: 0, max: 100, unit: '%' },
  { kind: 'sel', key: 'underlineMode', label: '下划线样式', options: UNDERLINE_OPTIONS },
  { kind: 'color', key: 'underlineColor', label: '下划线颜色', nullable: true },
  { kind: 'num', key: 'underlineWidth', label: '下划线粗细', min: 0, max: 8, step: 0.5, unit: 'px' },
  { kind: 'num', key: 'underlineDistance', label: '下划线与基线距离', min: -8, max: 24, step: 0.5, unit: 'px' },
  { kind: 'bool', key: 'underlineBodyEnabled', label: '正文行加下划线' },
  { kind: 'bool', key: 'underlineTitleEnabled', label: '标题行加下划线' },
];

/** 面板里露出来的 Tab 顺序（`#248-B`：下划线 / 背景与颜色已收进「样式预设」，这里去掉它们） */
const TAB_ORDER = ['layout', 'font', 'convert', 'padding', 'info', 'anim', 'preset', 'title'];
const SECTIONS_BY_KEY = new Map(SECTIONS.map((s) => [s.key, s]));
const TABS = TAB_ORDER.map((k) => SECTIONS_BY_KEY.get(k)).filter((s): s is Section => !!s);

const activeSection = ref<string>('layout');
const activeDef = computed(() => TABS.find((s) => s.key === activeSection.value) ?? TABS[0]!);
/**
 * 「动画」Tab 的内容分支（用户 2026-11-09 收口）：**只跟随视图模式这一份偏好**。
 * 滚动 ⇒ 无限滚动 + 自动滚动；分页 ⇒ 翻页动画 + 自动翻页。
 * ★ 不再有独立子 tab 状态：之前「按钮选了分页、子 tab 还停在滚动」可以互相打架。
 */
const animTab = computed<'scroll' | 'paged'>(() => (reader.viewMode === 'paged' ? 'paged' : 'scroll'));
const activeFields = computed(() => {
  const def = activeDef.value;
  // 分页专属项（翻页动画）在滚动模式下**不显示**（而不是显示后置灰）
  if (def.key === 'anim' && reader.viewMode !== 'paged') {
    return def.fields.filter((f) => f.key !== 'pageAnim');
  }
  return def.fields;
});

function valueOf(k: string): unknown {
  if (k === 'chineseConverterType') return reader.prefs.chineseConverterType;
  return src.value[k];
}

/**
 * `#235` `nullable` 的数字项（页眉/页脚字号）：**显示真正生效的那个值**。
 *
 * ## 为什么不能直接显示 `valueOf`
 * `headerTextSize` 默认是 `null`（= 跟随「两侧共用字号」），
 * 而滑块 `:value="valueOf(...)"` 遇到 `null` 会走 `Number(null) = 0` ⇒ 界面显示「0px」，
 * 用户会以为「字号被改成 0 了」，而实际生效的是共用的 12。**显示不生效的值 = 骗人。**
 * ⇒ 滑块显示回落后的真值，另给一个「跟随共用」勾选框来写回 `null`。
 */
const FOLLOW_KEYS: Record<string, { zone: 'header' | 'footer' }> = {
  headerTextSize: { zone: 'header' },
  footerTextSize: { zone: 'footer' },
};

function isFollowing(k: string): boolean {
  return FOLLOW_KEYS[k] !== undefined && valueOf(k) === null;
}

/** 生效值：`nullable` 项走契约的回落函数（独立值 → 共用值 → 12） */
function effectiveNum(k: string): number {
  const meta = FOLLOW_KEYS[k];
  if (meta) {
    const s = effectiveTarget.value === 'book' ? reader.readStyle : reader.prefs;
    return tipTextSizeOf(s, meta.zone);
  }
  return Number(valueOf(k)) || 0;
}

/** 勾选「跟随共用」⇒ 写 `null`；取消 ⇒ 写**当前生效值**（把现状固化下来，不是回到 0） */
function toggleFollow(k: string, on: boolean): void {
  if (on) {
    applyValue(k, null);
    return;
  }
  const cur = effectiveNum(k);
  applyValue(k, cur);
}

function applyValue(k: string, v: unknown): void {
  if (k === 'chineseConverterType') {
    reader.patchPrefs({ chineseConverterType: Number(v) });
    return;
  }
  if (k === 'textBold' || k === 'titleMode' || k === 'underlineMode' || k === 'pageAnim'
    || k === 'headerMode' || k === 'footerMode'
    || k.startsWith('tipHeader') || k.startsWith('tipFooter')) {
    // ★ 信息位是**枚举**，模板是字符串：两者都以前缀 `tip` 开头，必须分开判，
    //   否则模板输入会被 Number() 变成 NaN —— 那是「输入模板没反应」的直接原因。
    if (k.endsWith('Template')) commit({ [k]: String(v) } as ReadStyleOverride);
    else commit({ [k]: Number(v) } as ReadStyleOverride);
    return;
  }
  commit({ [k]: v } as ReadStyleOverride);
}

function nudge(k: string, delta: number): void {
  const f = activeFields.value.find((x) => x.key === k);
  if (!f || f.kind !== 'num') return;
  const step = f.step ?? 1;
  let cur = effectiveNum(k);
  if (!Number.isFinite(cur)) cur = 0;
  let next = Math.round((cur + delta * step) / step) * step;
  next = Math.max(f.min, Math.min(f.max, next));
  // 避免浮点显示一长串
  next = Number(next.toFixed(step < 1 ? 2 : 0));
  applyValue(k, next);
}

function onNumInput(k: string, e: Event): void {
  const f = activeFields.value.find((x) => x.key === k) as Extract<FieldDef, { kind: 'num' }> | undefined;
  const raw = Number((e.target as HTMLInputElement).value);
  if (!Number.isFinite(raw)) return;
  const v = f ? Math.max(f.min, Math.min(f.max, raw)) : raw;
  applyValue(k, v);
}

function onColorInput(k: string, e: Event): void {
  applyValue(k, (e.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="rsp" data-read-style-panel :class="{ 'rsp-blocked': blocked }">
    <!--
      `#247` **共用布局入口**。

      ★ 原来这里写的是 `v-if="!blocked && effectiveTarget === 'book'"` ——
        **书不在书架时（`blocked` 为真）整个复选框消失**，用户看到的就是「缺少共用布局入口」，
        而实际上一旦勾上（回全局）面板又恢复正常 ⇒ 越是不该藏的时候越藏了。
        `shareLayout` 的语义是「勾 = 全局 / 不勾 = 本书」，所以它在**任何状态下都是那个出口**：
        书不在书架时唯一能做的正是「勾回共用」，把它藏起来等于把唯一的出路堵死。
      ⇒ 现在**始终渲染**；`blocked` 时额外说明「为什么不能本书」。
      ★★ `#248-B` 再加一条限定：**只在「样式预设」Tab 显示** ——
        共用布局开关只管预设（见 `scopedByShare` 的注释）；在排版/字体/边距… Tab 显示它
        会让人以为「取消勾选后这些也跟着只对本书生效」，而实际上那些 Tab 恒为全局。
    -->
    <label
      v-if="scopedByShare(activeSection)" class="rsp-share"
      :class="{ 'rsp-share-off': !reader.prefs.shareLayout }" data-share-layout-row
    >
      <input
        type="checkbox" data-share-layout
        :checked="reader.prefs.shareLayout"
        @change="reader.patchPrefs({ shareLayout: !reader.prefs.shareLayout })"
      />
      <span>共用布局</span>
    </label>
    <div v-if="scopedByShare(activeSection)" class="rsp-share-hint" data-share-hint>
      <b>{{ reader.prefs.shareLayout ? '共用布局' : '本书覆盖' }}</b>：{{ shareHint }}
      <template v-if="blocked">（这本书不在书架里，无法为它单独保存；勾上「共用布局」即可继续编辑。）</template>
      <template v-else>（**只管「样式预设」这一页**；排版 / 字体 / 简繁 / 边距 / 信息 / 标题 / 动画 各页的设置
        <b>默认对所有书生效</b>。）</template>
    </div>

    <div v-if="blocked" class="rsp-hint err-text">
      这本书不在书架里 —— 单独样式存在书架条目上，<b>加入书架后</b>才能为它单独设置。
      （勾上「共用布局」后改动会保存为全局默认，对所有书生效。）
    </div>

    <div class="rsp-cats">
      <button
        v-for="s in TABS" :key="s.key"
        class="rsp-cat" :class="{ on: activeSection === s.key }"
        :data-tab="s.key"
        :disabled="blocked" @click="activeSection = s.key"
      >{{ s.label }}</button>
    </div>

    <div v-if="activeDef.note" class="rsp-note-in">{{ activeDef.note }}</div>

    <div v-if="!blocked" class="rsp-body">
      <!--
        `#224` **视图模式**（滚动 / 分页）—— 本仓 Web 此前只有滚动，`pageAnim` 的其它档位
        是「假设置」。视图模式**不进契约**（上游没这个开关），落 localStorage，
        读写与白名单校验全在 `utils/reader-view-mode.ts`。
        ★ 用户 2026-11-09 收口：原来这里是【滚动 / 分页】两个按钮 + 下方「滚动模式 / 分页模式」
          两个子 tab，两层在控制同一件事，能出现「按钮选了分页、子 tab 还停在滚动」的对立组合。
          ⇒ 收成**一个滑块开关**，唯一状态就是 `reader.viewMode`（切换即生效并落盘），
          下面的设置按它切换显示。
      -->
      <div v-if="activeDef.viewMode" class="rsp-row rsp-viewmode" data-view-mode-row>
        <span class="rsp-label" title="滚动 = 整章连续下滑；分页 = 一屏一页，点正文左右两侧翻页">视图模式</span>
        <div class="rsp-vm">
          <span class="rsp-vm-cap" :class="{ on: reader.viewMode === 'scroll' }">滚动</span>
          <button
            type="button" class="rsp-vm-track" :class="{ on: reader.viewMode === 'paged' }"
            role="switch" :aria-checked="reader.viewMode === 'paged'"
            :title="reader.viewMode === 'paged' ? '当前：分页（点击切到滚动）' : '当前：滚动（点击切到分页）'"
            data-view-mode-switch @click="reader.setViewMode(reader.viewMode === 'paged' ? 'scroll' : 'paged')"
          ><span class="rsp-vm-knob"></span></button>
          <span class="rsp-vm-cap" :class="{ on: reader.viewMode === 'paged' }">分页</span>
        </div>
      </div>
      <div v-if="activeDef.viewMode && reader.viewMode === 'paged'" class="rsp-hint">
        分页模式下：<b>点正文左侧/右侧</b>翻页，<b>← / →</b> 同效，翻到末页自动接下一章。
        页眉/页脚模板里的 <code>{页码}</code> <code>{总页数}</code> 会显示真实页码。
      </div>
      <!--
        `#833` **无限滚动**（只在滚动模式下生效；默认关）。
        ★ 与视图模式同一处（用户口径）——两者都属于「怎么往下看」。
        ★ `2026-11-09` 起只在滑块为「滚动」时显示（分页里没有它的语义）。
      -->
      <div v-if="activeDef.viewMode && animTab === 'scroll'" class="rsp-row rsp-infinite" data-infinite-row>
        <span class="rsp-label" title="滚动到章末附近自动加载下一章并接续；向上滚到章首也会加载上一章并保持阅读位置。默认关。">无限滚动</span>
        <button
          type="button" class="rsp-toggle" :class="{ on: reader.infiniteScroll }"
          :disabled="blocked"
          :title="reader.infiniteScroll ? '已开启：跨章连续滚动' : '已关闭：章末即停（默认）'"
          data-infinite-toggle @click="reader.setInfiniteScroll(!reader.infiniteScroll)"
        >{{ reader.infiniteScroll ? '开' : '关' }}</button>
      </div>
      <div v-if="activeDef.viewMode && animTab === 'scroll' && reader.infiniteScroll" class="rsp-hint" data-infinite-hint>
        已开启：向下滚到章末会自动接下一章；向上滚到章首也会加载上一章（阅读位置不会跳）。
        加载失败会就地给出重试入口。
      </div>

      <!--
        `#224` **样式预设**：单击应用 / **双击进编辑器**。
        内置 6 套（照抄上游 `defaultData/readConfig.json`）不可删，但可「另存为」；
        用户自建的排在前面（刚做的最可能是当前想用的）。
      -->
      <div v-if="activeSection === 'preset'" class="rsp-presets">
        <div class="rsp-presets-bar">
          <button class="rsp-preset-new" data-preset-new @click="openEditor(null)">＋ 新建（从当前配色起手）</button>
          <span class="rsp-hint-inline">单击＝应用 · 双击＝编辑</span>
        </div>
        <button
          v-for="p in READ_STYLE_PRESETS" :key="p.key"
          class="rsp-preset" :title="p.label + '（双击可另存为自定义预设）'" :data-preset="p.key"
          @click="applyPreset(p)"
          @dblclick.stop="forkBuiltin(p)"
        >
          <span
            class="rsp-preset-swatch"
            :style="{ background: p.patch.bgStr, color: p.patch.textColor }"
          >文</span>
          <span class="rsp-preset-label">{{ p.label }}</span>
        </button>
        <button
          v-for="p in userPresets" :key="p.id"
          class="rsp-preset rsp-preset-user" :title="p.name + '（双击编辑）'" :data-preset="p.id"
          @click="commit(redirectPresetColors(p.patch, reader.readerColorSetName))"
          @dblclick.stop="openEditor(p)"
        >
          <span
            class="rsp-preset-swatch"
            :style="{
              background: (p.patch as Record<string, string>)[editorSlot.keys[0]] ?? '#888',
              color: (p.patch as Record<string, string>)[editorSlot.keys[1]] ?? '#fff',
            }"
          >文</span>
          <span class="rsp-preset-label">{{ p.name }}</span>
          <span
            class="rsp-preset-del" title="删除这条自定义预设" data-preset-del
            @click.stop="deletePreset(p.id)"
          >✕</span>
        </button>
      </div>

      <!--
        ★★ `#250` **背景调节常驻区**（不必双击进编辑器就能调）。
        ## 为什么要有这个区块
        `#249` 把背景图与 `bgAlpha` 只放在**预设编辑器**里（要双击才开）⇒ 用户 2026-10-04
        在「预设」里找「背景透明度」时找不到入口，只能看到一张空的色块列表。
        ## 为什么图片 + 透明度要放在一起
        两者是**同一件事的两半**（上游 `PageView.kt:343` 的 alpha 就是给图片的）⇒
        拆开就会出现「调了透明度但看不到图变化」的困惑（那正是本次修的 bug 的另一面）。
        ⚠️ 写**当前生效值**（`reader.readStyle`）而不是编辑器 draft —— 这一区是**直接改全局/本书**，
          与「预设」的双击编辑流程是两条路。
      -->
      <div v-if="activeSection === 'preset'" class="rsp-backdrop" data-rsp-backdrop>
        <div class="rsp-row">
          <label class="rsp-label">背景图片</label>
          <div class="rsp-bgimg">
            <button
              type="button"
              class="rsp-bgimg-clear" data-bgimg-quick-clear
              :disabled="!bgImgValue()"
              title="清除背景图片（回到纯色背景）"
              @click="setBgImg(null)"
            >清除</button>
            <label class="rsp-bgimg-local" title="从本机选择（≤400KB，转 data URL）">
              本机图片…
              <input type="file" accept="image/*" style="display: none" data-bgimg-quick-local @change="onQuickLocalBg" />
            </label>
          </div>
        </div>
        <div class="rsp-bgimg-grid" data-bgimg-quick-grid>
          <button
            v-for="b in READER_BG_IMAGES" :key="b.id"
            type="button"
            class="rsp-bgimg-cell"
            :class="{ on: bgImgValue() === b.id }"
            :data-bgimg-quick="b.id"
            :title="b.label"
            :style="{ backgroundImage: `url('${b.url}')` }"
            @click="setBgImg(bgImgValue() === b.id ? null : b.id)"
          ></button>
        </div>
        <div v-if="bgImgValue()" class="rsp-hint-inline" data-bgimg-quick-current>
          当前：{{ bgImgLabel(bgImgValue()!) }}
        </div>
        <div class="rsp-row">
          <label class="rsp-label" title="上游 PageView.kt:343 只给背景图层设 alpha：设了背景图时淡的是图，底色不变。">
            背景图片透明度
          </label>
          <div class="rsp-num">
            <button class="rsp-nudge" :disabled="bgAlphaValue() <= 0" @click="nudgeBgAlpha(-1)">−</button>
            <input
              type="range" class="rsp-range" min="0" max="100" step="1"
              :value="bgAlphaValue()" :disabled="blocked" data-bgalpha-quick
              @input="onQuickBgAlpha"
            />
            <button class="rsp-nudge" :disabled="bgAlphaValue() >= 100" @click="nudgeBgAlpha(1)">+</button>
            <span class="rsp-value">{{ bgAlphaValue() }}<small>%</small></span>
          </div>
        </div>
        <div class="rsp-hint">
          背景图铺满<b>整个阅读界面</b>（标题栏 / 页眉 / 正文 / 页脚）——
          这几处是否透明、透明度多少，在<b>「信息」Tab</b>末尾设置。
        </div>
      </div>

      <!-- `#224` 预设编辑器：三个颜色（当前颜色集）+ 名字 + 存 / 取消 -->

      <div v-if="activeSection === 'preset' && editorOpen" class="rsp-editor" data-preset-editor>
        <div class="rsp-editor-title">{{ editing ? '编辑预设' : '新建预设' }}</div>
        <div class="rsp-row">
          <label class="rsp-label">名字</label>
          <input
            class="rsp-text" type="text" :value="draft.name" maxlength="16"
            placeholder="例：我的护眼" data-preset-name @input="onEditorName"
          />
        </div>
        <!--
          ★ `#248-B` 预设编辑器改成**按 `PRESET_FIELDS` 通用渲染**（原来硬编码三行颜色）。
          为什么不再手写三行：① 下划线全套 + 透明度要能在这里改，就得再抄一遍控件；
          ② 手写控件的字段**一定会和被删掉的 Tab 漂移**（改一处忘另一处）——
          通用渲染后，`PRESET_FIELDS` 就是唯一的字段清单。
          ★ 颜色类仍走 `editorSlot.keys` **重定向到当前颜色集**（白天/夜间/墨水屏各一套），
          语义与 `redirectPresetColors` 一致：写另外两套等于替用户决定夜间长什么样。
        -->
        <div v-for="f in PRESET_FIELDS" :key="`pf-${f.kind}-${f.label}`" class="rsp-row">
          <label class="rsp-label">{{ f.label }}</label>

          <!-- 颜色：白天的槽固定用 `bgStr/textColor/…`，夜间/墨水的重定向到对应槽 -->
          <template v-if="f.kind === 'color'">
            <input
              type="color" class="rsp-color" :data-pf-color="f.key"
              :value="toRrGgBb(editorColorOf(f.key))"
              @input="onEditorColor(pfColorKey(f.key), $event)"
            />
            <label v-if="f.nullable" class="rsp-follow" title="勾上＝跟随正文色（写回 null）">
              <input type="checkbox" :checked="isEditorFollowing(f.key)" @change="toggleEditorFollow(f.key)" />
              <span>跟随正文色</span>
            </label>
          </template>

          <!-- 数值 -->
          <template v-else-if="f.kind === 'num'">
            <div class="rsp-num">
              <input
                type="range" class="rsp-range" :min="f.min" :max="f.max" :step="f.step ?? 1"
                :data-pf-num="f.key" :value="editorNumOf(f.key)"
                @input="onEditorNum(f.key, $event)"
              />
              <span class="rsp-value">{{ editorNumOf(f.key) }}<small v-if="f.unit">{{ f.unit }}</small></span>
            </div>
          </template>

          <!-- 枚举（下划线样式） -->
          <template v-else-if="f.kind === 'sel'">
            <div class="rsp-btns">
              <button
                v-for="o in f.options" :key="o.value"
                class="rsp-btn" :class="{ on: String(editorRawOf(f.key)) === o.value }"
                :data-pf-sel="f.key + ':' + o.value" @click="onEditorRaw(f.key, o.value)"
              >{{ o.label }}</button>
            </div>
          </template>

          <!-- 布尔（正文行 / 标题行是否加下划线） -->
          <template v-else-if="f.kind === 'bool'">
            <div class="switch" :class="{ on: editorRawOf(f.key) === true }" @click="onEditorRaw(f.key, editorRawOf(f.key) !== true)"></div>
          </template>
        </div>
        <div class="rsp-hint">
          只保存<b>当前颜色集</b>（{{ editorSlot.set === 0 ? '白天' : editorSlot.set === 1 ? '夜间' : '墨水屏' }}）的三个颜色 ——
          另外两套仍归你原来的设置。
        </div>

        <!--
          ★ `#249` **背景图片**：内置 14 张（照抄上游 `assets/bg/` 的文件名）+ 本机图片 + 清除。
          · 背景的作用域是**整个阅读界面**（页眉 + 正文 + 页脚），页眉页脚透明透图 ——
            对齐上游 `PageView.kt:329-336`（挂在 `vwRoot`，而 `ll_header`/`ll_footer` 自身无 background）。
          · ★ **内置图不进预设**（上游 6 个预设的 `bgType` 全是 0 纯色），这里只在**编辑器**里可选，
            选了写进当前预设 —— 代价是一张图 100~320KB，所以面板在**保存时**会提示体积。
          · 本机图片走 data URL，限额同界面壁纸（400KB）。
        -->
        <div class="rsp-row rsp-bgimg-row">
          <label class="rsp-label">背景图片</label>
          <div class="rsp-bgimg">
            <button
              type="button"
              class="rsp-bgimg-clear" data-bgimg-clear
              :disabled="!editorRawOf(pfBgImgKey())"
              title="清除背景图片（回到纯色背景）"
              @click="onEditorRaw(pfBgImgKey(), null)"
            >清除</button>
            <label class="rsp-bgimg-local" title="从本机选择（≤400KB，转 data URL）">
              本机图片…
              <input type="file" accept="image/*" style="display: none" data-bgimg-local @change="onLocalBgFile" />
            </label>
          </div>
        </div>
        <div class="rsp-bgimg-grid" data-bgimg-grid>
          <button
            v-for="b in READER_BG_IMAGES" :key="b.id"
            type="button"
            class="rsp-bgimg-cell"
            :class="{ on: editorRawOf(pfBgImgKey()) === b.id }"
            :data-bgimg="b.id"
            :title="b.label"
            :style="{ backgroundImage: `url('${b.url}')` }"
            @click="onEditorRaw(pfBgImgKey(), editorRawOf(pfBgImgKey()) === b.id ? null : b.id)"
          ></button>
        </div>
        <div v-if="editorRawOf(pfBgImgKey())" class="rsp-hint-inline" data-bgimg-current>
          当前：{{ bgImgLabel(String(editorRawOf(pfBgImgKey()))) }}
          <template v-if="!isBuiltinBgId(String(editorRawOf(pfBgImgKey()))) && !/^data:image|^https?:/i.test(String(editorRawOf(pfBgImgKey())))">
            ⚠️ 这个值既不是内置图也不是 URL/data URL，**不会渲染出图**。
          </template>
        </div>

        <div class="rsp-editor-actions">
          <button class="btn sm primary" data-preset-save @click="savePreset">保存</button>
          <button class="btn sm" @click="closeEditor">取消</button>
        </div>
      </div>

      <div v-for="f in activeFields" :key="`${activeSection}-${f.kind}-${f.label}`" class="rsp-row">
        <label class="rsp-label">{{ f.label }}</label>

        <!-- 数值：− 滑块 + -->
        <template v-if="f.kind === 'num'">
          <div class="rsp-num">
            <button class="rsp-nudge" :disabled="effectiveNum(f.key) <= f.min" @click="nudge(f.key, -1)">−</button>
            <input
              type="range" class="rsp-range" :min="f.min" :max="f.max" :step="f.step ?? 1"
              :value="effectiveNum(f.key)" :disabled="blocked || (f.nullable && isFollowing(f.key))"
              @input="onNumInput(f.key, $event)"
            />
            <button class="rsp-nudge" :disabled="effectiveNum(f.key) >= f.max" @click="nudge(f.key, 1)">+</button>
            <span class="rsp-value">{{ effectiveNum(f.key) }}<small v-if="f.unit">{{ f.unit }}</small></span>
            <!-- `#235` 「跟随共用」：勾上 = 写回 `null`（跟随两侧共用那份），滑块锁定 -->
            <label v-if="f.nullable" class="rsp-follow" title="勾上＝跟随末尾的「两侧共用字号」">
              <input
                type="checkbox" :checked="isFollowing(f.key)" :disabled="blocked"
                @change="toggleFollow(f.key, ($event.target as HTMLInputElement).checked)"
              />
              <span>跟随共用</span>
            </label>
          </div>
        </template>

        <!-- 枚举：按钮组 -->
        <template v-else-if="f.kind === 'sel'">
          <div class="rsp-btns">
            <button
              v-for="o in f.options" :key="o.value"
              class="rsp-btn" :class="{ on: String(valueOf(f.key)) === o.value }"
              :disabled="blocked" @click="applyValue(f.key, o.value)"
            >{{ o.label }}</button>
          </div>
        </template>

        <!-- 开关 -->
        <template v-else-if="f.kind === 'bool'">
          <button
            class="rsp-toggle" :class="{ on: valueOf(f.key) !== false }"
            :disabled="blocked" @click="applyValue(f.key, valueOf(f.key) === false)"
          >{{ valueOf(f.key) !== false ? '开' : '关' }}</button>
        </template>

        <!-- 颜色 -->
        <template v-else-if="f.kind === 'color'">
          <div class="rsp-color">
            <input
              type="color" :value="toRrGgBb(valueOf(f.key) as string | null)"
              :disabled="blocked || (f.nullable && valueOf(f.key) == null)"
              @input="onColorInput(f.key, $event)"
            />
            <label v-if="f.nullable" class="rsp-bool">
              <input
                type="checkbox" :checked="valueOf(f.key) == null"
                :disabled="blocked"
                @change="applyValue(f.key, ($event.target as HTMLInputElement).checked ? null : toRrGgBb(valueOf(f.key) as string | null))"
              />
              <span>跟随正文</span>
            </label>
          </div>
        </template>

        <!-- 文本（模板 / 自定义字体） -->
        <template v-else-if="f.kind === 'text'">
          <input
            class="rsp-text" type="text" :value="(valueOf(f.key) as string) ?? ''"
            :placeholder="f.placeholder" :disabled="blocked"
            @change="applyValue(f.key, ($event.target as HTMLInputElement).value)"
          />
        </template>
      </div>

      <!-- 模板占位符速查（只在该 Tab 显示，避免到处重复） -->
      <div v-if="activeSection === 'info'" class="rsp-ph">
        <span>可用占位符：</span>
        <code v-for="(v, k) in READER_INFO_PLACEHOLDERS" :key="k">{{ v }}</code>
      </div>
    </div>

    <!--
      `#817` 调用方扩展区（**只在「动画」Tab 渲染**）。
      用户 2026-11-06 实机反馈：自动滚动卡片原来挂在 `ReadStylePanel` **外面**（与面板并列），
      于是每个 Tab 底部都显示 —— 那些 Tab 跟自动滚动毫无关系，既占位置又容易误触。
      ⇒ 收进「动画」Tab（`activeSection === 'anim'`，与「翻页动画」同一页：两者都属于「怎么往下看」）。
      ★ 用 `v-if` 而**不是**只在插槽内容里判断：其它 Tab 连插槽出口都不创建，
        不留空占位、也不给未渲染的控件留 DOM。
      ★ 位置放在 `.rsp-body` **之外**（但仍在 `.rsp` 里）：`blocked`（书不在书架）时 `.rsp-body`
        整块不渲染 —— 自动滚动是**阅读行为**（会话开关），不该被「样式作用域」连带藏掉；
        `#814` 的旧位置在对话框里，未入架的书也能用。
    -->
    <slot v-if="activeSection === 'anim'" name="anim" :mode="animTab" />

    <div class="rsp-note">
      阅读样式默认存服务端；当前 tab 为「本书覆盖」时只影响当前这本书。
    </div>
  </div>
</template>

<style scoped>
.rsp { min-height: 0; }
.rsp-blocked { opacity: 0.55; }
/* `#247` 共用布局入口：做成「一行开关 + 一行说明」两行，而不是一个孤零零的复选框。 */
.rsp-share {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 4px; font-size: 12px; color: var(--text-0); cursor: pointer;
  width: fit-content;
}
/* 未勾选 = 本书覆盖：给一点视觉区分（但不做得像「禁用」，它现在是主路径之一） */
.rsp-share-off span { color: var(--brand); font-weight: 600; }
.rsp-share-hint {
  flex: none;
  margin: 0 0 8px; padding: 6px 10px; border-radius: 6px;
  background: var(--bg-2); border: 1px solid var(--border);
  font-size: 11px; line-height: 1.6; color: var(--muted);
}
.rsp-share-hint b { color: var(--text-0); }
.rsp-note-in {
  flex: none;
  margin: 0 0 10px; padding: 7px 10px; border-radius: 6px;
  background: var(--bg-2); border: 1px solid var(--border);
  font-size: 12px; line-height: 1.6; color: var(--muted);
}
.rsp-presets {
  flex: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 8px; }
.rsp-preset {
  position: relative; /* 自定义预设右上角的删除角标要绝对定位 */
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text-0);
  border-radius: 8px; padding: 8px 6px; cursor: pointer;
  /* ★ `#224` 单击=应用、双击=编辑 ⇒ 两个手势共存，浏览器会给「双击」加选中高亮 */
  user-select: none; -webkit-user-select: none;
}
.rsp-preset:hover { background: var(--bg-3); }
/* `#224` 用户自建的：左侧一道品牌色边，一眼与内置区分 */
.rsp-preset-user { border-left: 3px solid var(--brand); }
.rsp-preset-del {
  position: absolute; top: 2px; right: 2px;
  width: 18px; height: 18px; border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1; color: var(--muted);
  background: var(--bg-1); border: 1px solid var(--border);
  opacity: 0; transition: opacity 0.12s;
}
.rsp-preset:hover .rsp-preset-del { opacity: 1; }
.rsp-preset-del:hover { color: var(--danger, #e53935); border-color: var(--danger, #e53935); }
/* 预设区顶栏：新建按钮 + 手势提示 */
.rsp-presets-bar {
  grid-column: 1 / -1; /* 跨满整行，不参与网格排布 */
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-bottom: 2px;
}
.rsp-preset-new {
  font-family: var(--font); font-size: 12px;
  padding: 3px 9px; border-radius: 6px; cursor: pointer;
  background: var(--brand-soft); color: var(--brand);
  border: 1px solid transparent;
}
.rsp-preset-new:hover { border-color: var(--brand); }
.rsp-hint-inline { font-size: 11.5px; color: var(--muted); }

/* `#249` 背景图片选择区：14 张内置图的缩略网格 + 本机图片 / 清除 */
.rsp-bgimg-row { align-items: center; }
.rsp-bgimg { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.rsp-bgimg-clear, .rsp-bgimg-local {
  display: inline-flex; align-items: center; padding: 2px 8px;
  border-radius: 6px; cursor: pointer; font-size: 11px; font-family: var(--font);
  background: var(--bg-3); color: var(--text-1); border: 1px solid var(--border-strong);
}
.rsp-bgimg-clear:hover:not(:disabled), .rsp-bgimg-local:hover { background: var(--brand-soft); color: var(--brand); }
.rsp-bgimg-clear:disabled { opacity: 0.5; cursor: default; }
.rsp-bgimg-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(46px, 1fr));
  gap: 6px; margin: 0 0 8px; max-height: 190px; overflow-y: auto; padding: 2px;
}
.rsp-bgimg-cell {
  aspect-ratio: 3 / 4; border-radius: 5px; cursor: pointer;
  border: 2px solid var(--border); background-size: cover; background-position: center;
  background-color: var(--bg-3);
}
.rsp-bgimg-cell:hover { border-color: var(--brand); }
.rsp-bgimg-cell.on { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
/* ★★ `#250` 常驻背景调节区：紧跟在预设色块下方，独立成块以便与编辑器区分。
   `border-left` 用主色 ⇒ 一眼能看出「这块是直接生效的，不是双击才出现的编辑器」。 */
.rsp-backdrop {
  flex: none; margin-top: 10px; padding: 10px 10px 8px;
  border: 1px solid var(--border-strong); border-left: 3px solid var(--brand);
  border-radius: 8px; background: var(--bg-2);
}
.rsp-backdrop .rsp-row { margin-bottom: 8px; }
/* `#224` 预设编辑器 */
.rsp-editor {
  flex: none; margin-top: 10px; padding: 10px;
  border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-2);
}
.rsp-editor-title { font-size: 12.5px; font-weight: 600; color: var(--text-0); margin-bottom: 6px; }
.rsp-editor-actions { display: flex; gap: 8px; margin-top: 8px; }
.rsp-text {
  flex: 1; min-width: 0; font-family: var(--font); font-size: 12.5px;
  padding: 4px 7px; border-radius: 5px;
  border: 1px solid var(--border-strong); background: var(--bg-1); color: var(--text-0);
}
.rsp-preset-swatch {
  width: 48px; height: 64px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 700;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
}
.rsp-preset-label { font-size: 11.5px; color: var(--muted); }
.rsp-hint {
  flex: none;
  margin: 4px 0 10px; padding: 8px 10px; border-radius: 6px;
  background: var(--bg-2); font-size: 12.5px; line-height: 1.6;
}
/* 视图模式滑块开关（用户 2026-11-09：替代原来的两个按钮 + 两个子 tab） */
.rsp-vm { display: flex; align-items: center; gap: 8px; }
.rsp-vm-cap {
  font-size: 12px; color: var(--muted); cursor: default;
  transition: color 0.12s, font-weight 0.12s;
}
.rsp-vm-cap.on { color: var(--brand); font-weight: 700; }
.rsp-vm-track {
  position: relative; flex: none;
  width: 44px; height: 24px; padding: 0;
  border-radius: 999px; border: 1px solid var(--border-strong);
  background: var(--bg-3); cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.rsp-vm-track.on { background: var(--brand); border-color: var(--brand); }
.rsp-vm-knob {
  position: absolute; top: 2px; left: 2px;
  width: 18px; height: 18px; border-radius: 999px;
  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s;
}
.rsp-vm-track.on .rsp-vm-knob { transform: translateX(20px); }
.rsp-cats {
  flex: none;
  display: flex; gap: 6px; flex-wrap: wrap;
  padding-bottom: 10px; border-bottom: 1px solid var(--border);
  margin-bottom: 10px;
}
.rsp-cat {
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text-0);
  border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.rsp-cat:hover:not(:disabled) { background: var(--bg-3); }
.rsp-cat.on { background: var(--brand-soft); border-color: var(--brand); color: var(--brand); font-weight: 700; }
.rsp-cat:disabled { opacity: 0.5; cursor: not-allowed; }

/* ★ `#231`：内容区自己滚动。`flex:1 + min-height:0` 是关键 ——
   父级（`.rd-dlg-style`）有 `max-height`，不这样写的话 flex 子项会按内容高度撑开、**溢出浮层**。
   `padding-right` 给滚动条留位置，免得压住滑块。 */
.rsp-body {
  display: flex; flex-direction: column; gap: 10px;
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding-right: 4px;
}
/* ★ `#232`：`flex: none` 不能少 —— `#231` 给 `.rsp-body` 加了 `flex:1 + overflow-y:auto`，
   而 flex column 的子项默认 `flex-shrink:1` ⇒ 高度不够时**每一行都被压扁**，
   按钮组与输入框挤在一起（用户 2026-10-03 截图红框：按钮/输入框堆叠）。
   ⇒ 行本身不参与收缩，滚动交给容器。 */
/* `#235` 「跟随共用」勾选 */
.rsp-follow {
  flex: none; display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--muted); cursor: pointer; user-select: none;
  white-space: nowrap;
}
.rsp-follow input { margin: 0; cursor: pointer; }

.rsp-row {
  flex: none;
  display: flex; align-items: center; gap: 10px; justify-content: space-between;
  min-height: 32px;
}
.rsp-label { font-size: 12.5px; color: var(--text-0); min-width: 96px; }

.rsp-num { display: flex; align-items: center; gap: 8px; flex: 1; justify-content: flex-end; }
.rsp-nudge {
  width: 26px; height: 26px; border-radius: 4px; border: 1px solid var(--border);
  background: var(--bg-2); color: var(--text-0); font-size: 15px; line-height: 1;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.rsp-nudge:hover:not(:disabled) { background: var(--bg-3); }
.rsp-nudge:disabled { opacity: 0.35; cursor: not-allowed; }
.rsp-range { width: 140px; accent-color: var(--brand); }
.rsp-value {
  min-width: 52px; text-align: right; font-size: 12px; color: var(--text-0); font-variant-numeric: tabular-nums;
  font-family: var(--mono);
}
.rsp-value small { margin-left: 2px; color: var(--muted); font-size: 10px; }

.rsp-btns { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.rsp-btn {
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text-0);
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
}
.rsp-btn:hover:not(:disabled) { background: var(--bg-3); }
.rsp-btn.on { background: var(--brand-soft); border-color: var(--brand); color: var(--brand); font-weight: 700; }
.rsp-btn:disabled { opacity: 0.5; }

.rsp-toggle {
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text-0);
  border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer;
}
/* `#848` 禁用态（分页模式下「无限滚动」不可用）必须**看得出来**是灰的：
   之前只有 `disabled` 属性、没有样式，用户以为它「还开着、并且还在加载」。 */
.rsp-toggle:disabled { opacity: 0.45; cursor: not-allowed; }
.rsp-toggle.on { background: var(--brand-soft); border-color: var(--brand); color: var(--brand); font-weight: 700; }

.rsp-color { display: flex; align-items: center; gap: 8px; }
.rsp-color input[type="color"] {
  width: 32px; height: 32px; padding: 0; border: 1px solid var(--border); border-radius: 6px;
  background: none; cursor: pointer;
}
.rsp-bool { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--muted); }

.rsp-text {
  flex: 1; min-width: 0; max-width: 260px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-0);
  padding: 5px 8px; font-size: 12px; font-family: var(--font);
}
.rsp-text:focus { outline: none; border-color: var(--brand); }

.rsp-ph {
  flex: none;
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  margin-top: 6px; font-size: 11.5px; color: var(--muted);
}
.rsp-ph code {
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 4px;
  padding: 1px 5px; font-family: var(--mono); font-size: 11px; color: var(--text-0);
}

.rsp-note {
  flex: none;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);
  font-size: 11px; color: var(--muted); line-height: 1.5;
}
</style>
