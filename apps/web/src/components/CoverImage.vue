<script setup lang="ts">
/**
 * `#163` **封面图片**（共用组件）—— 真封面 / 生成的默认封面，二选一。
 *
 * ## ⚠️ 「封面」= 仅封面图片，**不含**图片下方的书名/作者/最新章节（用户 2026-10-01 明确口径）
 * 这两件事**互不干涉**：本组件只管「这块图片长什么样」，卡片下方的信息恒显示，由各页面自己渲染。
 * 曾经有过反向规则（`#172`：「有真封面就隐藏卡片下方的书名/作者」）—— 已撤销，理由见
 * `styles/ui-theme.ts` 里 {@link useDefaultCover} 下方的那段说明，**别再引入同类联动**。
 *
 * ## 本组件的完整规则（对齐上游，就这几条）
 * | 情况 | 封面图片 | 封面上是否画字 |
 * |---|---|---|
 * | 源站给了封面，**换书加载中** | 占位底色（微光），**不显示旧图** | 不画 |
 * | 源站给了封面，**同一本书封面升级** | 先显示旧图，新图到了再替换 | 不画 |
 * | 源站给了封面 **且加载成功** | 真图 | **不画** |
 * | 源站给了封面但**加载失败** | 默认封面（占位）；同书升级时保留旧图 | **画书名 + 作者** |
 * | 源站没给封面地址 | 默认封面（占位） | **画书名 + 作者** |
 * | 用户开启「强制使用默认封面」 | 默认封面（占位） | **画书名 + 作者** |
 *
 * ⚠️ 「换书加载中」那一行是 `#176` 补的（用户实测「切分类会看到之前图片残留」）：
 * **loading 帧不能显示旧图、也不能画字** —— 会变成「这本书叫 A、封面却是 B」。
 * 但「同一本书自己换封面地址」不同（`#750`）：上游详情规则会把列表封面
 * `_288x384` 换成详情封面 `_600x800`（Legado `BookInfo.kt:142-148`），
 * 此时**保留旧图当占位**（新图失败也保留），才不会出现「卡片 → 详情封面空白一闪」。
 * 判据见下面 {@link ownerKey}。状态机见 `state` 的注释。
 *
 * 上游出处（逐条核对过，不是照印象写的）：
 * · 「强制 ⇒ 无视真实地址」→ `BookCover.load()`（`BookCover.kt:601-604`）；
 * · 「地址为空 ⇒ 直接给默认图并 invalidate」→ `BookCover.kt:606-614`；
 * · 「加载失败 ⇒ `needNameBitmap=true` 触发画字」→ `CoverImageView.kt:522-529`
 *   （Glide 的 `onLoadFailed` 里把 needNameBitmap 置真）+ `.error(defaultDrawable)`（`:629`）；
 * · 「加载成功 ⇒ `needNameBitmap.remove` 不画字」→ `CoverImageView.kt:531-543`；
 * · 真正的绘制入口 → `CoverImageView.onDraw()`（`:199-227`）：**`useDefaultCover` 或 needNameBitmap 为真才画**。
 *
 * ## 为什么要有这个组件（而不是各页面自己写 v-if）
 * 上游 `BookCover.load()` 是**所有封面**的唯一入口。本仓此前有 **12 处**各自手写的
 * `<img v-if=cover>` / `<div class="poster ph">`，同一条规则写了 12 遍 ——
 * 改一个设置就得改 12 处，漏一处就是「设置页显示已开启、书架上没生效」这种最难查的静默不一致。
 * 所以这里只做一次：**判空 → 生成 → 图片加载失败回落**，三件事全部收口。
 *
 * ## 生成封面的文字规则
 * · 画不画书名 / 作者 → `BookCover.upDefaultCover()`（`BookCover.kt:66-83`，分日/夜槽）；
 * · 文字清洗（去标点）→ `normalizeCoverText`（`CoverImageView.kt:52-55`，去 `\p{P}`）；
 * · 竖排 / 横排 → `coverHorizontal`（`BookCover.kt:78`）；
 * · 字号分档 → `coverTitleDivisor`（`CoverImageView.kt:80-92`）；
 * · 配色 → `coverTextColors`（**本仓扩展**，理由见该函数注释）。
 *
 * ## 作用域样式的注意点（改这里之前先看）
 * 父组件的 **scoped** 样式只会命中本组件的**根元素**（Vue 会把父的 scope id 加到子根上），
 * 所以父级给 `.poster` / `.cover` 这类**尺寸 + 圆角 + overflow** 样式仍然生效；
 * 但父级的 `.poster.ph .t` 这类**后代选择器不会**命中本组件内部的 `.t`。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useReaderStore } from '../stores/reader';
import { coverSwapMode, imgSrc } from '../utils/img';
import { BUILT_IN_DEFAULT_COVER_PATH } from '../utils/default-cover-core';
import { defaultCoverBg } from '../utils/default-cover';
import {
  coverAuthorLayout,
  coverHorizontalLayout,
  coverParamsFor,
  coverTextColors,
  coverTitleDivisor,
  coverTitleLayout,
  normalizeCoverText,
  useDefaultCover,
  withAlpha,
} from '../styles/ui-theme';

const props = defineProps<{
  /** 源站给的封面地址（可空） */
  cover?: string | null;
  sourceId?: string;
  /** 书名 / 标题（生成封面时画上去） */
  title?: string | null;
  /** 作者（生成封面时画上去；仅当画了书名才有意义 —— 上游联动） */
  author?: string | null;
  /** 用来挑内置渐变底色的下标（与原各页面的 `posterClass(i)` 同一算法：`p1`~`p8`） */
  index?: number;
}>();

