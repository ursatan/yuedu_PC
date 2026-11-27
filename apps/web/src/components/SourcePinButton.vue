<!--
  `#236` **源置顶按钮**（发现页 / 影院发现页 / 源管理三处共用）。

  ## 为什么要组件
  三处列表（`DiscoverView` 的左栏、`SourceManagerView` 的表格）都各有一枚置顶按钮。
  「已置顶要换图标」这个规则**写三遍就是三份会漂移的实现** ⇒ 抽一个组件，图标与判定只有一份。

  ## 图标语义（用户 2026-10-03 的原话：「已置顶的向上箭头顶端加一横线」）
  · 未置顶：向上箭头 `↑`
  · 已置顶：箭头顶端**加一条横线**（`⇡` 之上压一条横杠）—— 这就是「顶到头了」的意思
  用**内联 SVG** 而不是 emoji/字符：`⇧` 与 `⌃` 这类字符**没有**「顶端带横线」的变体，
  而两个 Unicode 字符叠一起在不同字体下会错位；SVG 则是像素级可控。
  （项目已有内联 SVG 先例：`ShelfView.vue` 的封面图标。）

  ## 再次点击 = 取消置顶
  调 `st.togglePin(id)`：已置顶 ⇒ 排回置顶前的位置（见 store 里 `orderBeforePin` 的注释）。
  tooltip 会说明当前点击的**后果**（「置顶」/「取消置顶并排回原位」），不要只写动作名。
-->
<template>
  <button
    class="pin-btn"
    :class="{ on: pinned, block }"
    :title="tip"
    :aria-pressed="pinned"
    @click.stop="onToggle"
  >
    <svg viewBox="0 16 16" width="13" height="13" aria-hidden="true">
      <!-- 箭杆 + 箭头 -->
      <path
        d="M8 13V4.5M8 3l-3.2 3.4M8 3l3.2 3.4"
        fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round"
      />
      <!-- ★ 已置顶：箭头顶端那条横线（未置顶时不渲染 ⇒ 图标差异一眼可见） -->
      <path v-if="pinned" d="M4.5 1.6h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSourcesStore } from '../stores/sources';

const props = defineProps<{
  id: string;
  /** 源管理表格里那枚按钮更小更紧（`block` = 方块描边风格） */
  block?: boolean;
}>();

const emit = defineEmits<{ toggle: [id: string] }>();
const st = useSourcesStore();

/** 判定放在组件里 ⇒ 三处调用点只管渲染，规则只有一份 */
const pinned = computed(() => st.isPinned(props.id));

/**
 * `#238` 允许多个源同时置顶 ⇒ tooltip 必须说清「我排第几」。
 *
 * 用户 2026-10-03 的原话：「点击多个源置顶……最后置顶的在最顶」——
 * 有了多个置顶源，光说「已置顶」用户会不知道**这一个是第几**，
 * 也不知道再点一下会发生什么。tooltip 承担这两件事（悬停即可看到，不占界面）。
 */
const tip = computed(() => {
  if (!pinned.value) return '置顶这个源（排到列表最顶；可以置顶多个，越晚置顶越靠上）';
  const rank = st.pinRank(props.id);
  const head = rank ? `已置顶（第 ${rank} 位，最后置顶的排最顶）` : '已置顶';
  return `${head} · 点击取消置顶，排回原来的位置`;
});

function onToggle(): void {
  emit('toggle', props.id);
}
</script>

<style scoped>
/* 与两处调用点的既有观感对齐：发现页是「幽灵小按钮」，源管理是 `btn mini` 的方块风格 */
.pin-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.pin-btn:hover { background: var(--brand-soft); color: var(--brand); }
.pin-btn.on { color: var(--brand); background: var(--brand-soft); }
/* `#284` 回归修正（用户 2026-10-05）：block 原来 24×24，比同行 btn mini（实高约 22px）
   高一截；调到 22×22 与搜索/编辑/更多同高。图标 13px + 边框 2px 远放得下，无裁切。
   `#296`（用户 2026-10-06）：只统一了**高度**还不够 —— 底色与字色仍和同行的 `btn mini` 不一致
   （`btn mini` = `--bg3` 填充 + `--text` 字色；这里原来是**透明底 + `--muted` 灰图标**）
   ⇒ 一行里「一个灰的、两个亮的」，用户一眼就看出来。现在把 rest 态的三项令牌
   逐字对齐 `.btn`（`theme.css:92-98`），并让 hover 也走 `.btn:hover` 的同一组
   （`--bg4` + `--acc-dim`）—— 置顶态（`.on`）仍用品牌色，那是**状态**不是底色。 */
.pin-btn.block {
  width: 22px; height: 22px;
  vertical-align: middle;
  background: var(--bg3);
  border-color: var(--line2);
  color: var(--text);
}
.pin-btn.block:hover { background: var(--bg4); border-color: var(--acc-dim); color: var(--text); }
.pin-btn.block.on { background: var(--brand-soft); border-color: var(--acc-dim); color: var(--brand); }
</style>
