<!--
  `#221`：**页眉 / 页脚**（一条组件两用，`zone` 区分）。

  ## 为什么要单独一个组件
  页眉页脚的**信息位是三段的**（左 / 中 / 右，各自一个模板），
  且字号、颜色、内边距、分隔线**全部独立**于正文（上游 `ReadBookConfig.kt:922-948`）。
  把它们塞进 `ReaderOverlay` 会再长出两个 100 行的 computed —— 那个文件已经 2400+ 行了。

  ## 与上游的对齐
  · 三段信息位 + 模板 = `ReadTipConfig.kt` + `ReaderInfoTemplate.kt`；
  · 「隐藏」语义：`headerMode`（0 自动隐藏 / 1 显示 / 2 隐藏）、`footerMode`（0 显示 / 1 隐藏）。
  ★ 差异：`headerMode = 0` 上游是「状态栏显示时隐藏」，Web 没有状态栏 ⇒ 由**父组件**
    按「向下滚动时收起」判（滚动状态在 `ReaderOverlay` 里，这里不自己监听）。

  ## 空三段怎么办
  三段都空时**不占位**（整条收掉）—— 否则用户会看到一条永远空白的横条，
  而「页眉我明明关掉了」这种反馈缺失正是难查的一类问题。
-->
<script setup lang="ts">
import { computed } from 'vue';
import { normaliseTipLineStyle } from '@yuedu/core/contract';
import { useReaderStore } from '../stores/reader';

const props = defineProps<{
  /** `header` = 页眉 / `footer` = 页脚 */
  zone: 'header' | 'footer';
  /** 三段文本（**已渲染好的**，模板解析在 `ReaderOverlay` 里做一次，两边共用） */
  left?: string;
  middle?: string;
  right?: string;
}>();

const r = useReaderStore();
const isHeader = computed(() => props.zone === 'header');
const s = computed(() => r.readStyle);

/** 三段全空 ⇒ 整条不渲染（见文件头「空三段怎么办」） */
const empty = computed(() => !(props.left || props.middle || props.right));

/**
 * ★ `#233` **CSS 变量必须绑在**外层** `.rd-tip`（整条），内边距绑在**内层** `.rd-tip-in`（信息区）。
 *
 * ## 为什么必须拆成两个绑定（`#232` 把 `:style` 整块挪到内层留下的坑）
 * `readerTipVars` 给的是**自定义属性**（`--rd-tip-fs` / `--rd-tip-color` / `--rd-tip-divider`），
 * 而**消费**它们的三条规则全在**外层** `.rd-tip`（`font-size` / `color` / `.rd-tip-line` 的
 * `border-color`）。CSS 自定义属性**只向下继承**（子元素能读到父元素定义的，父元素读不到子元素的）
 * ⇒ 整块绑到内层后，外层三条规则全部拿到**回退值**：字号恒 12px、颜色恒 `inherit`、
 * 分隔线色也跟着丢。症状正是「字号/颜色设置失效」，但**没有任何报错**。
 *
 * ## 正确分工
 * · `tipVars`  → 外层 `.rd-tip`：字号 / 文字色 / 分隔线色（作用在整条上）
 * · `tipBox`   → 内层 `.rd-tip-in`：四向内边距（决定「信息显示区域」的边界，必须与正文盒子同宽）
 */
const tipVars = computed<Record<string, string>>(() => r.tipVarsOf(props.zone));

const tipBox = computed<Record<string, string>>(() => {
  const rs = s.value;
  const p = isHeader.value
    ? { t: rs.headerPaddingTop, r: rs.headerPaddingRight, b: rs.headerPaddingBottom, l: rs.headerPaddingLeft }
    : { t: rs.footerPaddingTop, r: rs.footerPaddingRight, b: rs.footerPaddingBottom, l: rs.footerPaddingLeft };
  return {
    paddingTop: `${Math.max(0, p.t ?? 0)}px`,
    paddingRight: `${Math.max(0, p.r ?? 16)}px`,
    paddingBottom: `${Math.max(0, p.b ?? 0)}px`,
    paddingLeft: `${Math.max(0, p.l ?? 16)}px`,
  };
});

const showLine = computed(() => (isHeader.value ? s.value.showHeaderLine : s.value.showFooterLine));