const reader = useReaderStore();

/** 这一张要不要走生成封面（强制开关优先，其次「源站根本没给」） */
const useDefault = computed(() => useDefaultCover(props.cover, reader.prefs.cover));
/**
 * ★ `#176` 加载状态机（用户 2026-10-01 实测：「切换分类，加载图片时会看到之前图片残留」）。
 *
 * ## 为什么需要三态，而不是一个 `failed` 布尔
 * 旧实现只有 `failed`（`@error` 时置真）。它有两个漏洞，**都表现为「旧封面残留」**：
 * ① **url 变更时不重置**：`real` 变成新地址后 `failed` 仍是上一张留下的 `true`
 *    ⇒ 直接回落生成封面；更糟的是若上一张是成功（`failed=false`），
 *    `<img>` 的 `src` 在新图解码完成前**仍显示旧图**（浏览器行为：新src 未就绪时旧图不卸载）。
 * ② **DOM 复用**：列表 `v-for` 用数组下标做 key（见 `DiscoverView` 的 `:key="i"`）⇒
 *    切分类时 Vue 认为「还是这批节点」，只改属性、不重建 DOM ⇒ 旧 `<img>` 实例被复用。
 *
 * ## 三态语义（用户 2026-10-01 明确要求）
 * · `loading` ⇒ **只显示占位底色，绝不显示旧图**（`:src` 置空 ⇒ 浏览器卸载旧图）；
 * · `success` ⇒ 展示网络图；
 * · `error`   ⇒ 展示默认图并**叠加书名作者文字**。
 *
 * ## 为什么 `loading` 要置空 `src` 而不是留着
 * 光靠 `:key` 换 img 节点也能卸载旧图，但那样每次切分类都重建节点、丢失浏览器图片缓存命中。
 * 置空 `src` 的做法更轻：节点还在，缓存还在，只是**这一帧不显示任何旧内容**。
 */
type LoadState = 'idle' | 'loading' | 'success' | 'error';
const state = ref<LoadState>('idle');
/** 当前真正在显示的地址（`loading` 时为 '' ⇒ 不显示旧图） */
const shown = ref('');
/** 本次请求的 token：防止「后发先至」——旧请求晚回来时不得覆盖新图 */
let token = 0;

