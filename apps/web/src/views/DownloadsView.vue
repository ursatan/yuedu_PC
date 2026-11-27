<script setup lang="ts">
/**
 * **下载管理**（`#207`）—— 整本下载的任务中心。
 *
 * 为什么要有这一页：此前只有两种缓存手段（阅读时的 20 章预缓存窗口、阅读器里「⬇ 缓存」
 * 选范围），**都没有跨书的可见性与控制力** —— 下了多少、哪几章失败、能不能停/续，全看不见。
 * 上游 Legado 对应 `CacheBook` + 书架的下载入口（前台 Service + 通知），这里换成
 * 「任务列表页 + 落盘任务」（浏览器没有前台服务，刷新就丢是不行的）。
 *
 * 语义（逐条对齐上游 `CacheBook.kt`，对照表见 `utils/download-manager.ts` 文件头）：
 *  · 顶部摘要 = 上游 `downloadSummary`「正在下载 / 等待中 / 失败 / 成功」；
 *  · 单本可 暂停 / 继续 / 重试失败 / 取消 / 移除记录；全局可 全部暂停 / 继续；
 *  · **移除记录不删缓存**（要删走书架「🧹 清理缓存」）—— 下载下来的正文是用户的，不是任务的。
 */
import { computed, onMounted } from 'vue';
import { useDownloadsStore } from '../stores/downloads';
import { useReaderStore, itemKey } from '../stores/reader';
import { imgSrc } from '../utils/img';
import { toast } from '../toast';

const dl = useDownloadsStore();
const reader = useReaderStore();

onMounted(() => {
  // 任务落 IndexedDB ⇒ 刷新后要恢复（进行中的会被落成「已暂停」，不自动续跑）
  void dl.hydrate();
});

/** 排序：进行中的在前，其余按最近更新 */
const rows = computed(() => {
  const rank: Record<string, number> = { running: 0, queued: 1, paused: 2, error: 3, canceled: 4, done: 5 };
  return [...dl.tasks].sort((a, b) => {
    const d = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
    return d !== 0 ? d : b.updatedAt - a.updatedAt;
  });
});

const MAX_BOOK_OPTIONS = [1, 2, 3, 4];

function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function onPause(key: string): Promise<void> {
  dl.pause(key);
  toast('已暂停（已下载的章节保留，可继续）', 'info');
}
function onResume(key: string): void {
  dl.resume(key);
}
function onCancel(key: string): void {
  dl.cancel(key);
}
function onRetry(key: string): void {
  dl.retryFailed(key);
}
function onRemove(key: string): void {
  dl.remove(key);
}
async function onClearFinished(): Promise<void> {
  const n = dl.finishedCount;
  dl.clearFinished();
  toast(n ? `已清理 ${n} 条记录（缓存保留）` : '没有已结束的任务', n ? 'ok' : 'info');
}
/** 从任务直接打开这本书继续读（复用书架的打开路径） */
function openBook(key: string): void {
  const b = reader.shelf.find((x) => (x.key ?? itemKey(x.sourceId, x.payload)) === key);
  if (!b) { toast('这本书已不在书架里', 'warn'); return; }
  void reader.openShelfBook(b);
}
</script>