/**
 * `#235` 本侧的分隔线型（页眉读 `headerLineStyle` / 页脚读 `footerLineStyle`）。
 * 归一走契约的 `normaliseTipLineStyle`（未知值回落 `solid`，不抛）——
 * 模板把它挂成 `data-line`，CSS 按属性选择器画，**不靠 style 字符串匹配**。
 */
const lineStyle = computed(() => normaliseTipLineStyle(isHeader.value ? s.value.headerLineStyle : s.value.footerLineStyle));
</script>

<template>
  <div
    v-if="!empty"
    class="rd-tip"
    :class="[isHeader ? 'rd-tip-header' : 'rd-tip-footer', { 'rd-tip-line': showLine }]"
    :data-tip-zone="zone"
    :data-line="lineStyle"
    :style="tipVars"
  >
    <!-- ★ `#232`：外层 `.rd-tip` = **整条**（与标题栏同宽、随页面宽度扩充）；
         内层 `.rd-tip-in` = 「信息显示区域」，限宽到与正文一致并居中、左右对齐。
         ★ `#233`：两个绑定不能合成一个 —— CSS 变量要挂外层（见 `tipVars` 注释）。 -->
    <div class="rd-tip-in" :style="tipBox">
      <span class="rd-tip-l" :title="left">{{ left }}</span>
      <span class="rd-tip-m" :title="middle">{{ middle }}</span>
      <span class="rd-tip-r" :title="right">{{ right }}</span>
    </div>
  </div>
</template>

<style scoped>
/* ★ 页眉页脚是**固定悬浮**的（不随正文滚动）—— 定位由父容器决定，这里只管内部排版。
   用户 2026-10-03 的原话：「页眉（固定悬浮不随页面滚动）」「页脚（固定悬浮不随页面滚动）」。 */
.rd-tip {
  /* ★ `#231`/`#232`（用户两次纠正同一件事）：
     ① 初版遗留的 `max-width: 920px` 让**最大化后页眉/页脚不跟着变宽**（实测 903 → 920，而面板已 1440）；
     ② `#232` 更正：「页眉宽度」指的是**整条**（要与标题栏同宽、随窗口扩充），
        而**里面显示信息的那部分**才要与正文同宽、左右对齐。
     ⇒ 限宽从 `.rd-tip` 挪到内层 `.rd-tip-in`，两者用同一套 `min(918px, 100%)` 约束。 */
  flex: 0 0 auto;
  width: 100%;
  /* `#235`：双线/波浪线用 `::after` 伪元素画（border 只能画一条线）⇒ 必须有定位基准 */
  position: relative;
  font-size: var(--rd-tip-fs, 12px);
  color: var(--rd-tip-color, inherit);
  line-height: 1.4;
  user-select: none;
}
/* 信息显示区域：与正文盒子（`.se-body`）**同一套约束** */
.rd-tip-in {
  width: 100%;
  max-width: min(918px, 100%);
  margin-left: auto; margin-right: auto;
  display: grid;
  /* ★★ `#329` 三栏**各硬分 1/3、不越界**（用户报：长书名/章节名盖住中栏的正文字数统计）。
     旧值 `1fr auto 1fr` 有两个洞：
     ① `1fr` 的最小尺寸默认是 `auto`（= min-content）⇒ 长文本把边栏轨道撑超 1/3；
     ② 中栏 `auto` 随内容伸缩 ⇒ 长边栏挤得中栏只剩零。
     `minmax(0, 1fr)` × 3 把三栏锁死成等宽，配合每格 overflow 截断。
     ★★ 关键配套：截断要真生效，格子必须**拉伸到轨道宽** —— `justify-self: start/center/end`
     会把格子按内容定宽（nowrap 的 min-content = 全文宽 ⇒ 格子恒全文宽，overflow 永远咬不到，
     这正是「盖住」的机制）。所以这里删掉 justify-self，改用 `text-align` 做左/中/右对齐
     （中栏 text-align:center 在等宽三栏里仍精确等于整条居中）。 */
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: 8px;
}

