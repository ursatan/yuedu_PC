<script setup lang="ts">
/**
 * `#620` **导出本书**（txt / epub）对话框。
 *
 * ## 为什么是「前端导出 + 进度条」而不是后台任务
 * 上游是 Android 前台 Service + 通知（`ExportBookService`）。PC 没有那套；
 * 我们用「对话框里跑、进度可见、可取消」—— 用户看得到还剩几章，也能中途停。
 * 真正的重活（拼 txt / 打 epub 包）在 `@yuedu/core/export`，这里只做取数与调度。
 *
 * ## 净化默认值（照上游）
 * 上游 `useReplace = AppConfig.exportUseReplace && book.getUseReplaceRule()`
 * —— **两个开关相与**。这里默认值 = 本书当前是否启用净化（`reader` 的 `purify` 就是同一判据），
 * 用户可以在对话框里临时改（只影响本次导出，不改书设置）。
 *
 * ## 一个必须说明的副作用
 * 净化走 `reader.purify()`（复用阅读链路**同一份**实现：书级开关 / 手动规则集 / `@js:` 绑定
 * 全都在里面）。它会把 `effectiveReplaceIds` 改成「本次导出起效的规则」——
 * 那是给阅读中的「起效的替换规则」面板用的，所以导出结束**原样还原**，不污染阅读状态。
 *
 * ## `#626` 图片转存为什么要经过 `/api/proxy`
 * 正文图与封面几乎都在防盗链后面（Referer/UA/Cookie），浏览器直连必 403；而 `imgSrc()`
 * 已经把「带 `sid` / `r`（Referer）/ 内联 `data:` 走源解密规则」全部编码好了
 * （`utils/img.ts`，与阅读界面的裂图修复是同一份判据）。这里只负责 `fetch` → `Uint8Array`。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { getCachedChapter } from '../utils/chapter-cache';
import { fetchBookContent } from '../utils/book-fetch';
import { exportBook, saveBlob, type ExportDeps, type ExportStats } from '../utils/book-export';
import { imgSrc } from '../utils/img';
import { useReaderStore } from '../stores/reader';
import { toast } from '../toast';

interface ChapterLike {
  title: string;
  payload: unknown;
  isVolume?: boolean;
}

const props = defineProps<{
  sourceId: string;
  bookPayload: unknown;
  title: string;
  author?: string;
  intro?: string;
  /** `#626` 封面地址（原始地址；转存时经代理取字节） */
  coverUrl?: string;
  chapters: ChapterLike[];
}>();

const emit = defineEmits<{ close: [] }>();
const r = useReaderStore();

const format = ref<'txt' | 'epub'>('txt');
/** 范围：true = 全部；false = 用 from/to（1-based，界面上更自然） */
const allChapters = ref(true);
const from = ref(1);
const to = ref(Math.max(1, props.chapters.length));
const includeChapterTitle = ref(true);
/** 上游 `AppConfig.exportUseReplace` 的等价开关（默认 = 本书当前是否启用净化） */
const useReplace = ref(r.currentBookUseReplaceRule !== false);
/** 只导出已缓存（不发请求）—— 「我下载过，只想把它变成文件」是最常见的诉求 */
const cachedOnly = ref(false);
/** `#626` 把正文图片转存进 epub（关掉 = 正文保持远程图片地址） */
const embedImages = ref(true);

/** 目录条目里的章节地址（引擎把 URL 放在 `payload.chapterUrl`） */
function chapterUrlOf(ch: ChapterLike): string {
  const p = ch.payload as { chapterUrl?: unknown } | null | undefined;
  return p && typeof p.chapterUrl === 'string' ? p.chapterUrl : '';
}

/** `#626` 经代理取一张图的字节（失败返回 null —— 导出不因此中断） */
async function fetchImageBytes(url: string, referer?: string): Promise<Uint8Array | null> {
  const proxied = imgSrc(url, { sourceId: props.sourceId, ...(referer ? { referer } : {}) });
  if (!proxied) return null;
  const res = await fetch(proxied, { cache: 'force-cache' });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  return buf.byteLength ? new Uint8Array(buf) : null;
}

const running = ref(false);
const progress = ref<{
  done: number;
  total: number;
  failed: number;
  phase?: 'chapters' | 'images';
  images?: { done: number; total: number; failed: number };
}>({ done: 0, total: 0, failed: 0 });
const err = ref('');
const done = ref<{ stats: ExportStats; filename: string; bytes: number } | null>(null);
const cancelled = ref(false);

const totalChapters = computed(() => props.chapters.length);
const canRun = computed(() => !running.value && totalChapters.value > 0);

