/**
 * `#746` B1 / `#753` B2：**批处理子进程入口**（`child_process.fork` 装载）。
 *
 * 职责：在自己的 Node 进程里建一份**同构的 `EngineHub`**，跑源体检 / 静态校验 / 批量校验，
 * 结果经 IPC 回主进程。这样那些「跑源 JS + 同步 HTTP」的重活不再占主线程。
 *
 * B2（`YUEDU_B2_PROCESS=1`，默认关）追加：
 *  · `login` 任务：**纯 HTTP 登录脚本**在本进程求值（浏览器类脚本由主进程判据挡在外面）；
 *  · `patrol` **摘要模式**：lint + 结构校验在本进程算完，只回结果行（不回 762 份 raw，省 ~600ms）；
 *  · **自适应并发**（CPU/内存）+ worker 池内存上限 + 每次任务后回 `status`；
 *  · **版本号**：结果原样回带任务版本；收到 `reload` 时丢掉 hub 快照（在飞任务结束后生效）。
 *
 * ★★ **单写者**：
 *  · 源库用 `SourceDb.openReadOnly()` —— 不建表、不写 schema、不设 WAL；
 *  · `kv.json` 只读（`createFileKeyValueStore` 只读文件到内存），**任何 set/delete 都不落盘**，
 *    而是以 `{t:'kv-write'}` 交回主进程执行；
 *  · 登录产出的 Cookie 以 `{t:'cookie-write'}` 交回主进程（只回**该源** map，避免整文件覆盖）；
 *  · 体检快照 / 源标记等结果同样只回主进程，由主进程落盘（`doctor-patrol.json`、`sourceLayer.persist`）。
 *  ⇒ 子进程全程**不写任何 `data/**`**，所以它崩溃/被杀不会留下半截数据。
 *
 * ★ **不搬的东西**（浏览器/验证码，见 B2 §4 可行性结论）：
 * 本进程**不注入** `webRenderer` / `verificationCode` / `antibotReplay` / Cookie 收割 ——
 * 需要真浏览器的登录脚本、验证窗、CDP screencast 全部留在主进程。
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  createFileKeyValueStore,
  createWorkerSandboxPool,
  lintSource,
  sourceKindOf,
  SourceDb,
  // `#754` DOM 后端启动预热（默认关；批量任务同样吃冷启动）
  prewarmDomBackend,
  type KeyValueStore,
  type ValidationIssue,
} from '@yuedu/core';
import { EngineHub, createVaultStore, openJsonFile } from '@yuedu/facade';
import { LegadoEngine } from '@yuedu/engine-legado';
import { MacCmsEngine } from '@yuedu/engine-maccms';
import { RssEngine } from '@yuedu/engine-rss';
import { DemoEngine } from './demo-engine';
import type { BatchJobMessage, BatchLoginPayload, BatchPatrolRow } from './batch-protocol';

const DATA_DIR = process.env['YUEDU_DATA_DIR'] ?? path.join(process.cwd(), 'data');
const SOURCE_DB_FILE = process.env['YUEDU_SOURCE_DB'] ?? path.join(DATA_DIR, 'yuedu.db');
const KV_FILE = process.env['YUEDU_KV_FILE'] ?? path.join(DATA_DIR, 'kv.json');
const COOKIES_FILE = process.env['YUEDU_COOKIES_FILE'] ?? path.join(DATA_DIR, 'cookies.json');
const SESSION_UA_FILE = process.env['YUEDU_SESSION_UA_FILE'] ?? path.join(DATA_DIR, 'session-ua.json');

/**
 * `#B1` 过闸 UA 与主进程同源：主进程启动时把各源的登录态 UA 写进 `session-ua.json`，
 * 批量校验若不注入，同一源会出现「主进程校验通过、批处理校验 NETWORK」的假失败
 * （实测 89 个图片源里有 10 个登录态 UA，含漫画柜 / MYCOMIC / 拷贝漫画 / 漫蛙等）。
 */
function loadSessionUa(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_UA_FILE, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [id, ua] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof ua === 'string' && ua.trim()) out[id] = ua;
    }
    return out;
  } catch {
    return {};
  }
}

/** B2 总开关（与主进程同一个 env；默认关） */
const B2 = process.env['YUEDU_B2_PROCESS'] === '1';

/**
 * 子进程内的批量并发。
 *
 * · **B2 关**：保持 `#746` 的数值（`YUEDU_BATCH_CONCURRENCY`，默认 2，上限 2）—— 行为逐字一致；
 * · **B2 开**：显式 env 优先（1..4）；否则按 CPU/内存自适应（见 `adaptiveConcurrency`）。
 */