/**
 * `#750` **这张封面属于哪本书**（同一本书的封面地址允许升级，换书不允许残留）。
 *
 * 为什么不用书名+作者（规范化后的）：详情规则可能补全/改写书名（上游 `canReName` 才覆盖，
 * 但本仓引擎直接取规则值）⇒ 用**渲染层拿到的原始标题**比规范化后的稳。
 * 为什么必须带 `sourceId`：不同源可能有同名书；换源时旧图必须卸载。
 * 空标题 ⇒ 返回空串（调用方按「身份未知 = 换书」处理，保守地清空）。
 */
function ownerKey(): string {
  const t = String(props.title ?? '').trim();
  if (!t) return '';
  return `${props.sourceId ?? ''}\u0000${t}`;
}
/** 上一帧的 owner（用来判「是不是同一本书」） */
let lastOwner = '';

const params = computed(() => coverParamsFor(reader.prefs.cover, reader.uiIsNight));
const keepPunct = computed(() => reader.prefs.cover.coverKeepPunctuation);
const name = computed(() => (params.value.showName ? normalizeCoverText(props.title, keepPunct.value) : ''));
/** 上游 `CoverConfigFragment.kt:52-55`：书名不画时作者选项是禁用的 ⇒ 作者也不画 */
const author = computed(() => (params.value.showAuthor && name.value ? normalizeCoverText(props.author, keepPunct.value) : ''));
/**
 * 默认封面层的底图（没有 = 内置默认封面 `assets/default-cover.jpg`）。
 * ★ 自定义图偏好里存的是标记串，真正的 `blob:` 地址由 `default-cover.ts` 在启动时
 *   从 IndexedDB 还原；读不出来/图坏了 ⇒ 这里回落内置图（不会出现白块）。
 */
const bgStyle = computed(() => {
  const bg = defaultCoverBg(params.value.bgImage, BUILT_IN_DEFAULT_COVER_PATH);
  return bg ? { backgroundImage: `url("${bg}")` } : undefined;
});
const grad = computed(() => `p${((props.index ?? 0) % 8) + 1}`);

/** 该显示真图吗（生成封面的两种情况都不显示） */
const wantReal = computed(() => {
  if (useDefault.value) return '';
  return imgSrc(props.cover, { sourceId: props.sourceId ?? '', cover: true });
});
/** `state === 'success'` 才挂真图；其余都走生成封面/占位 */
const real = computed(() => (state.value === 'success' ? shown.value : ''));

/**
 * 源地址/强制开关/所属书 任一变化 ⇒ 决定「清空旧图」还是「保留旧图占位」：
 * · **换书**（owner 变了或未知）⇒ `loading` + 清空 `src`（`#176`：不残留上一本的图）；
 * · **同一本书**（七猫详情把 `_288x384` 换成 `_600x800`）⇒ 保留已显示的旧图，
 *   新图预加载成功再替换；加载失败也保留旧图（`#750`，对齐上游「详情只在非空时替换封面」）。
 * ⚠️ 放 `watch` 而不是 `computed`：需求是「变更那一刻」就做决定，等渲染再清就晚了一帧。
 */
watch(() => [wantReal.value, ownerKey()] as const, ([u, owner]) => {
  token += 1;
  const mode = coverSwapMode(lastOwner, owner, state.value === 'success' ? shown.value : '');
  lastOwner = owner;
  // 地址没变（只是书名等身份字段变了）⇒ 同一张图，不重载、不闪
  if (u && state.value === 'success' && shown.value === u) return;
  if (!u) {
    // 无封面 / 强制默认 ⇒ 生成封面（带书名作者）
    state.value = 'idle';
    shown.value = '';
    return;
  }
  if (mode === 'keep-old') {
    // 同书封面升级：旧图先占位，新图到了再换（失败保留旧图）
    void preload(u, token, true);
    return;
  }
  state.value = 'loading';
  shown.value = '';           // ★ 换书：卸载旧图，这一帧只留占位底色
  void preload(u, token, false);
}, { immediate: true });

