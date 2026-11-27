<template>
  <div class="cache-governance">
    <h3>缓存治理</h3>
    <div class="sh-sub">六类缓存按类记账、按类清理；条数 / 字节上限都可在下面改（0 = 关闭该类）</div>

    <p v-if="error" class="cache-banner err">
      缓存治理接口不可用：{{ error }}。若服务端仍是旧版本，请更新服务端后重试（本页不会自动重启服务）。
    </p>

    <p class="cache-hint">
      服务端四类（封面 / 漫画 / 图片 / 本地书）达到上限后会按「最久未使用」自动淘汰；
      浏览器两类（目录 / 正文）只统计与手动清理，<b>不会自动删除</b> —— 正文缓存里可能包含你手动点的
      「⬇ 离线缓存」，自动淘汰等于删掉你的离线内容。
    </p>

    <!-- 写盘失败可见化：此前配额不足只会表现为「预缓存突然不灵」，用户无从知道原因 -->
    <p v-if="writeFail.count > 0" class="cache-banner err" data-cache-write-fail>
      正文缓存写入失败 <b>{{ writeFail.count }}</b> 次（最后一次：{{ writeFail.last }}<template v-if="writeFail.lastAt"> · {{ fmtTime(writeFail.lastAt) }}</template>）。
      浏览器存储配额可能不足：可在下方「正文」行点「清理该类」释放空间，或清理不需要的离线缓存后再读。
      阅读不受影响 —— 只是这些章不会进离线缓存，下次仍要联网取。
    </p>

    <div class="setting-row cache-total">
      <div class="setting-info">
        <b>服务端缓存总量</b>
        <span>封面 / 漫画 / 图片 / 本地书四类合计；超出总上限时跨类按最久未用淘汰。0 = 不限制总量</span>
        <span class="cache-usage">占用：{{ fmtBytes(serverBytes) }} · {{ totalItems }} 项</span>
      </div>
      <div class="cache-actions">
        <label>总上限 <input v-model.number="totalMb" type="number" min="0" step="10" /> MB</label>
        <button class="btn sm" :disabled="busy" @click="saveLimits">{{ saving ? '保存中…' : '保存上限' }}</button>
      </div>
    </div>

    <div v-for="row in rows" :key="row.key" class="setting-row cache-row">
      <div class="setting-info">
        <b>
          {{ row.label }}
          <span class="tag" :class="row.storage === 'server' ? 'green' : ''">{{ row.storage === 'server' ? '服务端' : '浏览器' }}</span>
          <span v-if="isOff(row)" class="tag red">已关闭</span>
        </b>
        <span>{{ row.describe }}</span>
        <span class="cache-usage">
          占用：{{ usageText(row) }}
          <template v-if="row.ttlMs > 0"> · 有效期 {{ fmtTtl(row.ttlMs) }}</template>
          <template v-else> · 不按时间过期</template>
        </span>
      </div>
      <div class="cache-actions">
        <label>条数 <input v-model.number="row.editItems" type="number" min="0" step="10" /></label>
        <label>上限 <input v-model.number="row.editMb" type="number" min="0" step="10" /> MB</label>
        <button class="btn sm danger" :disabled="busy || clearing === row.key" @click="clearOne(row)">
          {{ clearing === row.key ? '清理中…' : '清理该类' }}
        </button>
      </div>
    </div>

    <div class="setting-row cache-total">
      <div class="setting-info">
        <b>
          音频缓存
          <span class="tag green">服务端</span>
        </b>
        <span>
          音频书<b>播放时后台整章落盘</b>（首播不阻塞，下次秒开、可离线）。独立目录，不进正文缓存；
          超出配额时只淘汰「后台缓存」，<b>手动下载的永不自动删除</b>。
          m3u8 流式源 P1 不支持离线（不落假缓存）。
        </span>
        <span class="cache-usage">
          占用：{{ fmtBytes(audioStats.bytes) }} · {{ audioStats.items }} 章 / {{ audioStats.books }} 本
          <template v-if="audioStats.manualItems > 0">
            · 手动 {{ audioStats.manualItems }} 章 {{ fmtBytes(audioStats.manualBytes) }}
          </template>
          <template v-if="audioStats.streamItems > 0">
            · 后台 {{ audioStats.streamItems }} 章 {{ fmtBytes(audioStats.streamBytes) }}
          </template>
          <template v-if="audioStats.unsupported > 0"> · 流式源 {{ audioStats.unsupported }} 章不可离线</template>
        </span>
        <span v-if="audioStats.overQuota" class="cache-warn">
          已超出配额：自动淘汰只清「后台缓存」，<b>手动内容不计入自动淘汰</b>（要释放空间请用下方的按书清理或清空）。
        </span>
      </div>
      <div class="cache-actions">
        <label>配额 <input v-model.number="audioMb" type="number" min="0" step="100" /> MB</label>
        <button class="btn sm" :disabled="busy || audioBusy" @click="saveAudioQuota">
          {{ audioBusy ? '保存中…' : '保存配额' }}
        </button>
        <button class="btn sm" :disabled="busy || audioBusy" title="只清进程中断留下的临时文件与空目录，不删已缓存的音频" @click="pruneAudio">
          清理残留
        </button>
        <button class="btn sm" :disabled="busy || audioBusy" title="先把「书已不在书架」的缓存列出来给你确认，再删除（含手动下载）" @click="purgeOrphans">
          清理无主缓存
        </button>
        <button class="btn sm danger" :disabled="busy || audioBusy" @click="clearAudioAll">清空音频缓存</button>
      </div>
    </div>

    <div v-if="audioStats.bookList.length" class="setting-row cache-row">
      <div class="setting-info">
        <b>按书清理</b>
        <span>只删这本书已落盘的音频文件；书架、进度、正文缓存都不受影响。</span>
        <div class="cache-audio-books">
          <div v-for="b in audioStats.bookList" :key="b.bookKey" class="cache-audio-book">
            <span class="cache-audio-name" :title="b.bookUrl || b.bookKey">{{ b.title || b.bookKey }}</span>
            <span class="cache-audio-meta">
              {{ fmtBytes(b.bytes) }} · {{ b.items }} 章
              · 手动 {{ b.manualItems }} 章 / 后台 {{ b.items - b.manualItems }} 章
            </span>
            <button class="btn sm danger" :disabled="busy || audioBusy" @click="clearAudioBook(b)">
              清理
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="setting-row cache-total">
      <div class="setting-info">
        <b>全部清理</b>
        <span>
          清空上面六类缓存（封面 / 目录 / 正文 / 漫画 / 图片 / 本地书）。
          <b>不会</b>清 Cookie、书架与收藏、阅读进度、书签，也不会删除已导入的本地书文件。
          正文清空后离线内容需要重新联网缓存。
        </span>
      </div>
      <div class="cache-actions">
        <button class="btn sm" :disabled="busy" @click="refresh">刷新占用</button>
        <button class="btn sm danger" :disabled="busy" @click="clearAll">
          {{ allClearing ? '清理中…' : '清理全部缓存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  browserCacheUsage,
  chapterCacheWriteFailures,
  clearBookMetaCache,
  clearChapterCache,
} from '../utils/chapter-cache';
import { toast } from '../toast';
import {
  clearAudioCache,
  fetchAudioCacheStats,
  fetchAudioOrphans,
  pruneAudioCache,
  purgeAudioOrphans,
  setAudioCacheQuota,
  type AudioCacheBookStat,
  type AudioCacheStats,
} from '../utils/audio-cache';

type CacheKey = 'cover' | 'toc' | 'content' | 'manga' | 'image' | 'localbook';
type Storage = 'server' | 'browser';

interface CacheRow {
  key: CacheKey;
  label: string;
  storage: Storage;
  describe: string;
  ttlMs: number;
  maxItems: number;
  maxBytes: number;
  items: number | null;
  bytes: number | null;
  /** 设置页的编辑态（条数 / MB），保存前不落盘 */
  editItems: number;
  editMb: number;
}

const MB = 1024 * 1024;

const rows = ref<CacheRow[]>([]);
const totalMb = ref(200);
const busy = ref(false);
const saving = ref(false);
const allClearing = ref(false);
const clearing = ref<CacheKey | ''>('');
const error = ref('');
const loadingBrowser = ref(false);

const browserUsage = ref<Record<'toc' | 'content', { items: number; bytes: number }>>({
  toc: { items: 0, bytes: 0 },
  content: { items: 0, bytes: 0 },
});

/** 正文缓存写盘失败（浏览器配额不足等）；清理正文后归零（见 chapter-cache.ts） */
const writeFail = ref(chapterCacheWriteFailures());

// ---- 音频缓存（独立目录；见 apps/server/src/audio-cache.ts）----
const emptyAudioStats = (): AudioCacheStats => ({
  items: 0, bytes: 0, books: 0, maxBytes: 2 * 1024 * MB, unsupported: 0,
  manualItems: 0, manualBytes: 0, streamItems: 0, streamBytes: 0, overQuota: false, bookList: [],
});
const audioStats = ref<AudioCacheStats>(emptyAudioStats());
const audioMb = ref(2048);
const audioBusy = ref(false);

function applyAudioStats(st: AudioCacheStats | null): void {
  if (!st) return;
  audioStats.value = st;
  audioMb.value = Math.round((st.maxBytes / MB) * 10) / 10;
}

async function saveAudioQuota(): Promise<void> {
  audioBusy.value = true;
  try {
    const maxBytes = Math.max(0, Math.round((Number(audioMb.value) || 0) * MB));
    const st = await setAudioCacheQuota(maxBytes);
    if (!st) throw new Error('接口不可用');
    applyAudioStats(st);
    toast('音频缓存配额已保存（超出部分只淘汰后台缓存，手动下载的不动）', 'info');
  } catch (e) {
    toast('保存失败：' + String(e instanceof Error ? e.message : e), 'error');
  } finally {
    audioBusy.value = false;
  }
}

async function clearAudioAll(): Promise<void> {
  if (!confirm('清空全部音频缓存？\n\n只删已落盘的音频文件，不影响书架、阅读进度与正文缓存。')) return;
  audioBusy.value = true;
  try {
    const r = await clearAudioCache();
    if (!r) throw new Error('接口不可用');
    toast(`已清空音频缓存：${r.items} 章 · ${fmtBytes(r.bytes)}`, 'info');
    applyAudioStats(await fetchAudioCacheStats());
  } catch (e) {
    toast('清理失败：' + String(e instanceof Error ? e.message : e), 'error');
  } finally {
    audioBusy.value = false;
  }
}

async function clearAudioBook(b: AudioCacheBookStat): Promise<void> {
  // 一律按 bookKey 精确删：索引重建后的条目没有 bookUrl，按 URL 走会误清全盘
  if (!confirm(`清空《${b.title || b.bookKey}》的音频缓存？\n\n只删这本已落盘的音频文件。`)) return;
  audioBusy.value = true;
  try {
    const r = await clearAudioCache(undefined, b.bookKey);
    if (!r) throw new Error('接口不可用');
    toast(`已清空《${b.title || b.bookKey}》：${r.items} 章 · ${fmtBytes(r.bytes)}`, 'info');
    applyAudioStats(await fetchAudioCacheStats());
  } catch (e) {
    toast('清理失败：' + String(e instanceof Error ? e.message : e), 'error');
  } finally {
    audioBusy.value = false;
  }
}
async function pruneAudio(): Promise<void> {
  audioBusy.value = true;
  try {
    const r = await pruneAudioCache();
    if (!r) throw new Error('接口不可用');
    const parts: string[] = [];
    if (r.tmpFiles) parts.push(`临时文件 ${r.tmpFiles} 个`);
    if (r.emptyDirs) parts.push(`空目录 ${r.emptyDirs} 个`);
    if (r.emptyBooks) parts.push(`空索引 ${r.emptyBooks} 项`);
    toast(
      parts.length ? `已清理残留：${parts.join('，')}（释放 ${fmtBytes(r.bytes)}）` : '没有需要清理的残留',
      'info',
    );
    applyAudioStats(await fetchAudioCacheStats());
  } catch (e) {
    toast('清理失败：' + String(e instanceof Error ? e.message : e), 'error');
  } finally {
    audioBusy.value = false;
  }
}

async function purgeOrphans(): Promise<void> {
  audioBusy.value = true;
  try {
    // 第一步：只读预览——先让用户看到「要删哪些书、多少章、多少字节、其中手动多少」
    const preview = await fetchAudioOrphans();
    if (!preview) throw new Error('接口不可用');
    const u = preview.unattributed;
    const unNote = u.books
      ? `\n\n另有 ${u.books} 本无法归属（索引丢失、bookUrl 为空）：${u.items} 章 ${fmtBytes(u.bytes)}。` +
        '\n这类无法证明「不在书架」，不会列入本次清理；要清它们请用下方的按书清理或「清空音频缓存」。'
      : '';
    if (!preview.orphans.length) {
      toast(
        u.books
          ? `没有可判定的无主缓存；另有 ${u.books} 本无法归属（索引丢失），需按书清理或清空`
          : '没有无主缓存：已缓存的音频都能对应到书架上的书',
      );
      return;
    }
    const t = preview.totals;
    const lines = preview.orphans
      .slice(0, 10)
      .map((o) => `· ${o.title || o.bookUrl || o.bookKey}：${o.items} 章 ${fmtBytes(o.bytes)}（手动 ${o.manualItems} 章）`);
    const more = preview.orphans.length > 10 ? `\n…另有 ${preview.orphans.length - 10} 本` : '';
    const ok = confirm(
      `待删除的无主缓存（这些书已不在书架）：\n${lines.join('\n')}${more}\n\n` +
        `合计 ${t.books} 本 / ${t.items} 章 / ${fmtBytes(t.bytes)}，其中手动下载 ${t.manualItems} 章 ${fmtBytes(t.manualBytes)}。\n\n` +
        '手动下载的内容也会一起删除，且删除后无法恢复。确定继续？' +
        unNote,
    );
    if (!ok) return;
    // 第二步：带 bookKey 删除；服务端会重新校验「是否仍在书架」，期间被加回书架的书自动跳过
    const res = await purgeAudioOrphans(preview.orphans.map((o) => o.bookKey));
    if (!res) throw new Error('接口不可用');
    const c = res.cleared;
    toast(
      `已清理无主缓存 ${c.books} 本：${c.items} 章 · ${fmtBytes(c.bytes)}` +
        (c.manualItems ? `（含手动 ${c.manualItems} 章）` : '') +
        (res.skipped ? `；${res.skipped} 本已回到书架，已跳过` : ''),
      'info',
    );
    applyAudioStats(await fetchAudioCacheStats());
  } catch (e) {
    toast('清理失败：' + String(e instanceof Error ? e.message : e), 'error');
  } finally {
    audioBusy.value = false;
  }
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return '';
  }
}

