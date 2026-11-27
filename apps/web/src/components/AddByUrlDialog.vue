<script setup lang="ts">
/**
 * `#625` **粘贴链接加书**（URL → 书源识别）。
 *
 * ## 为什么需要它
 * `bookUrlPattern` 在 `#617` 之后已经有「搜索响应 URL 命中 ⇒ 当详情页」的分支，但真源实测
 * 106 个带 pattern 的源**命中 0**（关键词搜索的响应 URL 从不等于详情页 URL）—— 那条只是安全网。
 * pattern 真正被上游依赖的地方是**反向**：用户手里只有一只详情页链接时，反查该用哪个源
 * （`BookshelfViewModel.addBookByUrl:49-110`）。缺了这条，106 个 pattern 等于白配。
 *
 * ## 交互（严格按上游三级链，界面只做呈现 + 兜底）
 *   1. 粘贴一只或多只链接（换行分隔，上游 `bookUrls.split("\n")`）
 *   2. 「识别」→ 服务端跑 core 的 `resolveSourceByUrls`（纯本地判定，不发请求）
 *   3. 每行显示：命中的源名 + **命中方式**（`,{origin}` / 域名 / pattern）
 *      —— 「为什么给我选这个源」必须可见，否则用户只会觉得「乱选了一个」
 *   4. 「进详情」= `reader.openDetail(sourceId, { payload: { bookUrl } })`
 *      （详情页里再「加入书架」，与从搜索结果进来的路径完全一致 —— 不另造一条入库通道）
 *   5. 未命中的行：给出**手动选源**下拉（同域名优先），仍然能进详情
 *
 * ⚠️ 不在这里直接写书架：上游是 `WebBook.getBookInfoAwait` 拿到书名/作者后才入库，
 * 我们若只写 `bookUrl` 会得到一条无书名的空壳（用户见到的是「书名是链接」那种老问题）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { getSources, resolveUrlSource, type SourceInfo, type UrlResolveItem } from '../api';
import { useReaderStore } from '../stores/reader';

const emit = defineEmits<{ close: [] }>();
const reader = useReaderStore();

const text = ref('');
const busy = ref(false);
const err = ref('');
const items = ref<UrlResolveItem[]>([]);
const candidates = ref(0);
/** 手动选源用的源列表（**只在有未命中行时才拉**，避免每次开对话框都打一次全量） */
const sources = ref<SourceInfo[]>([]);
const loadingSources = ref(false);

const hitCount = computed(() => items.value.filter((i) => i.match).length);
const missItems = computed(() => items.value.filter((i) => !i.match));

/** 命中方式 → 用户能懂的中文（上游三级链） */
const BY_LABEL: Record<string, string> = {
  'url-option-origin': '链接里指定了源',
  'base-url': '域名匹配',
  bookUrlPattern: 'bookUrlPattern 匹配',
};

async function resolve(): Promise<void> {
  const t = text.value.trim();
  if (!t) {
    err.value = '先粘贴链接';
    return;
  }
  busy.value = true;
  err.value = '';
  try {
    const r = await resolveUrlSource(t);
    items.value = r.items;
    candidates.value = r.candidates;
    if (!r.items.length) err.value = '没有识别到任何链接（每行一只）';
    // 有未命中 ⇒ 才去拉源列表供手动选
    if (r.items.some((i) => !i.match) && !sources.value.length) void loadSources();
  } catch (e) {
    err.value = '识别失败：' + String(e instanceof Error ? e.message : e);
  } finally {
    busy.value = false;
  }
}

async function loadSources(): Promise<void> {
  loadingSources.value = true;
  try {
    sources.value = (await getSources('legado')).filter((s) => s.state?.enabled !== false);
  } catch {
    /* 拉不到就只显示「未命中」，不阻断 */
  } finally {
    loadingSources.value = false;
  }
}

