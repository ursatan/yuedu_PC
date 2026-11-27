<script setup lang="ts">
/**
 * 阅读统计看板（P1 `#863` + P2 增强）。
 *
 * ## P2 增强（A1–A7，纯前端；数据全部来自同一份快照）
 * - A1 有效 vs 前台在线并列（在线含听书/自动段，只作对照，不参与「有效」）；
 * - A2 今日 vs 昨日、近 N 天 vs 前 N 天环比；
 * - A3 星期 × 四时段轻热力图；A4 听书趋势；A5 最长连续；
 * - A6 按书 × 时段（四桶条 + 最常读时段标签）；A7 常读作者 TOP5。
 *
 * ## 两个数据源，口径不同、并列展示、不做加总
 * - **新统计**（本页主数据）：服务端 `GET /api/user/read-stats` —— `read_session` 会话流水 +
 *   `book_read_stat` / `user_read_stat` 增量聚合。只统计**文本阅读**（D-8），从启用日起积累；
 * - **历史总额**：旧 `read_records` 的按书墙钟累计（含统计启用前的记录、含朗读/挂机），
 *   冻结只读（D-2）。
 *
 * ## 关键口径
 * - 「有效」= `mode='visual'` 的有效时长（后台/挂机不计；朗读与自动滚动单列）；
 * - 「有效日」= 当日有效 > 60 秒（D-3），连续天数按有效日从今天（今天无效则从昨天）往回数；
 * - 四时段：dawn 0–6 / morning 6–12 / afternoon 12–18 / night 18–24，跨时段按切片分账；
 * - 服务端不可用 ⇒ 回落到 B1 本地日桶（D-9 离线兜底），并明确标注「离线数据」。
 */
import { computed, onMounted, ref } from 'vue';

import type { ReadSession, ReadStatsSnapshot, UserReadStat } from '@yuedu/core/contract';

import { getReadStats, listReadRecords, listReadSessions } from '../user-data';
import {
  VALID_DAY_MIN_SEC,
  recentDayRows,
  todaySec,
  validDayStreak,
} from '../utils/read-stats';
import {
  PERIOD_KEYS,
  PERIOD_LABELS,
  addDayKey,
  authorRows,
  bookDailySeries,
  bookPeriodMs,
  dominantPeriod,
  gapBuckets,
  lengthBuckets,
  localDayKey,
  longestValidStreak,
  recentSessions,
  weekdayPeriodRows,
  windowStats,
} from '../utils/read-stats-p2';

const range = ref<7 | 30>(7);
const snapshot = ref<ReadStatsSnapshot | null>(null);
const loading = ref(true);
const offline = ref(false);
/** 旧「历史总额」（毫秒）；`null` = 读不到 */
const legacyFallbackMs = ref<number | null>(null);
/** B1：最近会话流水（只读；服务端不可用时为空） */
const sessions = ref<ReadSession[]>([]);
/** B2：单书下钻（null = 未展开） */
const drill = ref<{ bookUrl: string; bookName: string } | null>(null);
const drillSessions = ref<ReadSession[]>([]);
const drillLoading = ref(false);

const today = new Date();
const todayKey = localDayKey(today);
const yesterdayKey = addDayKey(todayKey, -1);

onMounted(async () => {
  try {
    snapshot.value = await getReadStats();
  } catch {
    offline.value = true;
  } finally {
    loading.value = false;
  }
  if (offline.value) {
    try {
      const list = await listReadRecords(true);
      legacyFallbackMs.value = list.reduce((s, r) => s + (Number.isFinite(r.readTime) ? r.readTime : 0), 0);
    } catch {
      legacyFallbackMs.value = null;
    }
    return;
  }
  try {
    sessions.value = await listReadSessions(200);
  } catch {
    sessions.value = [];
  }
});

function addDays(base: Date, delta: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + delta);
  return d;
}

const dayMap = computed(() => {
  const m = new Map<string, UserReadStat>();
  for (const d of snapshot.value?.days ?? []) m.set(d.day, d);
  return m;
});

/** 离线兜底：B1 本地日桶 */
const fallbackRows = computed(() => recentDayRows(range.value, new Date()));

interface DayRow {
  key: string;
  ms: number;
  valid: boolean;
}

const rows = computed<DayRow[]>(() => {
  if (offline.value) {
    return fallbackRows.value.map((r) => ({ key: r.key, ms: r.sec * 1000, valid: r.valid }));
  }
  const out: DayRow[] = [];
  for (let i = range.value - 1; i >= 0; i -= 1) {
    const key = localDayKey(addDays(today, -i));
    const d = dayMap.value.get(key);
    out.push({ key, ms: d?.effectiveMs ?? 0, valid: (d?.effectiveMs ?? 0) > VALID_DAY_MIN_SEC * 1000 });
  }
  return out;
});