const serverRows = computed(() => rows.value.filter((r) => r.storage === 'server'));
const serverBytes = computed(() => serverRows.value.reduce((n, r) => n + used(r).bytes, 0));
const totalItems = computed(() => serverRows.value.reduce((n, r) => n + used(r).items, 0));

function used(row: CacheRow): { items: number; bytes: number } {
  if (row.storage === 'browser') {
    return browserUsage.value[row.key === 'toc' ? 'toc' : 'content'];
  }
  return { items: row.items ?? 0, bytes: row.bytes ?? 0 };
}

function usageText(row: CacheRow): string {
  if (row.storage === 'browser' && loadingBrowser.value) return '统计中…';
  const u = used(row);
  return `${fmtBytes(u.bytes)} · ${u.items} 项`;
}

function isOff(row: CacheRow): boolean {
  return Number(row.editItems) <= 0 || Number(row.editMb) <= 0;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
}

function fmtTtl(ms: number): string {
  if (ms <= 0) return '不过期';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} 分钟`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} 小时`;
  return `${Math.round(ms / (24 * 60 * 60_000))} 天`;
}

/** 拉服务端四类 + 浏览器两类（浏览器统计要遍历 IndexedDB，单独标记「统计中」） */
async function refresh(): Promise<void> {
  error.value = '';
  try {
    const r = await fetch('/api/cache/stats');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as {
      categories: Array<Omit<CacheRow, 'editItems' | 'editMb'> & { maxItems: number; maxBytes: number }>;
      total: { bytes: number; maxBytes: number };
    };
    rows.value = data.categories.map((c) => ({
      ...c,
      editItems: c.maxItems,
      editMb: Math.round((c.maxBytes / MB) * 10) / 10,
    }));
    totalMb.value = Math.round((data.total.maxBytes / MB) * 10) / 10;
    // 音频缓存是独立目录 / 独立接口，失败不影响六类统计（旧服务端只会返回 null）
    applyAudioStats(await fetchAudioCacheStats());
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
    return;
  }
  loadingBrowser.value = true;
  try {
    browserUsage.value = await browserCacheUsage();
  } catch (e) {
    console.warn('[cache-governance] 浏览器缓存统计失败', e);
  } finally {
    loadingBrowser.value = false;
    writeFail.value = chapterCacheWriteFailures();
  }
}

