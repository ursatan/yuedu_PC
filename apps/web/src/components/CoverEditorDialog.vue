<script setup lang="ts">
/**
 * `#204` 封面自定义对话框 —— 从书架卡的封面浮层「🖼 换封面」进入。
 *
 * 三种改法（对齐上游 Legado「换封面」的语义）：
 *   ① **上传本地图片** → 存进服务端 blob，`customCoverUrl` 指向同源相对 URL；
 *   ② **填图片 URL**   → 同样落 `customCoverUrl`（不下载图片，只存链接；跨设备也能用）；
 *   ③ **清除自定义**   → `customCoverUrl = null`，界面回落到源封面。
 *
 * ★ 为什么不提供「删除图片文件」：blob 有 LRU 兜底，且同一本书反复换封面时旧 blob
 *   留着能回滚；立刻删等于把「误换」变成不可撤销。
 *
 * ★ 为什么不在这里直接调 `PUT /api/user/books`：那个端点是「整条 upsert + 缺字段补默认值」，
 *   改一个字段会把没传的字段重置成默认值（**实测会丢阅读进度**）⇒ 必须走专用端点。
 */
import { computed, ref, watch } from 'vue';
import { clearBookCover, setBookCoverUrl, uploadBookCover } from '../user-data';
import { encodeItemKey } from '../utils/user-map';
import type { ShelfBook } from '../stores/reader';

const props = defineProps<{ book: ShelfBook | null }>();
const emit = defineEmits<{ close: []; done: [bookUrl: string] }>();

const fileInput = ref<HTMLInputElement | null>(null);
const urlText = ref('');
const busy = ref(false);
const err = ref('');

/** 允许的类型与上限必须与**服务端**一致（`apps/server/src/index.ts` 的 COVER_MIME / COVER_MAX_BYTES）——
 *  前端先挡一次是为了即时反馈，服务端再挡一次是为了不信任客户端。 */
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * ★★ `ShelfBook.key` 是**解码后**的 key（`contractToShelfBook` 里 `key: decodeItemKey(c.bookUrl)`），
 *   而服务端的 `bookUrl` 是**编码后**的形态 ⇒ 直接把 `book.key` 发过去会 `BOOK_NOT_FOUND`（实测 404）。
 *   本仓铁律：凡是把 `b.key` 当 `bookUrl` 用，必须过 `encodeItemKey`。
 *   （与 `#202` 本地书 `bookUrl` 由前端算、书架键一律 encode 的口径一致。）
 */
const bookUrl = computed(() => (props.book?.key ? encodeItemKey(props.book.key) : ''));
const hasCustom = computed(() => !!props.book?.customCoverUrl);

watch(
  () => props.book?.key,
  () => {
    urlText.value = '';
    err.value = '';
  },
);

async function onPick(ev: Event): Promise<void> {
  const f = (ev.target as HTMLInputElement).files?.[0];
  // 选完立刻清空 value —— 否则同名文件再选一次不触发 change（用户会以为坏了）
  if (ev.target) (ev.target as HTMLInputElement).value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) {
    err.value = `「${f.name}」不是图片文件`;
    return;
  }
  if (f.size > MAX_BYTES) {
    err.value = `${(f.size / 1024 / 1024).toFixed(1)}MB 超过上限 ${MAX_BYTES / 1024 / 1024}MB`;
    return;
  }
  busy.value = true;
  err.value = '';
  try {
    const r = await uploadBookCover(bookUrl.value, f);
    emit('done', r.bookUrl);
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}

async function applyUrl(): Promise<void> {
  const u = urlText.value.trim();
  if (!u) {
    err.value = '先填一个图片地址';
    return;
  }
  // 只认 http(s) 与同源相对路径 —— 塞 javascript: 之类会让 <img src> 变成注入面
  if (!/^https?:\/\//i.test(u) && !u.startsWith('/')) {
    err.value = '只支持 http(s) 开头或 / 开头的站内路径';
    return;
  }
  busy.value = true;
  err.value = '';
  try {
    await setBookCoverUrl(bookUrl.value, u);
    emit('done', bookUrl.value);
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}

async function clear(): Promise<void> {
  busy.value = true;
  err.value = '';
  try {
    await clearBookCover(bookUrl.value);
    emit('done', bookUrl.value);
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="bookUrl" class="ce-mask" @click.self="emit('close')">
    <div class="ce-panel" role="dialog" aria-label="换封面" data-cover-editor>
      <div class="ce-head">
        <strong>换封面</strong>
        <button class="ce-x" title="关闭" data-cover-close @click="emit('close')">✕</button>
      </div>

      <div class="ce-body">
        <p class="ce-book">《{{ book?.title ?? '（这本书已不在当前筛选里）' }}》</p>
        <p v-if="hasCustom" class="ce-cur">当前用的是<strong>自定义封面</strong>（清除后自动回落到源封面）</p>
        <p v-else class="ce-cur">当前用的是<strong>源封面</strong></p>

        <div class="ce-row">
          <input ref="fileInput" type="file" :accept="ACCEPT" hidden data-cover-file @change="onPick" />
          <button class="btn" :disabled="busy" data-cover-pick @click="fileInput?.click()">🖼 选本地图片</button>
          <span class="ce-hint">png / jpg / webp / gif / avif，≤ 8MB</span>
        </div>

        <div class="ce-or"><span>或</span></div>

        <div class="ce-row">
          <input
            v-model="urlText" class="ce-input" type="text" placeholder="https://… 图片地址"
            data-cover-url @keyup.enter="applyUrl"
          />
          <button class="btn" :disabled="busy || !urlText.trim()" data-cover-apply @click="applyUrl">用这个地址</button>
        </div>

        <p v-if="err" class="ce-err" data-cover-err>{{ err }}</p>
      </div>

      <div class="ce-foot">
        <button class="btn" :disabled="busy || !hasCustom" data-cover-clear @click="clear">↺ 清除自定义</button>
        <span class="ce-spacer" />
        <button class="btn" data-cover-cancel @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ce-mask {
  position: fixed; inset: 0; z-index: 300;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.ce-panel {
  width: min(460px, 92vw);
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: 12px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
  display: flex; flex-direction: column;
  max-height: 86vh;
}
.ce-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; border-bottom: 1px solid var(--line);
}
.ce-head strong { font-size: 14px; }
.ce-x { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 14px; }
.ce-x:hover { color: var(--fg); }
.ce-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow: auto; flex: 1; min-height: 0; }
.ce-book { margin: 0; font-size: 13px; font-weight: 600; }
.ce-cur { margin: 0; font-size: 12px; color: var(--muted); }
.ce-cur strong { color: var(--fg); }
.ce-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ce-hint { font-size: 11px; color: var(--faint); }
.ce-or { display: flex; align-items: center; gap: 8px; color: var(--faint); font-size: 11px; }
.ce-or::before, .ce-or::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.ce-input {
  flex: 1; min-width: 180px; padding: 6px 8px;
  background: var(--bg-3); color: var(--fg);
  border: 1px solid var(--line); border-radius: 6px; font-size: 12px;
}
.ce-err { margin: 0; font-size: 12px; color: var(--red); }
.ce-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 14px; border-top: 1px solid var(--line);
}
.ce-spacer { flex: 1; }
</style>