/**
 * 预加载一张图，成功后**只有 token 仍是最新**才提交（防旧请求覆盖新图）。
 * `keepOnError`（同书升级）：失败时**什么都不改** —— 继续显示旧图，
 * 不要回落默认封面（那会闪一下再回来，正是 `#750` 用户报的形态）。
 */
function preload(url: string, tk: number, keepOnError: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const im = new Image();
    im.onload = () => {
      if (tk !== token) { resolve(); return; }   // 已被更新的请求取代 ⇒ 丢弃
      state.value = 'success';
      shown.value = url;
      resolve();
    };
    im.onerror = () => {
      if (tk !== token) { resolve(); return; }
      if (!keepOnError) {
        state.value = 'error';                   // ⇒ 回落默认封面 + 画字
        shown.value = '';
      }
      resolve();
    };
    im.src = url;
  });
}

/**
 * 文字配色 —— 描边用主题底色、字面用主题强调色（照抄 `generateCoverBitmap`，
 * `CoverImageView.kt:391-396`：STROKE `backgroundColor` → FILL `accentColor`）。
 * ⚠️ 旧实现是白字 + 黑投影，落在内置默认封面那张**浅色宣纸底**上几乎看不见（本轮实测确认）。
 */
const ink = computed(() => {
  const t = reader.uiTheme;
  const c = coverTextColors(t.accentColor || '#A070FF', t.backgroundColor || '#0B0D12');
  return {
    fill: c.fill,
    strokeDark: withAlpha(c.strokeDark, c.alpha),
    strokeLight: withAlpha(c.strokeLight, c.alpha),
  };
});
/** 长书名降一档字号（上游 `coverTitleTextSize`：`viewWidth / 9`） */
const titleDiv = computed(() => coverTitleDivisor(Array.from(name.value).length));
/**
 * 封面上要不要画字 —— **只在真正是「默认封面」时**。
 * `loading` 那一帧不是默认封面（只是等真图的空位），画字会变成「旧书名配新封面」。
 */
const showText = computed(() => useDefault.value || state.value === 'error');

/* ---- `#186` 横排 / 竖排的**自动切换**（宽扁容器强制横排）----
 * ## 为什么不能只看用户 pref
 * 旧实现横竖排只由 `reader.prefs.cover.coverHorizontal` 决定 —— 但 `#184` 的横屏卡片
 * 是 **16:10 宽扁容器**，竖排算法（首列 0.2H 起、0.8H/0.9H 换列阈值）是给「高瘦容器」设计的：
 * 扁容器里只能排 1 列，书名挤成一行、作者列(0.8W)与书名列重叠
 * ⇒ 用户 2026-10-01 实测「横屏布局：书名作者文字错乱」，并拍板
 * 「**横屏时，书名/作者切为横向展示**」。
 * ⇒ 判据用**实测宽高比**（`ResizeObserver` 量出的 `box`，与上游 `renderWidth/renderHeight`
 *   同一口径）：`w/h > 1.2` 即宽扁 ⇒ 强制横排。竖版容器（2:3 / 3:4）不受影响，
 *   用户 pref `coverHorizontal` 在竖版下仍照常生效（上游语义保留）。
 * ⚠️ 阈值 1.2 而不是 1.0：给接近方形的容器留余量，竖排在这种容器里仍排得下。 */