/** 保存六类 + 总上限（补丁式 PUT；服务端会按新上限立刻淘汰一次） */
async function saveLimits(): Promise<void> {
  saving.value = true;
  busy.value = true;
  try {
    const categories: Record<string, { maxItems: number; maxBytes: number }> = {};
    for (const row of rows.value) {
      const items = Math.max(0, Math.round(Number(row.editItems) || 0));
      const mb = Math.max(0, Number(row.editMb) || 0);
      categories[row.key] = { maxItems: items, maxBytes: Math.round(mb * MB) };
      row.maxItems = items;
      row.maxBytes = Math.max(0, Math.round(mb * MB));
    }
    const totalMaxBytes = Math.max(0, Math.round((Number(totalMb.value) || 0) * MB));
    const r = await fetch('/api/cache/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totalMaxBytes, categories }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast('缓存上限已保存（超出新上限的部分已按最久未用淘汰）', 'info');
    await refresh();
  } catch (e) {
    toast('保存失败：' + String(e instanceof Error ? e.message : e), 'error');
  } finally {
    saving.value = false;
    busy.value = false;
  }
}

async function clearOne(row: CacheRow): Promise<void> {
  const msg =
    `清空「${row.label}」？\n\n${row.describe}\n\n` +
    '不会清 Cookie、书架/收藏、阅读进度与书签。';
  if (!confirm(msg)) return;
  clearing.value = row.key;
  busy.value = true;
  try {
    let detail = '';
    if (row.storage === 'browser') {
      const n = row.key === 'toc' ? await clearBookMetaCache() : await clearChapterCache();
      detail = `${n} 项`;
    } else {
      const r = await fetch('/api/cache/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: row.key }),
      });
      const data = (await r.json()) as { cleared?: { items: number; bytes: number }; detail?: string };
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      detail = `${data.cleared?.items ?? 0} 项 · ${fmtBytes(data.cleared?.bytes ?? 0)}`;
    }
    toast(`已清空${row.label}：${detail}`, 'info');
    await refresh();
  } catch (e) {
    toast('清理失败：' + String(e instanceof Error ? e.message : e), 'error');
  } finally {
    clearing.value = '';
    busy.value = false;
  }
}