function adaptiveConcurrency(): number {
  const explicit = Number(process.env['YUEDU_BATCH_CONCURRENCY'] ?? '');
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(4, Math.max(1, Math.round(explicit)));
  if (!B2) {
    const def = Number(process.env['YUEDU_BATCH_CONCURRENCY'] ?? 2) || 2;
    return Math.min(2, Math.max(1, def));
  }
  const cores = os.cpus()?.length || 2;
  const freeGb = os.freemem() / (1024 ** 3);
  /**
   * 内存优先：在线体检是 IO 主导，真正吃内存的是 jsdom/JS 库。
   * 留 1.5GB 给主进程 + Chromium 会话，低于该线就退回 1，宁慢不 OOM。
   */
  if (freeGb < 1.5) return 1;
  if (cores <= 2 || freeGb < 3) return 2;
  return Math.min(4, Math.max(2, Math.floor(cores / 2)));
}

/**
 * worker 池单 worker 内存上限（B2 才设）。
 * `resourceLimits.maxOldGenerationSizeMb` 到顶时 worker 会被 V8 干掉 → 池自动补位
 * （`worker-pool` 的错误处理会 refill），本进程不受影响。
 */
const WORKER_MEM_MB = B2
  ? Math.max(64, Number(process.env['YUEDU_BATCH_WORKER_MEM_MB'] ?? 256) || 256)
  : 0;

function send(msg: unknown): void {
  try {
    process.send?.(msg);
  } catch {
    /* 主进程已断开（正常退出） */
  }
}
function log(msg: string): void {
  send({ t: 'log', msg });
}

/**
 * 只读存储视图：读走本地内存（来自 `kv.json`），写**只回主进程**。
 * 注意：先在本地 Map 生效（同一子进程内的后续读要能看见），但不触发任何磁盘写。
 */
function readOnlyStore(file: string): KeyValueStore {
  const base = createFileKeyValueStore(file);
  const local = new Map<string, string>();
  return {
    get: async (k) => (local.has(k) ? (local.get(k) as string) : base.get(k)),
    set: async (k, v) => {
      local.set(k, v);
      send({ t: 'kv-write', key: k, value: v });
    },
    delete: async (k) => {
      local.delete(k);
      send({ t: 'kv-write', key: k, value: null });
    },
  };
}

function buildHub(): EngineHub {
  const db = SourceDb.openReadOnly(SOURCE_DB_FILE).db;
  const sessionUa = loadSessionUa();
  const uaCount = Object.keys(sessionUa).length;
  const hub = new EngineHub({
    storage: createVaultStore(readOnlyStore(KV_FILE)),
    // 与主进程同一档：DOM/JS 在 worker 线程里跑（不会反过来抢本进程的主线程）
    sandbox: createWorkerSandboxPool({
      size: 2,
      defaultTimeoutMs: 10_000,
      ...(WORKER_MEM_MB ? { memoryLimitMb: WORKER_MEM_MB } : {}),
    }),
    timeoutMs: 60_000,
    sessionUaOf: (id) => sessionUa[id],
    ...(Number(process.env.YUEDU_RUN_TIMEOUT_MS) > 0
      ? { runTimeoutMs: Number(process.env.YUEDU_RUN_TIMEOUT_MS) }
      : {}),
  });
  hub.registerEngine(new LegadoEngine());
  hub.registerEngine(new MacCmsEngine());
  hub.registerEngine(new RssEngine());
  // 与主进程同构：演示源是**内存内置**的一条（不在源库里），少注册它会让巡检少 1 源
  hub.registerEngine(new DemoEngine());
  hub.importSource(
    { name: '演示源', kind: 'demo' },
    { id: 'demo', preferred: 'demo', state: { enabled: true, searchEnabled: true, exploreEnabled: true } },
  );
  for (const row of db.loadWithStats().rows) {
    try {
      hub.importSource(row.raw, {
        id: row.id,
        preferred: row.kind,
        state: row.state,
        ...(row.name ? { name: row.name } : {}),
      });
    } catch {
      /* 编译失败的源不拖垮整批（与主进程启动装载同一口径：逐条 try） */
    }
  }
  log(`源库装载完成：${hub.sources.size()} 源（只读 ${path.basename(SOURCE_DB_FILE)}）· 过闸 UA ${uaCount} 源`);
  /**
   * 登录脚本要能看见**已有登录态**（Cookie）—— 主进程启动时从 `cookies.json` 恢复，
   * 本进程也必须做同一件事，否则「已登录的源再点登录」会拿不到旧 Cookie
   * （例如登录脚本读 `java.getCookie(url)` 做续期）。只读，不写回。
   */
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const text = fs.readFileSync(COOKIES_FILE, 'utf-8');
      const { data, failed } = openJsonFile<Record<string, string>>(text);
      let n = 0;
      if (!failed && data) {
        for (const [id, cookie] of Object.entries(data)) {
          if (hub.setSourceCookies(id, String(cookie ?? ''))) n += 1;
        }
      }
      log(`已恢复 ${n} 个源的 Cookie（只读 ${path.basename(COOKIES_FILE)}${failed ? ' · 解密失败，按空处理' : ''}）`);
    }
  } catch {
    log(`Cookie 文件读取失败，按空登录态运行：${COOKIES_FILE}`);
  }
  return hub;
}