const isWideBox = computed(() => {
  const { w, h } = box.value;
  return w > 0 && h > 0 && w / h > 1.2;
});
/** 横排 = 用户显式选择（上游语义）或宽扁容器（`#184` 横屏卡片，本仓扩展） */
const horizontal = computed(() => reader.prefs.cover.coverHorizontal || isWideBox.value);
/** 横排字号必须同时受**高度**约束（16:10 下按宽度取字号 4 行必然溢出，见 {@link coverHorizontalLayout}） */
const horizontalLayout = computed(() => {
  const { w, h } = box.value;
  if (w <= 0 || h <= 0) return null;
  return coverHorizontalLayout(w, h, Array.from(name.value).length);
});
/** 量到尺寸之前不注入变量 ⇒ CSS 里的 cqw 兜底值照常生效（避免首帧字号为 0） */
const horizontalStyle = computed(() => {
  const l = horizontalLayout.value;
  if (!l || l.titleSize <= 0) return undefined;
  return {
    '--cv-ttop': `${l.titleTop}px`,
    '--cv-tfs': `${l.titleSize}px`,
    '--cv-afs': `${l.authorSize}px`,
  } as Record<string, string>;
});

/* ---- `#177` 竖排布局：按上游逐字算出的坐标摆位（不再交给 `writing-mode`）----
 * 为什么：上游的换列/压缩是**逐字推进 + 阈值判断**（`coverTitleColumnOffsets`），
 * CSS 的 `writing-mode` 只会「按容器高度自动换列」，做不出「最后两个字压缩 1/5 行高」
 * 这类动作 ⇒ 决策搬进 TS（`styles/ui-theme.ts`，有单测），CSS 只负责摆。
 *
 * ⚠️ **必须用实测的宽高，不能假设比例**：上游用的就是 `renderWidth/renderHeight`（视图实际尺寸），
 *   而本仓各页封面比例不同（发现页 `2/3`、影院 `3/4`、书架 `2/3`）⇒ 猜比例会算错列数。
 *   做法：`ResizeObserver` 量一次，拿到像素宽高后原样喂给 {@link coverTitleLayout}（与上游同构）。
 *   容器还没布局出来时（size 为 0）返回空 ⇒ 不画字（而不是画一堆NaN 坐标）。 */
const box = ref<{ w: number; h: number }>({ w: 0, h: 0 });
const ro = ref<ResizeObserver | null>(null);
/** 生成封面那层元素（要量的就是它） */
const genEl = ref<HTMLElement | null>(null);

const titleLayout = computed(() => {
  const { w, h } = box.value;
  if (!name.value || w <= 0 || h <= 0) return null;
  return coverTitleLayout(name.value, w, h, titleDiv.value);
});
const authorLayout = computed(() => {
  const { w, h } = box.value;
  if (!author.value || w <= 0 || h <= 0) return null;
  return coverAuthorLayout(author.value, w, h);
});

onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !genEl.value) return;
  const r = new ResizeObserver((entries) => {
    const e = entries[0];
    if (!e) return;
    // contentRect 是内容盒（不含 border/padding）—— 与上游的「视图内容尺寸」一致
    box.value = { w: e.contentRect.width, h: e.contentRect.height };
  });
  r.observe(genEl.value);
  ro.value = r;
});
onBeforeUnmount(() => {
  ro.value?.disconnect();
  ro.value = null;
});
</script>