async function clearAll(): Promise<void> {
  const msg =
    '清空全部六类缓存？\n\n' +
    '· 封面 / 漫画 / 图片：下次重新取图\n' +
    '· 目录：下次打开书重新拉目录\n' +
    '· 正文：离线缓存与预缓存清空，需要重新联网缓存\n' +
    '· 本地书：只清解析结果，已导入的书文件保留\n\n' +
    '不会清 Cookie、书架/收藏、阅读进度与书签。';
  if (!confirm(msg)) return;
  allClearing.value = true;
  busy.value = true;
  try {
    const r = await fetch('/api/cache/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'all' }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const toc = await clearBookMetaCache();
    const content = await clearChapterCache();
    toast(`已清理全部缓存：服务端四类 + 目录 ${toc} 项 · 正文 ${content} 项`, 'info');
    await refresh();
  } catch (e) {
    toast('清理失败：' + String(e instanceof Error ? e.message : e), 'error');
  } finally {
    allClearing.value = false;
    busy.value = false;
  }
}

onMounted(() => {
  void refresh();
});
</script>

<style scoped>
.cache-governance {
  padding-bottom: 24px;
}
/* 本组件没有继承 SettingsView 的 scoped 样式（作用域不外溢）⇒ 标题 / 说明 /
   行布局都在这里自带一份，口径与设置页其它分区保持一致。 */
.cache-governance h3 { font-size: 15px; margin: 0 0 6px; }
.cache-governance .sh-sub {
  font-size: 11.5px; color: var(--faint);
  margin-bottom: 14px; padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
/* 项与项之间用行自身的下边框分隔（边框随行滚动，不会与内容错位）；
   上下 padding 统一 14px，保证任意两项之间的视觉间距一致。 */
.cache-governance .setting-row {
  display: flex; justify-content: space-between; align-items: center;
  gap: 20px; padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.cache-governance .setting-row:last-child { border-bottom: none; }
.cache-governance .setting-info b { font-size: 13px; display: block; }
/* 只作用于「描述行」这类直接子级 span；`<b>` 里的 .tag 是由全局 theme.css 管的。 */
.cache-governance .setting-info > span { font-size: 11px; color: var(--muted); margin-top: 3px; display: block; }
.cache-banner {
  margin: 10px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--bad, #c44) 12%, transparent);
  color: var(--bad, #c44);
  font-size: 13px;
  line-height: 1.6;
}
.cache-hint {
  margin: 10px 0 14px;
  color: var(--fg-dim, #999);
  font-size: 13px;
  line-height: 1.7;
}
/* 比 `.cache-governance .setting-row` 多一个类，才能覆盖它的 align-items: center */
.cache-governance .setting-row.cache-row {
  align-items: flex-start;
}
.cache-governance .setting-info > .cache-usage {
  color: var(--fg-dim, #999);
  font-size: 12px;
}
.cache-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
}
.cache-actions label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-dim, #999);
  white-space: nowrap;
}
.cache-actions input {
  width: 76px;
  padding: 3px 6px;
  border-radius: 5px;
  border: 1px solid var(--line, #333);
  background: var(--bg-input, transparent);
  color: var(--fg, #eee);
}
/* 超配额提示（手动内容不计入自动淘汰） */
.cache-governance .setting-info > .cache-warn {
  display: block;
  margin-top: 4px;
  color: var(--orange, #e6a23c);
  font-size: 12px;
  line-height: 1.5;
}
/* 音频缓存「按书清理」列表 */
.cache-audio-books {
  margin-top: 8px;
  border-top: 1px solid var(--border);
}
.cache-audio-book {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
}
.cache-audio-book:last-child { border-bottom: none; }
.cache-audio-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fg, #ddd);
}
.cache-audio-meta {
  flex: none;
  font-size: 11.5px;
  color: var(--fg-dim, #999);
}
</style>