function normalizeRange(): { from: number; to: number } {
  if (allChapters.value) return { from: 0, to: totalChapters.value - 1 };
  const a = Math.min(Math.max(1, Number(from.value) || 1), totalChapters.value);
  const b = Math.min(Math.max(1, Number(to.value) || totalChapters.value), totalChapters.value);
  return { from: Math.min(a, b) - 1, to: Math.max(a, b) - 1 };
}

async function run(): Promise<void> {
  if (!canRun.value) return;
  running.value = true;
  cancelled.value = false;
  err.value = '';
  done.value = null;
  progress.value = { done: 0, total: 0, failed: 0 };
  // 净化会改「起效的替换规则」列表（见文件头注），先存后还
  const savedEffective = [...r.effectiveReplaceIds];

  const deps: ExportDeps = {
    async getContent(ch) {
      const payload = (ch as unknown as ChapterLike).payload;
      // ① 先读本地缓存（导出已下载的书不该再打源站）
      try {
        const c = await getCachedChapter(props.sourceId, payload);
        if (c && (c.paragraphs?.length || c.html)) return { paragraphs: c.paragraphs, html: c.html };
      } catch {
        /* 缓存读失败 ⇒ 当作没有，继续走网络 */
      }
      if (cachedOnly.value) return null;
      // ② 现抓（与阅读同一条通路：本地书 / 引擎 action）
      const r2 = await fetchBookContent(props.sourceId, props.bookPayload, { title: ch.title, payload });
      return { paragraphs: r2.paragraphs, html: r2.html };
    },
    purifyContent: useReplace.value
      ? (paragraphs, ch) => {
          // 复用阅读链路的净化（书级开关、手动规则集、@js: 绑定都在里面）
          const out = r.purify(ch.title, paragraphs);
          return { paragraphs: out.paragraphs, used: [...r.effectiveReplaceIds] };
        }
      : undefined,
    purifyTitle: useReplace.value
      ? (title, ch) => {
          const out = r.purify(title, []);
          return { title: out.title, used: [...r.effectiveReplaceIds] };
        }
      : undefined,
    /** `#626` 正文图：经代理取字节（带本源 Referer/Cookie；源有解密规则时服务端也会跑） */
    fetchImage: async (url, ch) => fetchImageBytes(url, ch.url || undefined),
    /** `#626` 封面（上游 `setCover`；取不到就不生成封面页，不报错） */
    fetchCover: props.coverUrl
      ? async () => {
          const data = await fetchImageBytes(props.coverUrl!, chapterUrlOf(props.chapters[0] ?? { title: '', payload: null }));
          return data ? { src: props.coverUrl!, data } : null;
        }
      : undefined,
    isCancelled: () => cancelled.value,
  };

  try {
    const range = normalizeRange();
    const res = await exportBook(
      {
        name: props.title,
        author: props.author,
        intro: props.intro,
        // 每章带上地址 ⇒ `#626` 才能把正文里的相对图片补全成绝对地址再取
        chapters: props.chapters.map((c) => ({ title: c.title, isVolume: c.isVolume, url: chapterUrlOf(c) })),
        from: range.from,
        to: range.to,
        format: format.value,
        includeChapterTitle: includeChapterTitle.value,
        embedImages: embedImages.value,
      },
      deps,
      (p) => {
        progress.value = p;
      },
    );
    saveBlob(res.blob, res.filename);
    done.value = { stats: res.stats, filename: res.filename, bytes: res.bytes };
    toast(`已导出 ${res.filename}（${res.stats.written} 章）`, 'ok');
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    err.value = msg === 'EXPORT_CANCELLED' ? '已取消' : msg;
  } finally {
    r.effectiveReplaceIds = savedEffective;
    running.value = false;
  }
}