const todayMs = computed(() => {
  if (offline.value) return todaySec(new Date()) * 1000;
  return dayMap.value.get(todayKey)?.effectiveMs ?? 0;
});

const rangeMs = computed(() => rows.value.reduce((s, r) => s + r.ms, 0));
const validCount = computed(() => rows.value.filter((r) => r.valid).length);
const peakMs = computed(() => Math.max(1, ...rows.value.map((r) => r.ms)));
const allZero = computed(() => rangeMs.value <= 0);

const totalEffectiveMs = computed(() =>
  (snapshot.value?.days ?? []).reduce((s, d) => s + d.effectiveMs, 0),
);
const listenMs = computed(() => (snapshot.value?.days ?? []).reduce((s, d) => s + d.listenMs, 0));
const avgSessionMs = computed(() => snapshot.value?.avgVisualSessionMs ?? 0);
const legacyMs = computed(() => (offline.value ? legacyFallbackMs.value : snapshot.value?.legacyReadMs ?? 0));
const firstDay = computed(() => snapshot.value?.firstDay ?? '');

/** 连续有效日：今日有效从今天数；今日未达标则从昨天数（中途断档即停） */
const streak = computed(() => {
  if (offline.value) return validDayStreak(new Date());
  const map = dayMap.value;
  let cursor = new Date(today);
  if (!isValidDay(map.get(localDayKey(cursor)))) cursor = addDays(cursor, -1);
  let n = 0;
  for (let i = 0; i < 400; i += 1) {
    if (!isValidDay(map.get(localDayKey(cursor)))) break;
    n += 1;
    cursor = addDays(cursor, -1);
  }
  return n;
});

function isValidDay(d?: UserReadStat): boolean {
  return !!d && d.effectiveMs > VALID_DAY_MIN_SEC * 1000;
}

/* ---- 四时段分布（与日历图同一范围） ---- */
interface PeriodRow {
  key: 'dawn' | 'morning' | 'afternoon' | 'night';
  label: string;
  hint: string;
  ms: number;
  pct: number;
}
const periodRows = computed<PeriodRow[]>(() => {
  const keys = new Set(rows.value.map((r) => r.key));
  let dawn = 0;
  let morning = 0;
  let afternoon = 0;
  let night = 0;
  for (const d of snapshot.value?.days ?? []) {
    if (!keys.has(d.day)) continue;
    dawn += d.dawnMs;
    morning += d.morningMs;
    afternoon += d.afternoonMs;
    night += d.nightMs;
  }
  const total = dawn + morning + afternoon + night;
  const pct = (v: number): number => (total > 0 ? Math.round((v / total) * 100) : 0);
  return [
    { key: 'dawn', label: '凌晨', hint: '0–6', ms: dawn, pct: pct(dawn) },
    { key: 'morning', label: '上午', hint: '6–12', ms: morning, pct: pct(morning) },
    { key: 'afternoon', label: '下午', hint: '12–18', ms: afternoon, pct: pct(afternoon) },
    { key: 'night', label: '晚上', hint: '18–24', ms: night, pct: pct(night) },
  ];
});

/* ---- 按书 TOP / 断点 ---- */
const topBooks = computed(() => {
  const list = (snapshot.value?.books ?? []).filter((b) => b.effectiveMs > 0).slice(0, 6);
  const max = Math.max(1, ...list.map((b) => b.effectiveMs));
  return list.map((b) => {
    const ms = bookPeriodMs(b);
    const total = PERIOD_KEYS.reduce((s, k) => s + ms[k], 0);
    const dom = dominantPeriod(ms);
    return {
      ...b,
      pct: Math.round((b.effectiveMs / max) * 100),
      periods: PERIOD_KEYS.map((k) => ({ key: k, label: PERIOD_LABELS[k], ms: ms[k], share: total > 0 ? (ms[k] / total) * 100 : 0 })),
      dominant: dom ? PERIOD_LABELS[dom] : '',
    };
  });
});

const breakPoints = computed(() => (snapshot.value?.breakPoints ?? []).slice(0, 5));

/* ---- P2：在线 vs 有效 / 环比 ---- */
const allDays = computed(() => snapshot.value?.days ?? []);
const todayOnlineMs = computed(() => dayMap.value.get(todayKey)?.totalMs ?? 0);
const yesterdayEffectiveMs = computed(() => dayMap.value.get(yesterdayKey)?.effectiveMs ?? 0);
const rangeOnlineMs = computed(() => windowStats(allDays.value, todayKey, range.value).totalMs);
const totalOnlineMs = computed(() => allDays.value.reduce((s, d) => s + d.totalMs, 0));
const prevRangeEffectiveMs = computed(
  () => windowStats(allDays.value, addDayKey(todayKey, -range.value), range.value).effectiveMs,
);