<template>
  <!-- 真图：只有 `success` 才挂 src。`loading` 时 real 为 '' ⇒ 这里不渲染 img，
       旧图被浏览器卸载，只剩下面那层占位底色（不会闪旧封面）。
       ⚠️ `data-want` 挂在两个分支上：探针要在 **loading 帧**（只有 `.cv-gen`）也能认出
       「这张卡本该加载哪张图」，否则就没法把断言限定在受控的那批 demo 卡上。 -->
  <img
    v-if="real" class="cv-img" :src="real" alt="" loading="lazy" decoding="async"
    :data-want="wantReal" :data-title="name" :data-author="author"
    @error="state = 'error'; shown = ''"
  />
  <!--
    默认封面容器：`useDefault`（无封面/强制）或 `error`（加载失败）两种情况共用。
    ⚠️ **`loading` 也渲染这一层但不给文字** —— 因为那不是「默认封面」，
       只是等真图的空位；给字会出现「旧书名配新封面」的错觉。
  -->
  <div
    v-else
    ref="genEl"
    class="cv-gen"
    :class="[grad, { 'cv-loading': state === 'loading' }]"
    :data-want="wantReal"
    :data-title="name"
    :data-author="author"
    :style="{
      ...bgStyle,
      '--cv-fill': ink.fill,
      '--cv-sd': ink.strokeDark,
      '--cv-sl': ink.strokeLight,
      '--cv-title-div': String(titleDiv),
    }"
  >
    <!-- `#177` 文字层，两种排版分开渲染：
         · 横排（coverHorizontal）⇒ 交给 CSS（上游 `drawHorizontalTextCover`
           是「标题居中 4 行 + 作者右对齐单行」，CSS 原生能做，且不涉及逐字决策）；
         · 竖排（默认，也是上游的默认）⇒ **按 {@link coverTitleLayout} 算出的坐标逐列摆**。
    ⚠️ 竖排不用 `writing-mode`：上游换列是逐字推进 + 阈值判断（`coverTitleColumnOffsets`），
         `writing-mode` 只会「按容器高度自动换列」，做不出「最后两字压缩 1/5 行高」。 -->
    <template v-if="showText">
      <!-- 横排：用户 pref（上游语义）或宽扁容器强制（`#186`，见脚本里 `isWideBox` 的说明） -->
      <div v-if="horizontal" class="cv-text h" :style="horizontalStyle">
        <span v-if="name" class="t">{{ name }}</span>
        <span v-if="author" class="a">{{ author }}</span>
      </div>
      <!-- 竖排：列 x是**中心线**（上游 `textAlign = CENTER`，`CoverImageView.kt:361`）⇒ 配 translateX(-50%)。
           ⚠️ 书名列与作者列**必须用不同的 class 区分**（`.cv-col-t` / `.cv-col-a`）：
           两者都是 `.cv-col` + `.cv-ch`，探针要读「封面上的书名」时若不区分，
           就会把作者的字也算进去 ⇒ 比对「封面文字 == 下方书名」永远不相等（假失败）。 -->
      <div v-else class="cv-text v">
        <div
          v-for="(col, ci) in titleLayout?.columns ?? []"
          :key="ci"
          class="cv-col cv-col-t"
          :style="{
            left: col.x + 'px',
            top: col.y + 'px',
            fontSize: col.fs + 'px',
            lineHeight: (titleLayout?.renderLineHeight ?? 0) + 'px',
          }"
        >
          <span v-for="(ch, k) in col.chars" :key="k" class="cv-ch">{{ ch }}</span>
        </div>
        <div
          v-if="authorLayout"
          class="cv-col cv-col-a"
          :style="{
            left: authorLayout.x + 'px',
            top: authorLayout.y + 'px',
            fontSize: authorLayout.textSize + 'px',
            lineHeight: authorLayout.renderLineHeight + 'px',
            '--cv-k': 1.2,
          }"
        >
          <span v-for="(ch, k) in authorLayout.chars" :key="k" class="cv-ch">{{ ch }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 尺寸交给父级的 class（.poster / .cover），这里只管「自己那层」长什么样 */
.cv-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  border-radius: inherit;
}
.cv-gen {
  position: relative;
  width: 100%; height: 100%;
  border-radius: inherit;
  overflow: hidden;
  background-size: cover;
  background-position: center;
  background-color: var(--bg-3);
  /* 字号按**自身宽度**换算（对齐上游 `textSize = viewWidth / 7`，CoverImageView.kt:367/407）。
     cqw = 容器查询宽度单位，1cqw = 1% 容器宽 ⇒ `100cqw / 7` 就是 viewWidth/7。 */
  container-type: inline-size;
}
/* `#176` loading 态：占位底色 + 一道微光。
   ⚠️ **绝不能显示旧图**（用户 2026-10-01 实测「切换分类，加载图片时会看到之前图片残留」）
   —— 卸载旧图靠脚本里 `shown = ''`（不挂 `src`），这里只负责让「空位」看起来是有意为之，
   而不是黑屏/白屏那种像坏了的样子。微光是纯 CSS 动画，不发任何请求。 */