/** 未命中时的手动候选：**同域名的排前面**（用户粘的多半就是这家站的链接） */
function manualOptions(url: string): SourceInfo[] {
  const host = (() => {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  const score = (s: SourceInfo) => {
    if (!host) return 0;
    const u = String(s.url ?? '').toLowerCase();
    return u.includes(host) ? 0 : 1;
  };
  return sources.value
    .slice()
    .sort((a, b) => score(a) - score(b) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh'));
}

function openDetail(url: string, sourceId: string): void {
  if (!sourceId) return;
  reader.openDetail(sourceId, { payload: { bookUrl: url }, title: '' });
  emit('close');
}

/** 手动选源（未命中行） */
function pickManual(url: string, ev: Event): void {
  const id = (ev.target as HTMLSelectElement).value;
  if (id) openDetail(url, id);
}

/** Esc 关自己 */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="abu-mask" @click.self="emit('close')">
    <div class="abu-panel">
      <div class="abu-head">
        <strong>🔗 粘贴链接加书</strong>
        <span class="abu-sub">自动识别该用哪个书源</span>
        <span style="flex: 1"></span>
        <button class="btn mini" @click="emit('close')">✕</button>
      </div>

      <div class="abu-body">
        <textarea
          v-model="text"
          class="abu-input"
          rows="3"
          spellcheck="false"
          placeholder="粘贴书籍详情页链接，一行一只。例如：&#10;https://www.example.com/book/12345&#10;也可以带源选项：https://www.example.com/book/12345,{&quot;method&quot;:&quot;GET&quot;}"
          @keydown.enter.ctrl.prevent="resolve"
        ></textarea>

        <div class="abu-row">
          <button class="btn mini primary" :disabled="busy" @click="resolve">
            {{ busy ? '识别中…' : '识别' }}
          </button>
          <span class="abu-hint" v-if="items.length">
            {{ items.length }} 只链接 · 命中 <b>{{ hitCount }}</b> / 未命中 {{ missItems.length }}
            <span v-if="candidates">（候选源 {{ candidates }} 只）</span>
          </span>
          <span v-else class="abu-hint">先「识别」，再决定进哪只源的详情页</span>
        </div>

        <div v-if="err" class="abu-err">{{ err }}</div>

        <div v-if="items.length" class="abu-list">
          <div v-for="(it, i) in items" :key="i" class="abu-item">
            <div class="abu-url" :title="it.url">{{ it.url }}</div>

            <template v-if="it.match">
              <div class="abu-src">
                <span class="abu-name">{{ it.match.sourceName || it.match.sourceId }}</span>
                <span class="abu-by">{{ BY_LABEL[it.match.by] ?? it.match.by }}</span>
              </div>
              <button class="btn mini primary" @click="openDetail(it.match.bookUrl, it.match.sourceId)">进详情 →</button>
            </template>

            <template v-else>
              <div class="abu-src">
                <span class="abu-name miss">未识别到书源</span>
                <span class="abu-by">可在源管理里给该站点配 bookUrlPattern</span>
              </div>
              <select
                class="abu-select" :disabled="loadingSources || !sources.length"
                :title="'手动指定源' + (loadingSources ? '（加载中）' : '')" @change="pickManual(it.url, $event)"
              >
                <option value="">{{ loadingSources ? '加载源…' : '手动选源进详情' }}</option>
                <option v-for="s in manualOptions(it.url)" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </template>
          </div>
        </div>

        <p class="abu-tip">
          识别用的是书源的 <code>bookUrlPattern</code>（详情页 URL 正则）：先看链接里是否写了
          <code>,{"origin":"…"}</code>，再比域名，最后在所有启用的源里整串匹配。
          详情页里点「加入书架」才会入库。
        </p>
      </div>

      <div class="abu-foot">
        <button class="btn mini" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.abu-mask {
  position: fixed; inset: 0; z-index: 1030;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.abu-panel {
  width: min(560px, 100%);
  background: var(--bg-1); border: 1px solid var(--border-strong);
  border-radius: var(--r); box-shadow: var(--shadow);
  animation: fadein 0.16s ease;
}
.abu-head {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 14px; border-bottom: 1px solid var(--border);
  color: var(--text-0); font-size: 14px; min-width: 0;
}
.abu-sub { font-size: 11.5px; color: var(--muted); }
.abu-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.abu-input {
  width: 100%; box-sizing: border-box; resize: vertical;
  padding: 9px 10px; border-radius: 9px; line-height: 1.55;
  background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0);
  font-family: var(--mono, ui-monospace, monospace); font-size: 12px; outline: none;
}
.abu-input:focus { border-color: var(--acc-dim); }
.abu-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.abu-hint { font-size: 11.5px; color: var(--muted); }
.abu-hint b { color: var(--text-0); }
.abu-err { color: var(--red); font-size: 12px; }
.abu-list { display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow: auto; }
.abu-item {
  display: grid; grid-template-columns: 1fr auto; gap: 4px 10px;
  align-items: center; padding: 8px 10px; border-radius: 9px;
  background: var(--bg-2); border: 1px solid var(--line);
}
.abu-url {
  grid-column: 1 / -1; font-size: 11px; color: var(--muted);
  font-family: var(--mono, ui-monospace, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.abu-src { display: flex; align-items: center; gap: 7px; min-width: 0; }
.abu-name { font-size: 12.5px; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.abu-name.miss { color: var(--muted); }
.abu-by {
  flex: none; font-size: 10.5px; color: var(--acc);
  border: 1px solid var(--acc-dim); border-radius: 5px; padding: 0 5px; line-height: 16px;
}
.abu-select {
  padding: 5px 8px; border-radius: 8px; max-width: 190px;
  background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0);
  font-family: var(--font); font-size: 11.5px; outline: none;
}
.abu-tip { margin: 0; font-size: 11px; line-height: 1.6; color: var(--muted); }
.abu-tip code { font-size: 10.5px; color: var(--text-1); }
.abu-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 11px 14px; border-top: 1px solid var(--border);
}
</style>