/** 环比文案；上期为 0 时不编百分比，直接标注「新增」 */
function pctDelta(cur: number, prev: number): string {
  if (prev <= 0) return cur > 0 ? '新增' : '—';
  const p = Math.round(((cur - prev) / prev) * 100);
  return `${p > 0 ? '+' : ''}${p}%`;
}

function deltaTone(cur: number, prev: number): 'up' | 'down' | 'flat' {
  if (cur === prev) return 'flat';
  return cur > prev ? 'up' : 'down';
}

/* ---- A3：星期 × 四时段 ---- */
const rangeDayKeys = computed(() => new Set(rows.value.map((r) => r.key)));
const weekdayRows = computed(() => weekdayPeriodRows(
  allDays.value.filter((d) => rangeDayKeys.value.has(d.day)),
));

const heatMax = computed(() =>
  Math.max(1, ...weekdayRows.value.flatMap((r) => PERIOD_KEYS.map((k) => r.cells[k]))),
);

function heatColor(ms: number): string {
  if (ms <= 0) return 'transparent';
  const p = Math.max(10, Math.round((ms / heatMax.value) * 100));
  return `color-mix(in srgb, var(--brand) ${p}%, var(--bg-2))`;
}

/* ---- A4：听书趋势 ---- */
const listenRows = computed(() =>
  rows.value.map((r) => ({ key: r.key, ms: dayMap.value.get(r.key)?.listenMs ?? 0 })),
);
const listenPeak = computed(() => Math.max(1, ...listenRows.value.map((r) => r.ms)));
const listenRangeMs = computed(() => listenRows.value.reduce((s, r) => s + r.ms, 0));

/* ---- A5：最长连续 ---- */
const maxStreak = computed(() => longestValidStreak(allDays.value, VALID_DAY_MIN_SEC * 1000));

/* ---- A7：常读作者 ---- */
const authors = computed(() => {
  const list = authorRows(snapshot.value?.books ?? [], 5);
  const max = Math.max(1, ...list.map((a) => a.effectiveMs));
  return list.map((a) => ({ ...a, pct: Math.round((a.effectiveMs / max) * 100) }));
});

/* ---- B1：会话节奏 / 最近会话 ---- */
const gaps = computed(() => gapBuckets(sessions.value));
const lengths = computed(() => lengthBuckets(sessions.value));
const gapMax = computed(() => Math.max(1, ...gaps.value.map((r) => r.count)));
const lengthMax = computed(() => Math.max(1, ...lengths.value.map((r) => r.count)));
const latestSessions = computed(() => recentSessions(sessions.value, 10));

function modeLabel(mode: ReadSession['mode']): string {
  if (mode === 'listen') return '听书';
  if (mode === 'auto') return '自动';
  return '目视';
}

/* ---- B2：单书下钻 ---- */
const drillSeries = computed(() =>
  drill.value ? bookDailySeries(drillSessions.value, todayKey, 30) : [],
);
const drillPeak = computed(() => Math.max(1, ...drillSeries.value.map((p) => p.ms)));

/** 章节轨迹：按首次进入排序、同章合并，取最近 10 个 */
const drillTrack = computed(() => {
  const sorted = [...drillSessions.value].sort((a, b) => a.startAt - b.startAt);
  const map = new Map<number, { chapterIndex: number; chapterTitle: string; startAt: number; endAt: number }>();
  for (const s of sorted) {
    const cur = map.get(s.chapterIndex);
    if (cur) cur.endAt = Math.max(cur.endAt, s.endAt);
    else map.set(s.chapterIndex, {
      chapterIndex: s.chapterIndex,
      chapterTitle: s.chapterTitle,
      startAt: s.startAt,
      endAt: s.endAt,
    });
  }
  return [...map.values()].sort((a, b) => a.startAt - b.startAt).slice(-10);
});
const drillRecent = computed(() => recentSessions(drillSessions.value, 8));

async function openDrill(bookUrl: string, bookName: string): Promise<void> {
  if (drill.value?.bookUrl === bookUrl) {
    closeDrill();
    return;
  }
  drill.value = { bookUrl, bookName };
  drillSessions.value = [];
  drillLoading.value = true;
  try {
    drillSessions.value = await listReadSessions(200, bookUrl);
  } catch {
    drillSessions.value = [];
  } finally {
    drillLoading.value = false;
  }
}

function closeDrill(): void {
  drill.value = null;
  drillSessions.value = [];
}