.rd-tip-l { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-tip-m { text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-tip-r { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ============ 分隔线（`#221` 位置 + `#235` 线型）============
 * 位置：页眉画在**下边**（它是正文的上边界），页脚画在**上边**
 *      —— 上游 `showHeaderLine` / `showFooterLine` 就是这两条，方向按「朝向正文」理解。
 * 线型：`--rd-tip-line-style` 由 `tipVarsOf` 输出（solid/dashed/dotted/double/wave）。
 *   · solid / dashed / dotted ⇒ 用 `border-style`，**最省**（不额外占元素）
 *   · double / wave         ⇒ 用 `background-image` + `border-style: none`
 *     （双线是两条 1px 线夹 1px 间隙；波浪用 `repeating-linear-gradient` 造锯齿）
 * ⚠️ 双线/波浪线的线放在 `::after` 伪元素上：**border 只能画一条线**，
 *   伪元素的 `height: 3px` 才能容下「线-隙-线」三层。
 */
.rd-tip-line.rd-tip-header { border-bottom: 1px solid var(--rd-tip-divider, currentColor); }
.rd-tip-line.rd-tip-footer { border-top: 1px solid var(--rd-tip-divider, currentColor); }

/* ★★ 虚线 / 点线：**必须用单边属性**，不能写 `border-style` 简写（2026-10-03 用户实测修）。
 *
 * ## 事故原委
 * `.rd-tip-header` 只声明了 `border-bottom: 1px solid …`，其余三边的 `border-width`
 * 仍是初始值 `medium`（约 3px）。而 `border-style: dashed` 是**四边简写** ——
 * 它把上/左/右三边的 style 也改成 dashed，那三边于是「凭空长出」3px 虚线
 * ⇒ 用户看到的是「虚线把整个盒子都框起来了」，而他只要一条下边线。
 * （实线/双线/波浪线没事：实线走的是单边 `border-bottom`，双线/波浪走 `::after`。）
 *
 * 修法：按方向写单边属性 —— 页眉只改 `border-bottom-style`，页脚只改 `border-top-style`。
 * ★ 用 `data-line` 属性而不是 `[style*='--rd-tip-line-style: dashed']` 匹配 style 字符串 ——
 *   后者依赖 Vue 把自定义属性序列化成什么格式（`: dashed` 前的空格都可能变），脆得没法维护。 */
.rd-tip-line.rd-tip-header[data-line='dashed'] { border-bottom-style: dashed; }
.rd-tip-line.rd-tip-header[data-line='dotted'] { border-bottom-style: dotted; }
.rd-tip-line.rd-tip-footer[data-line='dashed'] { border-top-style: dashed; }
.rd-tip-line.rd-tip-footer[data-line='dotted'] { border-top-style: dotted; }

/* 双线 / 波浪线：去掉 border，改用伪元素画「线-隙-线」 */
.rd-tip-line[data-line='double'],
.rd-tip-line[data-line='wave'] { border-style: none; }
.rd-tip-line[data-line='double']::after,
.rd-tip-line[data-line='wave']::after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  height: 3px;
  background-color: transparent;
  background-image: var(--rd-tip-line-image);
  background-repeat: repeat-x;
  pointer-events: none;
}
.rd-tip-line[data-line='double'].rd-tip-header::after { bottom: 0; }
.rd-tip-line[data-line='double'].rd-tip-footer::after { top: 0; }
/* 双线：上面那条实线 + 中间 1px 透明 + 下面那条实线（两条 gradient 叠 3px 周期） */
.rd-tip-line[data-line='double']::after {
  background-image:
    linear-gradient(var(--rd-tip-divider, currentColor) 0 0),
    linear-gradient(var(--rd-tip-divider, currentColor) 0 0);
  background-size: 100% 1px, 100% 1px;
  background-position: 0 0, 0 2px;
  background-repeat: no-repeat;
}
/* 波浪线：45° 斜纹周期 4px（2px 线 + 2px 空）⇒ 视觉上接近 SVG 锯齿波 */
.rd-tip-line[data-line='wave']::after {
  background-image: repeating-linear-gradient(45deg, var(--rd-tip-divider, currentColor) 0 2px, transparent 2px 4px);
  height: 2px;
}
.rd-tip-line[data-line='wave'].rd-tip-header::after { bottom: 0; }
.rd-tip-line[data-line='wave'].rd-tip-footer::after { top: 0; }
</style>