let hubRef: EngineHub | null = null;
/** 源库版本（由 job 携带 / reload 更新） */
let version = 0;
/** 在飞任务（reload 不能在任务中途丢 hub，否则任务引用被换掉） */
let busy = 0;
/** reload 排队（busy 时置位，任务结束后丢 hub 快照） */
let reloadQueued = false;
/** 快照重建的定时器（reload 后空闲时重建，避免下一次登录替 4s 的装载买单） */
let rebuildTimer: NodeJS.Timeout | null = null;

function hub(): EngineHub {
  hubRef ??= buildHub();
  return hubRef;
}

/**
 * `reload` 的真正生效点：丢掉快照，并在**空闲时**重建 + 全量编译一次。
 *
 * 实测：源开关切换后第一次登录若等任务来才重建，wall 4.3s（装载 763 源）；
 * 空闲重建把这笔钱摊到无人使用的时刻，下一次登录回到 ~0.2s。
 * 重建失败只记日志（下一次任务还会再试）。
 */
function dropHub(reason: string): void {
  if (!hubRef) return;
  hubRef = null;
  log(`已丢弃源库快照（${reason}），空闲时重建`);
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    try {
      const h = hub();
      const v = h.validateAll();
      log(`快照重建完成：${h.sources.size()} 源 · 编译 ${v.results.length} 条（${reason}）`);
    } catch (e) {
      log(`快照重建失败（下次任务再试）：${e instanceof Error ? e.message : String(e)}`);
    }
  }, 300);
  rebuildTimer.unref?.();
}

/** 读「注释 / 分组」两字段（`verifySources` 的 markOnError 只动这两个） */
function markFieldsOf(ids: string[]): Map<string, { c?: string; g?: string }> {
  const byId = new Map(hub().sources.list().map((s) => [s.id, s]));
  const out = new Map<string, { c?: string; g?: string }>();
  for (const id of ids) {
    const s = byId.get(id);
    if (!s) continue;
    const raw = (s.raw ?? {}) as Record<string, unknown>;
    out.set(id, {
      c: typeof raw['bookSourceComment'] === 'string' ? (raw['bookSourceComment'] as string) : undefined,
      g: typeof raw['bookSourceGroup'] === 'string' ? (raw['bookSourceGroup'] as string) : undefined,
    });
  }
  return out;
}