/* ---- 格式化 ---- */
function fmt(ms: number | null): string {
  if (ms === null) return '不可用';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function barHeightOf(ms: number, peak: number): string {
  if (ms <= 0) return '2px';
  return `max(4px, ${Math.round((ms / peak) * 100)}%)`;
}

function barHeight(ms: number): string {
  return barHeightOf(ms, peakMs.value);
}

function dayTip(key: string, ms: number): string {
  const md = key.slice(5).replace('-', ' 月 ') + ' 日';
  return `${md} · 目视有效 ${fmt(ms)}`;
}

function shortKey(key: string): string {
  return key.slice(5);
}

function fmtTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

const hasPeriodData = computed(() => periodRows.value.some((p) => p.ms > 0));
</script>

<template>
  <section class="st">
    <header class="st-head">
      <div>
        <h1>阅读统计</h1>
        <p class="st-sub">
          文本阅读统计
          <template v-if="offline"> · 服务端不可用，当前显示本机离线日桶</template>
          <template v-else-if="firstDay"> · 新统计自 {{ firstDay }} 起</template>
          <template v-else> · 新统计已就绪，去读一会儿书吧</template>
        </p>
      </div>
    </header>

    <div class="st-cards">
      <div class="st-card">
        <span class="st-label">今日有效</span>
        <strong class="st-value">{{ fmt(todayMs) }}</strong>
        <span class="st-hint">目视阅读 · 前台在线 {{ fmt(todayOnlineMs) }}</span>
      </div>
      <div class="st-card">
        <span class="st-label">近 {{ range }} 天有效</span>
        <strong class="st-value">{{ fmt(rangeMs) }}</strong>
        <span class="st-hint">有效 {{ validCount }} 天 · 在线 {{ fmt(rangeOnlineMs) }}</span>
      </div>
      <div class="st-card">
        <span class="st-label">累计有效</span>
        <strong class="st-value">{{ offline ? '—' : fmt(totalEffectiveMs) }}</strong>
        <span class="st-hint">
          <template v-if="offline">离线视角不提供</template>
          <template v-else>新统计起累计 · 在线 {{ fmt(totalOnlineMs) }}</template>
        </span>
      </div>
      <div class="st-card">
        <span class="st-label">平均单次</span>
        <strong class="st-value">{{ fmt(avgSessionMs) }}</strong>
        <span class="st-hint">目视会话 {{ snapshot?.visualSessionCount ?? 0 }} 次</span>
      </div>
      <div class="st-card">
        <span class="st-label">连续有效日</span>
        <strong class="st-value">{{ streak }}<small> 天</small></strong>
        <span class="st-hint">单日 &gt; {{ VALID_DAY_MIN_SEC }} 秒 · 最长 {{ maxStreak }} 天</span>
      </div>
      <div class="st-card">
        <span class="st-label">听书</span>
        <strong class="st-value">{{ offline ? '—' : fmt(listenMs) }}</strong>
        <span class="st-hint">
          <template v-if="offline">离线视角不提供</template>
          <template v-else>朗读单列 · 近 {{ range }} 天 {{ fmt(listenRangeMs) }}</template>
        </span>
      </div>
      <div class="st-card legacy">
        <span class="st-label">历史总额（只读）</span>
        <strong class="st-value">
          {{ loading ? '读取中…' : fmt(legacyMs) }}
        </strong>
        <span class="st-hint">旧口径，含朗读/挂机，不折算</span>
      </div>
      <div class="st-card">
        <span class="st-label">新统计起点</span>
        <strong class="st-value">{{ firstDay || (loading ? '…' : '尚无记录') }}</strong>
        <span class="st-hint">与历史总额不做加总</span>
      </div>
    </div>

    <div v-if="!offline" class="st-compare">
      <div class="st-compare-row">
        <span class="st-compare-name">今日 vs 昨日</span>
        <span class="st-compare-main">
          {{ fmt(todayMs) }}
          <em class="st-delta" :class="deltaTone(todayMs, yesterdayEffectiveMs)">
            {{ pctDelta(todayMs, yesterdayEffectiveMs) }}
          </em>
        </span>
        <span class="st-compare-sub">昨日 {{ fmt(yesterdayEffectiveMs) }}</span>
      </div>
      <div class="st-compare-row">
        <span class="st-compare-name">近 {{ range }} 天 vs 前 {{ range }} 天</span>
        <span class="st-compare-main">
          {{ fmt(rangeMs) }}
          <em class="st-delta" :class="deltaTone(rangeMs, prevRangeEffectiveMs)">
            {{ pctDelta(rangeMs, prevRangeEffectiveMs) }}
          </em>
        </span>
        <span class="st-compare-sub">前 {{ range }} 天 {{ fmt(prevRangeEffectiveMs) }}</span>
      </div>
    </div>

    <div class="st-chart-head">
      <h2>最近 {{ range }} 天 · 目视有效</h2>
      <div class="st-range">
        <button
          v-for="n in [7, 30] as const"
          :key="n"
          type="button"
          :class="{ on: range === n }"
          @click="range = n"
        >{{ n }} 天</button>
      </div>
    </div>

    <div class="st-chart" :class="{ dense: range === 30 }">
      <div
        v-for="row in rows"
        :key="row.key"
        class="st-col"
        :title="dayTip(row.key, row.ms)"
      >
        <div class="st-track">
          <div
            class="st-bar"
            :class="{ valid: row.valid, flat: row.ms <= 0 }"
            :style="{ height: barHeight(row.ms) }"
          ></div>
        </div>
      </div>
    </div>
    <div class="st-axis">
      <span>{{ shortKey(rows[0]?.key ?? '') }}</span>
      <span v-if="allZero" class="st-axis-mid">还没有阅读记录，去读一会儿书吧</span>
      <span>{{ shortKey(rows[rows.length - 1]?.key ?? '') }}</span>
    </div>

    <template v-if="!offline">
      <div class="st-chart-head">
        <h2>时段分布 <span class="st-dim">（近 {{ range }} 天目视有效）</span></h2>
      </div>
      <div class="st-periods">
        <div v-for="p in periodRows" :key="p.key" class="st-period">
          <div class="st-period-top">
            <span class="st-period-name">{{ p.label }} <em>{{ p.hint }}</em></span>
            <span class="st-period-val">{{ p.pct }}%</span>
          </div>
          <div class="st-period-track"><i :style="{ width: `${p.pct}%` }"></i></div>
          <span class="st-period-ms">{{ fmt(p.ms) }}</span>
        </div>
      </div>
      <p v-if="!hasPeriodData" class="st-empty">这个范围内还没有有效阅读。</p>

      <div class="st-chart-head">
        <h2>星期 × 时段 <span class="st-dim">（近 {{ range }} 天目视有效）</span></h2>
        <span class="st-dim">格子深浅 = 该时段有效时长</span>
      </div>
      <div class="st-heat">
        <div class="st-heat-row head">
          <span class="st-heat-day"></span>
          <span v-for="k in PERIOD_KEYS" :key="k" class="st-heat-tag">{{ PERIOD_LABELS[k] }}</span>
        </div>
        <div v-for="row in weekdayRows" :key="row.index" class="st-heat-row">
          <span class="st-heat-day">{{ row.label }}</span>
          <span
            v-for="k in PERIOD_KEYS"
            :key="k"
            class="st-heat-cell"
            :class="{ empty: row.cells[k] <= 0 }"
            :style="{ background: heatColor(row.cells[k]) }"
            :title="`${row.label} · ${PERIOD_LABELS[k]} · 目视有效 ${fmt(row.cells[k])}`"
          >{{ row.cells[k] > 0 ? fmt(row.cells[k]) : '' }}</span>
        </div>
      </div>

      <div class="st-chart-head">
        <h2>听书趋势 <span class="st-dim">（近 {{ range }} 天朗读有效，独立单列）</span></h2>
        <span class="st-dim">合计 {{ fmt(listenRangeMs) }}</span>
      </div>
      <div class="st-chart listen" :class="{ dense: range === 30 }">
        <div
          v-for="row in listenRows"
          :key="row.key"
          class="st-col"
          :title="`${row.key} · 听书 ${fmt(row.ms)}`"
        >
          <div class="st-track">
            <div
              class="st-bar listen"
              :class="{ flat: row.ms <= 0 }"
              :style="{ height: barHeightOf(row.ms, listenPeak) }"
            ></div>
          </div>
        </div>
      </div>
      <p v-if="listenRangeMs <= 0" class="st-empty">这个范围内还没有朗读记录。</p>

      <div class="st-chart-head">
        <h2>阅读节奏 <span class="st-dim">（最近 {{ sessions.length }} 条原始会话）</span></h2>
        <span class="st-dim">间隔 = 下次开始 − 上次结束</span>
      </div>
      <div class="st-split">
        <div class="st-panel">
          <h2>两次阅读间隔</h2>
          <ul class="st-hbars">
            <li v-for="r in gaps" :key="r.key">
              <div class="st-hbar-top">
                <span>{{ r.label }}</span>
                <span class="st-dim">{{ r.count }} 次</span>
              </div>
              <div class="st-hbar-track">
                <i :style="{ width: `${(r.count / gapMax) * 100}%` }"></i>
              </div>
            </li>
          </ul>
        </div>
        <div class="st-panel">
          <h2>单次有效时长 <span class="st-dim">（目视）</span></h2>
          <ul class="st-hbars">
            <li v-for="r in lengths" :key="r.key">
              <div class="st-hbar-top">
                <span>{{ r.label }}</span>
                <span class="st-dim">{{ r.count }} 次</span>
              </div>
              <div class="st-hbar-track">
                <i :style="{ width: `${(r.count / lengthMax) * 100}%` }"></i>
              </div>
            </li>
          </ul>
        </div>
      </div>

      <div class="st-panel st-panel-wide">
        <h2>最近会话 <span class="st-dim">（最近 10 条）</span></h2>
        <ul v-if="latestSessions.length" class="st-sessions">
          <li v-for="s in latestSessions" :key="s.sessionId">
            <span class="st-mode" :class="`m-${s.mode}`">{{ modeLabel(s.mode) }}</span>
            <span class="st-session-name" :title="`${s.bookName} · ${s.chapterTitle}`">
              {{ s.bookName || s.bookUrl }} · {{ s.chapterTitle || `第 ${s.chapterIndex + 1} 章` }}
            </span>
            <span class="st-session-val">{{ fmt(s.effectiveMs) }}</span>
            <span class="st-break-time">{{ fmtTime(s.startAt) }}</span>
          </li>
        </ul>
        <p v-else class="st-empty">还没有可展示的会话流水。</p>
      </div>

      <div class="st-split">
        <div class="st-panel">
          <h2>按书 TOP <span class="st-dim">（目视有效 · 点书名下钻）</span></h2>
          <ul v-if="topBooks.length" class="st-list">
            <li
              v-for="b in topBooks"
              :key="b.bookUrl"
              class="click"
              @click="openDrill(b.bookUrl, b.bookName)"
            >
              <div class="st-list-main">
                <span class="st-list-name" :title="b.bookName">{{ b.bookName || b.bookUrl }}</span>
                <span class="st-list-val">{{ fmt(b.effectiveMs) }}</span>
              </div>
              <div class="st-list-track"><i :style="{ width: `${b.pct}%` }"></i></div>
              <div class="st-bk-foot">
                <div
                  class="st-bk-periods"
                  :title="b.dominant ? `最常读：${b.dominant}` : '时段暂无数据'"
                >
                  <i
                    v-for="p in b.periods"
                    :key="p.key"
                    :class="`p-${p.key}`"
                    :style="{ flexGrow: p.ms }"
                  ></i>
                </div>
                <span v-if="b.dominant" class="st-bk-tag">{{ b.dominant }}</span>
              </div>
            </li>
          </ul>
          <p v-else class="st-empty">还没有按书数据。</p>
        </div>

        <div class="st-panel">
          <h2>断点 TOP5 <span class="st-dim">（最近读到的章节 · 点书名下钻）</span></h2>
          <ul v-if="breakPoints.length" class="st-breaks">
            <li
              v-for="b in breakPoints"
              :key="b.bookUrl + b.lastReadAt"
              class="click"
              @click="openDrill(b.bookUrl, b.bookName)"
            >
              <div class="st-list-main">
                <span class="st-list-name" :title="b.bookName">{{ b.bookName || b.bookUrl }}</span>
                <span class="st-break-time">{{ fmtTime(b.lastReadAt) }}</span>
              </div>
              <div class="st-break-chapter">第 {{ b.chapterIndex + 1 }} 章 · {{ b.chapterTitle || '未记录标题' }}</div>
            </li>
          </ul>
          <p v-else class="st-empty">还没有断点记录。</p>
        </div>
      </div>

      <div class="st-panel st-panel-wide">
        <h2>常读作者 TOP5 <span class="st-dim">（按目视有效合并同名作者）</span></h2>
        <ul v-if="authors.length" class="st-list">
          <li v-for="a in authors" :key="a.author">
            <div class="st-list-main">
              <span class="st-list-name" :title="a.author">{{ a.author }}</span>
              <span class="st-list-val">
                {{ fmt(a.effectiveMs) }}
                <em class="st-author-books">· {{ a.bookCount }} 本</em>
              </span>
            </div>
            <div class="st-list-track"><i :style="{ width: `${a.pct}%` }"></i></div>
          </li>
        </ul>
        <p v-else class="st-empty">当前书目缺少作者信息。</p>
      </div>

      <div v-if="drill" class="st-panel st-panel-wide st-drill">
        <div class="st-chart-head">
          <h2>{{ drill.bookName || drill.bookUrl }} <span class="st-dim">（近 30 天 · 单书下钻）</span></h2>
          <button type="button" class="st-close" @click="closeDrill">收起</button>
        </div>

        <p v-if="drillLoading" class="st-empty">读取会话…</p>
        <template v-else>
          <div class="st-chart drill">
            <div
              v-for="p in drillSeries"
              :key="p.key"
              class="st-col"
              :title="`${p.key} · 目视有效 ${fmt(p.ms)}`"
            >
              <div class="st-track">
                <div
                  class="st-bar"
                  :class="{ flat: p.ms <= 0 }"
                  :style="{ height: barHeightOf(p.ms, drillPeak) }"
                ></div>
              </div>
            </div>
          </div>
          <div class="st-axis">
            <span>{{ shortKey(drillSeries[0]?.key ?? '') }}</span>
            <span class="st-dim">按会话开始日归属（与主图切片口径可能差 1 天）</span>
            <span>{{ shortKey(drillSeries[drillSeries.length - 1]?.key ?? '') }}</span>
          </div>

          <h3 class="st-drill-h">章节轨迹 <span class="st-dim">（按首次进入，最近 10 个章节）</span></h3>
          <ul v-if="drillTrack.length" class="st-breaks">
            <li v-for="c in drillTrack" :key="`${c.chapterIndex}-${c.startAt}`">
              <div class="st-list-main">
                <span class="st-list-name">第 {{ c.chapterIndex + 1 }} 章 · {{ c.chapterTitle || '未记录标题' }}</span>
                <span class="st-break-time">{{ fmtTime(c.startAt) }}</span>
              </div>
            </li>
          </ul>
          <p v-else class="st-empty">这本书还没有可展示的会话。</p>

          <h3 class="st-drill-h">最近会话 <span class="st-dim">（{{ drillRecent.length }} 条）</span></h3>
          <ul v-if="drillRecent.length" class="st-sessions">
            <li v-for="s in drillRecent" :key="s.sessionId">
              <span class="st-mode" :class="`m-${s.mode}`">{{ modeLabel(s.mode) }}</span>
              <span class="st-session-name">
                第 {{ s.chapterIndex + 1 }} 章 · {{ s.chapterTitle || '未记录标题' }}
              </span>
              <span class="st-session-val">{{ fmt(s.effectiveMs) }}</span>
              <span class="st-break-time">{{ fmtTime(s.startAt) }}</span>
            </li>
          </ul>
          <p v-else class="st-empty">没有会话。</p>
        </template>
      </div>
    </template>

    <footer class="st-foot">
      <p v-if="offline">
        服务端统计暂不可用，当前显示本机浏览器日桶（离线兜底）。恢复后自动切回服务端口径。
      </p>
      <p>口径：有效时长 = 正文可见 + 前台 + 页内 120 秒内有活动（翻页/滚动/切章/点击），不含挂机。</p>
      <p>「前台在线」是浮层打开且应用在前台的总时长（含听书/自动段），只作对照；「有效」是目视口径。</p>
      <p>朗读（听书）与自动滚动/自动翻页各自单列：听书不进目视有效，自动滚动不进入看板。</p>
      <p>星期/时段按会话切片归属；听书趋势只统计朗读会话。P2 数据全部来自同一份会话流水，未新增表。</p>
      <p>单日目视有效超过 {{ VALID_DAY_MIN_SEC }} 秒记为「有效日」，连续天数按有效日计算。</p>
      <p>「历史总额」是旧口径按书累计（含统计启用前的记录与朗读/挂机），与新统计并列展示、不做加总。</p>
      <p>P1 只统计文本阅读；漫画与 PDF 暂不纳入（下一期接入）。</p>
    </footer>
  </section>
</template>

<style scoped>
.st {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: min(860px, 100%);
  margin: 0 auto;
  padding: 4px 0 24px;
  color: var(--text-0);
}
.st-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.st-head h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 650;
  letter-spacing: 0.2px;
}
.st-sub {
  margin: 5px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.st-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.st-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-2);
}
.st-card.legacy {
  border-style: dashed;
  opacity: 0.92;
}
.st-label {
  font-size: 12px;
  color: var(--text-1);
}
.st-value {
  font-size: 19px;
  font-weight: 650;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.st-value small {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-1);
}
.st-hint {
  font-size: 11px;
  color: var(--muted);
}