.cv-loading { position: relative; }
.cv-loading::after {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.07) 50%, transparent 80%);
  animation: cv-shimmer 1.15s ease-in-out infinite;
}
@keyframes cv-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .cv-loading::after { animation: none; }
}
/* 文字：默认竖排（照抄上游默认 coverHorizontal=false），横排是用户显式选择的 */
.cv-text {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
/* 上游是「先描边（底色）、再填充（强调色）」两遍 drawText（CoverImageView.kt:391-396）。
   ⚠️ 但**不能照抄那一行的颜色**：上游的底是纯色、描边=底色（刻意造型），
   本仓的底是**图片**（内置默认封面就是浅色宣纸）⇒ 旧的白字+黑投影落在上面完全看不见。
   ⇒ 改成深浅双圈 text-shadow：底图明暗判断不出来，两边各画一圈，总有一侧起作用。
   偏移用 8 方位（4 正交 + 4 斜）近似 Android 的 STROKE，比纯 -webkit-text-stroke 更饱满。
   ⚠️ 别删掉任一圈：只留深圈 ⇒ 深色底图上字就没了；只留浅圈 ⇒ 浅色底图上字就没了。 */
.cv-text .t,
.cv-text .a,
.cv-text .cv-col {          /* `#177` 竖排：描边挂在列上（`.cv-ch` 继承 color/shadow） */
  color: var(--cv-fill);
  font-family: inherit;
  /* 内圈/外圈偏移。作者描边按上游 `strokeWidth = textSize / 5` 比书名的 `/6` 宽 ⇒ 倍率放大 */
  --cv-k: 1;
  --cv-w: calc(0.055em * var(--cv-k));
  --cv-w2: calc(0.11em * var(--cv-k));
  text-shadow:
    var(--cv-sd) 0 0, var(--cv-sd) var(--cv-w) 0, var(--cv-sd) calc(var(--cv-w) * -1) 0,
    var(--cv-sd) 0 var(--cv-w), var(--cv-sd) 0 calc(var(--cv-w) * -1),
    var(--cv-sd) var(--cv-w) var(--cv-w), var(--cv-sd) calc(var(--cv-w) * -1) var(--cv-w),
    var(--cv-sd) var(--cv-w) calc(var(--cv-w) * -1), var(--cv-sd) calc(var(--cv-w) * -1) calc(var(--cv-w) * -1),
    var(--cv-sl) 0 0, var(--cv-sl) var(--cv-w2) 0, var(--cv-sl) calc(var(--cv-w2) * -1) 0,
    var(--cv-sl) 0 var(--cv-w2), var(--cv-sl) 0 calc(var(--cv-w2) * -1),
    var(--cv-sl) var(--cv-w2) var(--cv-w2), var(--cv-sl) calc(var(--cv-w2) * -1) var(--cv-w2),
    var(--cv-sl) var(--cv-w2) calc(var(--cv-w2) * -1), var(--cv-sl) calc(var(--cv-w2) * -1) calc(var(--cv-w2) * -1);
}

/* ---- 竖排（上游 `drawNameAuthor` 的默认分支）----
   书名列从左侧 20% 起（上游 startX = renderWidth * 0.2f；逐列向右 = vertical-lr），
   作者单列靠右 80%（上游 startX = renderWidth * 0.8f），
   两列都**底部对齐**（上游 `coverTitleColumnStartY` / `startY = viewHeight*0.95 - …`）。 */
/* ---- 竖排（上游 `generateCoverBitmap` 的默认分支，`CoverImageView.kt:356-425`）----
   ⚠️ `#177` 起**不再用 `writing-mode`**：上游的换列/压缩是逐字推进 + 阈值判断
   （`coverTitleColumnOffsets`，`:100-135`），CSS 的自动换列做不出来。
   现在是：TS 算好每列的 `left`（中心线）/`top`/`font-size` → 这里按绝对定位逐字摆。
   · `.cv-text` 只做定位上下文 + 裁剪；
   · `.cv-col` 一列，`left` 是**中心线**（上游 `textAlign = CENTER`，`:361`）⇒ `translateX(-50%)`；
   · `.cv-ch` 一个字，`line-height: 1` 让行盒等于字号（与上游按 textSize 递进一致）。 */
.cv-text.v { position: absolute; inset: 0; overflow: hidden; }
.cv-col {
  position: absolute;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  font-weight: 800;
  /* ⚠️ `line-height` 由**模板按 `renderLineHeight` 内联**（`coverTitleLayout` /
     `coverAuthorLayout` 的返回值），不要在这里写死 `1`——
     字距为 0 时**描边会把上下两个字吃掉**（用户 2026-10-01 实测「竖排：下方文字遮挡上方文字」，
     放大截图确认是描边粘连）。见 `styles/ui-theme.ts` 的 `COVER_CHAR_GAP`。
     另注：`align-items: center` + 逐字行盒 ⇒ 每字水平居中，与上游 `textAlign = CENTER` 一致。 */
  white-space: nowrap;
}
.cv-ch {
  display: block;
  /* 颜色与描边都从 `.cv-col` 继承（那里挂了 text-shadow）—— 不要在这里覆盖 color，
     否则竖排的字会丢掉 `--cv-fill`。 */
}

/* ---- 横排（上游 `drawHorizontalTextCover`，CoverImageView.kt:428-498）----
   书名占 78% 宽居中、起点 viewHeight*0.1，最多 4 行（HORIZONTAL_TITLE_MAX_LINES）；
   作者右对齐、基线 viewHeight*0.92、宽 65%。

   ⚠️ `#181` 用户实测两处（横屏宽扁封面）：
   ① 「字间距太小，字挨着字」⇒ `letter-spacing: 0.14em`（上游 Android 用 Canvas 逐字 drawText，
      间距天然为 0；本仓走 CSS 必须自己补 —— 与竖排的 `COVER_CHAR_GAP` 同一个道理）。
   ② 「字上端离装饰线太近」⇒ 首行 top 由 `margin-top: 9%` 抬到 **16%**。
      上游 0.1 是给 4:3 竖版封面设计的；本仓的横屏卡片**顶部有一圈装饰花纹**
      （默认封面那张宣纸图），9% 正好压在花纹上。抬到 16% 后第一行落在用户参考图里
      「第二行字的位置」。⚠️ 别再往上抬：4 行 × (1.2+0.14) 行高在扁封面上会溢出底部。 */
.cv-text.h { display: flex; flex-direction: column; }
/* ⚠️ 字号/顶距的**权威值在 TS**（`coverHorizontalLayout`，组件内联 `--cv-ttop/--cv-tfs/--cv-afs`）：
   宽扁容器（16:10）下按宽度取字号 4 行必然溢出，必须按高度约束缩字号 —— CSS 算不了这事。
   这里的 `calc(100cqw / …)` 只是**量到尺寸之前的首帧兜底**（变量未注入时 cqw 值与竖版旧观感一致）。 */
.cv-text.h .t {
  margin: var(--cv-ttop, 16%) auto 0;
  width: 78%;
  text-align: center;
  font-size: var(--cv-tfs, calc(100cqw / var(--cv-title-div, 7)));
  font-weight: 800;
  line-height: 1.34;
  letter-spacing: 0.14em;
  /* 字距会把末字也推出去一点 ⇒ 右侧补偿，否则视觉上偏左 */
  text-indent: 0.14em;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cv-text.h .a {
  margin: auto 10% 8% auto;
  max-width: 65%;
  text-align: right;
  font-size: var(--cv-afs, calc(100cqw / 10));
  font-weight: 500;
  letter-spacing: 0.1em;
  --cv-k: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 没画任何文字时（都关了）也别让封面全空 —— 保留渐变即可，无需占位 */
</style>