<template>
  <div class="page">
    <div class="card">
      <div class="row-head">
        <h3 style="margin: 0">下载管理</h3>
        <span class="sub">
          正在下载 {{ dl.summary.running }} · 等待中 {{ dl.summary.waiting }} ·
          失败 {{ dl.summary.failed }} · 成功 {{ dl.summary.success }}
        </span>
        <span style="flex: 1"></span>
        <button v-if="dl.hasActive" class="btn sm" @click="dl.pauseAll()">⏸ 全部暂停</button>
        <button v-else class="btn sm" :disabled="!dl.tasks.length" @click="dl.resumeAll()">▶ 全部继续</button>
        <button class="btn sm" :disabled="!dl.finishedCount" @click="onClearFinished()">🧹 清理已完成</button>
      </div>
      <p class="tip">
        把整本书的正文缓存到本机（IndexedDB），之后离线 / 源站不稳也能读。
        任务<b>后台执行</b>、可随时暂停续跑；已缓存的章节会跳过（不重复下载），
        失败的章节自动重试 <b>3</b> 次。<br />
        ★ 入口：书架管理模式勾选后点「⬇ 下载整本」，或阅读器里的「⬇ 缓存」（选范围）。
        <b>本地书不需要下载</b>（正文本就在本机）。
      </p>
      <div class="dl-set">
        <span>同时下载</span>
        <select
          :value="dl.maxBooks" title="同时下载几本书（每本内部并发 3 章）"
          @change="dl.setMaxBooks(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="n in MAX_BOOK_OPTIONS" :key="n" :value="n">{{ n }} 本</option>
        </select>
        <span class="sub">（默认 2 本 · 每本内并发 3 章）</span>
        <span style="flex: 1"></span>
        <span v-if="dl.pausedAll" class="chip warn">已全局暂停</span>
      </div>
    </div>

    <div class="card">
      <div class="dl-list">
        <div v-for="t in rows" :key="t.key" class="dl-row" :class="['st-' + t.state]">
          <img v-if="t.cover" class="dl-cover" :src="imgSrc(t.cover)" alt="" @click="openBook(t.key)" />
          <div v-else class="dl-cover dl-cover-none" @click="openBook(t.key)">📕</div>
          <div class="dl-main">
            <div class="dl-title" :title="t.title" @click="openBook(t.key)">{{ t.title }}</div>
            <div class="dl-meta">
              <span class="chip" :class="['st-' + t.state]">{{ dl.stateLabel(t.state) }}</span>
              <span>
                {{ t.done + t.failed + t.skipped }} / {{ t.total }} 章
                <template v-if="t.from > 0 || t.to >= 0">（第 {{ t.from + 1 }} ~ {{ t.to + 1 }} 章）</template>
              </span>
              <span v-if="t.skipped" class="sub">已有缓存跳过 {{ t.skipped }}</span>
              <span v-if="t.failed" class="err-text">失败 {{ t.failed }}</span>
              <span class="sub">{{ fmtTime(t.updatedAt) }}</span>
            </div>
            <div class="dl-bar">
              <div class="dl-bar-in" :style="{ width: dl.percentOf(t) + '%' }"></div>
            </div>
            <div v-if="t.err && t.state !== 'done'" class="err-text dl-err" :title="t.err">{{ t.err }}</div>
          </div>
          <div class="dl-ops">
            <button
              v-if="t.state === 'running' || t.state === 'queued'" class="btn mini"
              title="暂停：已下载的保留，未下载的留在队列里" @click="onPause(t.key)"
            >⏸ 暂停</button>
            <button v-else-if="t.state === 'paused'" class="btn mini primary" @click="onResume(t.key)">▶ 继续</button>
            <button
              v-if="t.failed" class="btn mini" title="把失败的章节重新放回队列（失败计数清零）"
              @click="onRetry(t.key)"
            >↻ 重试失败</button>
            <button
              v-if="t.state === 'running' || t.state === 'queued' || t.state === 'paused'"
              class="btn mini" @click="onCancel(t.key)"
            >✕ 取消</button>
            <button class="btn mini" title="从列表移除（不删已下载的缓存）" @click="onRemove(t.key)">🗑 移除</button>
          </div>
        </div>
        <div v-if="!rows.length" class="empty">
          还没有下载任务 —— 去书架勾选几本书点「⬇ 下载整本」，或在阅读器里点「⬇ 缓存」。
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dl-set {
  display: flex; align-items: center; gap: 8px; margin-top: 8px;
  font-size: 12px; color: var(--muted);
}
.dl-list { display: flex; flex-direction: column; gap: 8px; }
.dl-row {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
}
.dl-cover {
  width: 44px; height: 62px; object-fit: cover; border-radius: 4px;
  flex: none; cursor: pointer; background: var(--bg-soft);
}
.dl-cover-none {
  display: flex; align-items: center; justify-content: center; font-size: 20px;
}
.dl-main { flex: 1; min-width: 0; }
.dl-title {
  font-size: 13px; font-weight: 600; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dl-meta {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  font-size: 12px; color: var(--muted); margin-top: 2px;
}
.dl-bar {
  margin-top: 6px; height: 4px; border-radius: 2px; background: var(--bg-soft); overflow: hidden;
}
.dl-bar-in { height: 100%; background: var(--accent, #4fc3f7); transition: width .2s linear; }
.dl-row.st-done .dl-bar-in { background: #66bb6a; }
.dl-row.st-error .dl-bar-in { background: #ef5350; }
.dl-err {
  margin-top: 4px; font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dl-ops { display: flex; flex-direction: column; gap: 4px; flex: none; }
.chip {
  padding: 0 6px; border-radius: 8px; font-size: 11px;
  background: var(--bg-soft); color: var(--muted);
}
.chip.st-running { background: rgba(79, 195, 247, .16); color: #4fc3f7; }
.chip.st-paused { background: rgba(255, 193, 7, .16); color: #ffc107; }
.chip.st-done { background: rgba(102, 187, 106, .16); color: #66bb6a; }
.chip.st-error { background: rgba(239, 83, 80, .16); color: #ef5350; }
.chip.warn { background: rgba(255, 193, 7, .16); color: #ffc107; }
</style>