.st-chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 2px;
}
.st-chart-head h2,
.st-panel h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.st-dim {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
}
.st-range {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: var(--bg-2);
}
.st-range button {
  border: 0;
  border-radius: 7px;
  padding: 4px 10px;
  background: transparent;
  color: var(--text-1);
  font-size: 12px;
  cursor: pointer;
}
.st-range button.on {
  background: var(--brand-soft);
  color: var(--brand);
}

.st-chart {
  display: flex;
  align-items: stretch;
  gap: 6px;
  height: 132px;
  padding-top: 6px;
}
.st-chart.dense {
  gap: 3px;
}
.st-col {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
}
.st-track {
  display: flex;
  flex: 1 1 0;
  align-items: flex-end;
  min-width: 0;
  border-radius: 6px 6px 3px 3px;
  background: var(--bg-2);
  overflow: hidden;
}
.st-bar {
  width: 100%;
  border-radius: 6px 6px 3px 3px;
  background: color-mix(in srgb, var(--brand) 42%, transparent);
  transition: height 0.18s ease;
}
.st-bar.valid {
  background: var(--brand);
}
.st-bar.flat {
  background: var(--bg-3);
}
.st-axis {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: -10px;
  font-size: 11px;
  color: var(--muted);
}
.st-axis-mid {
  color: var(--muted);
  opacity: 0.8;
}