async function runLogin(p: BatchLoginPayload): Promise<unknown> {
  const sourceId = String(p?.sourceId ?? '');
  if (!sourceId) throw new Error('login 任务缺少 sourceId');
  const before = hub().getSourceCookies(sourceId);
  const out = await hub().login(sourceId, p?.opts ?? {});
  const after = hub().getSourceCookies(sourceId);
  /**
   * 登录产出的 Cookie **整源替换**交回主进程（单写者：本进程不写 cookies.json）。
   * 只在变化时发，避免把「本来就有」的 Cookie 又写一遍。
   */
  if (after !== before) {
    const map: Record<string, string> = {};
    for (const pair of after.split(';')) {
      const i = pair.indexOf('=');
      if (i > 0) map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    send({ t: 'cookie-write', sourceId, cookies: Object.keys(map).length ? map : null });
  }
  return {
    login: out,
    cookie: after,
    loginInfo: hub().getSourceLoginInfo(sourceId),
    variable: hub().getSourceVariable(sourceId),
  };
}

async function runJob(msg: BatchJobMessage): Promise<unknown> {
  /**
   * B2 **预热**：主进程在服务启动后发一条空任务，只为触发 hub 装载（6~10s 冷启动）。
   * 最关键的是「用户第一次点登录」不再替冷启动买单（登录请求从 10s 降到 ~0.2s）。
   */
  if (msg.kind === 'warmup') {
    /**
     * **预热**不能只数源：源规则是**懒编译**的，第一次点某源登录会替它付「编译 jsLib + 起
     * sandbox worker」的钱（实测哔咔首登 +8s）。`validateAll()` 会把全部源编译一遍，
     * 后面第一次登录就只剩求值本身（实测 ~0.2s）。
     */
    const v = hub().validateAll();
    return { sources: hub().sources.size(), checked: v.results.length, b2: B2 };
  }
  if (msg.kind === 'patrol') {
    // 与主进程的 `collect()` 同形：结构校验（引擎 validate）+ 规则 lint
    const v = hub().validateAll();
    const structById = new Map(v.results.map((r) => [r.id, r.issues as ValidationIssue[]]));
    /**
     * B2 **摘要模式**：lint 在子进程算完，只回 `{id,name,kind,lint,struct}`。
     * B1 旧行为原样保留（回 raw，主进程自己 lint）—— `YUEDU_B2_PROCESS` 关时逐字一致。
     */
    const rows: BatchPatrolRow[] = hub().sources.list().map((s) => {
      const base = { id: s.id, kind: s.kind, ...(s.name ? { name: s.name } : {}) };
      const raw = (s.raw ?? {}) as Record<string, unknown>;
      if (B2) {
        return {
          ...base,
          lint: lintSource(raw, sourceKindOf(raw)),
          struct: structById.get(s.id) ?? [],
        } as BatchPatrolRow;
      }
      return { ...base, raw, issues: structById.get(s.id) ?? [] } as BatchPatrolRow;
    });
    return rows;
  }
  if (msg.kind === 'validate-all') {
    return hub().validateAll();
  }
  if (msg.kind === 'verify') {
    const p = msg.payload as { ids?: unknown; opts?: { keyword?: string; concurrency?: number; markOnError?: boolean; checkDiscoveryDeep?: boolean } };
    const ids = Array.isArray(p?.ids) ? (p.ids as string[]) : [];
    const conc = adaptiveConcurrency();
    const opts = { ...(p?.opts ?? {}), concurrency: Math.min(conc, (p?.opts?.concurrency ?? conc) || conc) };
    // 打标只在**本进程内存**里发生（`markOnError`）；真正写库由主进程按 `changed` 回放
    const before = markFieldsOf(ids);
    const results = await hub().verifySources(ids, opts);
    const after = markFieldsOf(ids);
    const changed = ids
      .map((id) => {
        const a = after.get(id);
        const b = before.get(id);
        if (!a) return null;
        if (a.c === b?.c && a.g === b?.g) return null;
        return { id, ...(a.c !== b?.c ? { comment: a.c } : {}), ...(a.g !== b?.g ? { group: a.g } : {}) };
      })
      .filter((x): x is { id: string; comment?: string; group?: string } => x !== null);
    return { results, changed };
  }
  if (msg.kind === 'login') {
    return runLogin(msg.payload as BatchLoginPayload);
  }
  throw new Error(`未知批处理任务：${String((msg as { kind?: unknown }).kind)}`);
}

process.on('message', (raw: unknown) => {
  const m = raw as BatchJobMessage | { t: 'reload'; version: number; reason?: string };
  if (!m || typeof m !== 'object') return;
  if (m.t === 'reload') {
    version = Number(m.version) || version;
    if (busy > 0) {
      reloadQueued = true;
      log(`收到源库重载通知（version=${version}），在飞任务结束后生效`);
    } else {
      dropHub(String((m as { reason?: string }).reason ?? '主进程源变更'));
      log(`收到源库重载通知（version=${version}）`);
    }
    return;
  }
  if (m.t !== 'job' || typeof (m as BatchJobMessage).id !== 'string') return;
  const msg = m as BatchJobMessage;
  version = typeof msg.version === 'number' ? msg.version : version;
  // 任务先到 ⇒ 取消空闲重建，直接由本任务装载（避免重建与任务各建一次）
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }
  const t0 = performance.now();
  busy += 1;
  void (async () => {
    try {
      const result = await runJob(msg);
      send({ t: 'result', id: msg.id, ok: true, result, ms: Math.round(performance.now() - t0), version: msg.version });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`任务失败 kind=${msg.kind}：${error}`);
      send({ t: 'result', id: msg.id, ok: false, error, ms: Math.round(performance.now() - t0), version: msg.version });
    } finally {
      busy -= 1;
      if (busy === 0 && reloadQueued) {
        reloadQueued = false;
        dropHub('重载排队后生效');
      }
      const mem = process.memoryUsage();
      send({
        t: 'status',
        version: msg.version,
        concurrency: adaptiveConcurrency(),
        rssMb: Math.round(mem.rss / (1024 * 1024)),
        heapMb: Math.round(mem.heapUsed / (1024 * 1024)),
        workerMemMb: WORKER_MEM_MB,
      });
    }
  })();
});

// 主进程断开（正常关停/崩溃）⇒ 本进程跟着退出，不留孤儿
process.on('disconnect', () => process.exit(0));
log(
  `batch-child ready pid=${process.pid} dataDir=${DATA_DIR} ` +
    `concurrency=${adaptiveConcurrency()} b2=${B2 ? 'on' : 'off'} workerMem=${WORKER_MEM_MB || '-'}MB`,
);
// `#754` 子进程启动预热（默认关）：与主进程同一份实现，后台跑，不挡 ready 日志/首任务。
void prewarmDomBackend()?.then((r) => {
  if (r) log(`DOM 预热结果：${JSON.stringify(r)}`);
});