function cancel(): void {
  cancelled.value = true;
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (running.value) cancel();
  else emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
</script>

<template>
  <div class="ex-mask" @click.self="running ? undefined : emit('close')">
    <div class="ex-panel">
      <div class="ex-head">
        <strong>⤓ 导出《{{ title }}》</strong>
        <span style="flex: 1"></span>
        <button class="btn mini" :disabled="running" @click="emit('close')">✕</button>
      </div>

      <div class="ex-body">
        <div class="ex-row">
          <span class="ex-label">格式</span>
          <label class="ex-opt"><input v-model="format" type="radio" value="txt" :disabled="running" /> TXT（纯文本）</label>
          <label class="ex-opt"><input v-model="format" type="radio" value="epub" :disabled="running" /> EPUB（带目录）</label>
        </div>

        <div class="ex-row">
          <span class="ex-label">范围</span>
          <label class="ex-opt"><input v-model="allChapters" type="checkbox" :disabled="running" /> 全部（{{ totalChapters }} 章）</label>
          <template v-if="!allChapters">
            <span class="ex-muted">从</span>
            <input v-model.number="from" class="ex-num" type="number" min="1" :max="totalChapters" :disabled="running" />
            <span class="ex-muted">到</span>
            <input v-model.number="to" class="ex-num" type="number" min="1" :max="totalChapters" :disabled="running" />
          </template>
        </div>

        <div class="ex-row ex-row-wrap">
          <label class="ex-opt"><input v-model="includeChapterTitle" type="checkbox" :disabled="running" /> 含章节标题</label>
          <label class="ex-opt">
            <input v-model="useReplace" type="checkbox" :disabled="running" /> 应用替换规则
          </label>
          <label class="ex-opt" title="不给未缓存的章节发请求；缺的章会被跳过（导出已下载的书最快）">
            <input v-model="cachedOnly" type="checkbox" :disabled="running" /> 只导出已缓存
          </label>
          <label
            v-if="format === 'epub'"
            class="ex-opt"
            data-export-embed-images
            title="把正文图片与封面抓进文件（换设备/断网也能看）。取不到的图保持远程地址，不中断导出"
          >
            <input v-model="embedImages" type="checkbox" :disabled="running" /> 转存图片
          </label>
        </div>

        <p class="ex-tip">
          导出的是<b>当前净化后的正文</b>（与屏幕上看到的一致）。未缓存的章节会现抓，
          失败的章会被跳过并在下面报数 —— 想 100% 完整，先在书架「⬇ 下载整本」。
        </p>

        <div v-if="running || progress.total" class="ex-progress">
          <div class="ex-bar">
            <div
              class="ex-bar-in"
              :style="{
                width: `${
                  progress.phase === 'images' && progress.images?.total
                    ? (progress.images.done / progress.images.total) * 100
                    : progress.total
                      ? (progress.done / progress.total) * 100
                      : 0
                }%`,
              }"
            ></div>
          </div>
          <span v-if="progress.phase === 'images'" class="ex-muted">
            🖼 图片 {{ progress.images?.done ?? 0 }} / {{ progress.images?.total ?? 0 }}<template v-if="progress.images?.failed">（失败 {{ progress.images.failed }}）</template>
          </span>
          <span v-else class="ex-muted">
            {{ progress.done }} / {{ progress.total }}<template v-if="progress.failed">（失败 {{ progress.failed }}）</template>
          </span>
        </div>

        <div v-if="err" class="ex-err">{{ err }}</div>

        <div v-if="done" class="ex-done">
          ✅ {{ done.filename }} · {{ fmtBytes(done.bytes) }} · 写入 {{ done.stats.written }} 章<template v-if="done.stats.skipped">，跳过 {{ done.stats.skipped }} 章（无正文/失败）</template><template v-if="done.stats.failed">，其中失败 {{ done.stats.failed }} 章</template><template v-if="done.stats.replaceUsed"> · 起效替换规则 {{ done.stats.replaceUsed }} 条</template><template v-if="done.stats.images.embedded"> · 转存图片 {{ done.stats.images.embedded }} 张</template><template v-if="done.stats.images.failed">（{{ done.stats.images.failed }} 张取不到，保留远程地址）</template>
        </div>
      </div>

      <div class="ex-foot">
        <button v-if="running" class="btn mini" @click="cancel">取消</button>
        <button v-else class="btn mini" @click="emit('close')">关闭</button>
        <button class="btn mini primary" :disabled="!canRun" @click="run">
          {{ running ? '导出中…' : done ? '重新导出' : '开始导出' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ex-mask { position: fixed; inset: 0; z-index: 1040; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; padding: 20px; }
.ex-panel { width: min(520px, 100%); background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); box-shadow: var(--shadow); animation: fadein 0.16s ease; }
.ex-head { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-bottom: 1px solid var(--border); color: var(--text-0); font-size: 14px; min-width: 0; }
.ex-head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.ex-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ex-row-wrap { gap: 14px; }
.ex-label { width: 46px; flex: none; font-size: 12.5px; color: var(--muted); }
.ex-opt { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--text-0); cursor: pointer; }
.ex-opt input { accent-color: var(--acc); }
.ex-muted { font-size: 12px; color: var(--muted); }
.ex-num { width: 74px; padding: 5px 7px; border-radius: 7px; background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0); font-family: var(--font); font-size: 12.5px; outline: none; }
.ex-tip { margin: 0; font-size: 11.5px; line-height: 1.65; color: var(--muted); }
.ex-progress { display: flex; align-items: center; gap: 10px; }
.ex-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-3); overflow: hidden; }
.ex-bar-in { height: 100%; background: var(--acc); transition: width 0.2s ease; }
.ex-err { color: var(--red); font-size: 12px; }
.ex-done { font-size: 12px; line-height: 1.6; color: var(--text-1); background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.ex-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 11px 14px; border-top: 1px solid var(--border); }
</style>