.st-periods {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 18px;
}
.st-period {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.st-period-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
}
.st-period-name em {
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
}
.st-period-val {
  font-variant-numeric: tabular-nums;
  color: var(--text-0);
}
.st-period-track,
.st-list-track {
  height: 6px;
  border-radius: 999px;
  background: var(--bg-2);
  overflow: hidden;
}
.st-period-track i,
.st-list-track i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand) 72%, transparent);
}
.st-period-ms {
  font-size: 11px;
  color: var(--muted);
}

.st-split {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.st-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-2);
}
.st-list,
.st-breaks {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.st-list-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 5px;
}
.st-list-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--text-0);
}
.st-list-val {
  flex: none;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
}
.st-break-time {
  flex: none;
  font-size: 11px;
  color: var(--muted);
}
.st-break-chapter {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-empty {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.st-foot {
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.st-foot p {
  margin: 0 0 6px;
  font-size: 11px;
  line-height: 1.65;
  color: var(--muted);
}
.st-foot p:last-child {
  margin-bottom: 0;
}

/* ---- P2：环比 ---- */
.st-compare {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-2);
}
.st-compare-row {
  display: grid;
  grid-template-columns: 170px 1fr auto;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  color: var(--text-1);
}
.st-compare-name {
  color: var(--muted);
}
.st-compare-main {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-0);
}
.st-delta {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-style: normal;
  font-size: 11px;
  font-weight: 600;
}
.st-delta.up {
  color: var(--brand);
  background: var(--brand-soft);
}
.st-delta.down {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
}
.st-delta.flat {
  color: var(--muted);
  background: var(--bg-3);
}
.st-compare-sub {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* ---- P2：星期 × 时段热力图 ---- */
.st-heat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.st-heat-row {
  display: grid;
  grid-template-columns: 44px repeat(4, minmax(0, 1fr));
  gap: 4px;
}
.st-heat-row.head {
  font-size: 11px;
  color: var(--muted);
}
.st-heat-day {
  display: flex;
  align-items: center;
  font-size: 11px;
  color: var(--muted);
}
.st-heat-tag {
  padding: 2px 0;
  text-align: center;
}
.st-heat-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  overflow: hidden;
  border-radius: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-0);
}
.st-heat-cell.empty {
  background: var(--bg-2);
  opacity: 0.55;
}

/* ---- P2：听书柱 ---- */
.st-chart.listen {
  height: 92px;
}
.st-bar.listen {
  background: #9b8cff;
  opacity: 0.85;
}

/* ---- P2：按书时段条 ---- */
.st-bk-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.st-bk-periods {
  display: flex;
  flex: 1 1 auto;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-3);
}
.st-bk-periods i {
  display: block;
  flex-basis: 0;
  min-width: 0;
}
.p-dawn {
  background: #7aa7ff;
}
.p-morning {
  background: #4f8cff;
}
.p-afternoon {
  background: #f1b14a;
}
.p-night {
  background: #a78bfa;
}
.st-bk-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--brand);
  background: var(--brand-soft);
}
.st-author-books {
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
}

/* ---- P2 B1：节奏条 / 会话列表 ---- */
.st-hbars {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.st-hbar-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--text-1);
}
.st-hbar-track {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-3);
}
.st-hbar-track i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand) 70%, transparent);
}
.st-sessions {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.st-sessions li {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto auto;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
}
.st-mode {
  justify-self: start;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--text-1);
  background: var(--bg-3);
}
.st-mode.m-visual {
  color: var(--brand);
  background: var(--brand-soft);
}
.st-mode.m-listen {
  color: #8f7dff;
  background: color-mix(in srgb, #9b8cff 18%, transparent);
}
.st-mode.m-auto {
  color: var(--muted);
  background: var(--bg-3);
}
.st-session-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-session-val {
  font-variant-numeric: tabular-nums;
  color: var(--text-0);
}

/* ---- P2 B2：单书下钻 ---- */
.st-list li.click,
.st-breaks li.click {
  cursor: pointer;
  border-radius: 8px;
}
.st-list li.click:hover,
.st-breaks li.click:hover {
  background: var(--bg-3);
}
.st-drill {
  border-color: color-mix(in srgb, var(--brand) 35%, var(--border));
}
.st-chart.drill {
  height: 96px;
}
.st-axis .st-dim {
  font-size: 11px;
}
.st-drill-h {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-0);
}
.st-close {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-1);
  font-size: 12px;
  cursor: pointer;
}
.st-close:hover {
  color: var(--brand);
  border-color: var(--brand);
}

@media (max-width: 720px) {
  .st-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .st-split,
  .st-periods {
    grid-template-columns: minmax(0, 1fr);
  }
  .st-compare-row {
    grid-template-columns: 1fr auto;
  }
  .st-compare-name {
    grid-column: 1 / -1;
  }
  .st-sessions li .st-break-time {
    display: none;
  }
}
</style>
