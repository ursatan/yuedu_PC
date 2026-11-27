/**
 * `#552` **源医生 v2-F：离线巡检的判据与差分**（无 LLM、不联网）。
 *
 * 前面几刀解决的是「**判**」与「**验**」：`#521` 离线分类 · `#542` 规则 lint 表 ·
 * `#550` 失败归因 · `#551` 单字段试跑。缺的是「**不用用户想起来跑**」——
 * 本模块只做**离线**巡检（结构校验 + lint，两条都已在仓里），并把结果**差分**成
 * 「这轮新出现了什么」，供服务端定时跑 + 前端播报。
 *
 * ★★ 最重要的一条判据：**首轮不播报，只建基线**。
 *
 * 为什么：全量实测（733 源，`pnpm check:lint --json`）= error 级 **69 条发现 / 涉及 36 个源**
 * （L008 语法错 34 · L001 解构箭头缺括号 26 · L002 不可见字符 9）。
 * 若按「启动后跑一次就播报」的原设计，用户一开机就会看到「36 个源规则异常」——
 * 那 36 个是**长期存量**（导入时就那样），不是「刚刚变坏」，弹它只会训练用户忽略源医生。
 * 所以：**首轮 = 建立基线**（落盘 + 可查 + 服务日志留痕），
 * **之后每轮只播「相对上一轮新增」的**。修好了也报（`fixed`），让「改完变好」有正反馈。
 *
 * 纪律：
 *  · **只汇总，不重算**：判据来自 `lintSource`（`#542`）与引擎 `validate`（结构校验），
 *    本模块一行判据都不写 —— 否则就是第三套口径（`#158` 的旧坑）。
 *  · **只播 error 级**：warn 11 源 / info 41 源是「可能有问题」，播它们等于刷屏；
 *    warn 仍然进快照（`warned`），详情里能看，只是不弹。
 *  · **差分可单测**：新增/恢复/存量三类都要有正例与反例（否则会退化成「每轮全报」）。
 */

import type { LintFinding } from './rule-lint';
import type { ValidationIssue } from '../contract/engine';

/** 一个源的巡检结论（**只含 error 级**；warn 去 `PatrolSnapshot.warned`） */
export interface PatrolIssue {
  id: string;
  name: string;
  kind: string;
  /**
   * 归一化缺陷码（**去重 + 升序**）：
   *  · lint ⇒ `ruleId`（`L008` / `L001` / `L002` …）
   *  · 结构 ⇒ `STRUCT:<path>`（如 `STRUCT:bookSourceUrl`）
   * 差分按**码**比，不按条数比 ⇒ 「同一个源又多了一种错」也能被发现。
   */
  codes: string[];
  /** error 级发现条数（一个源可能多条） */
  count: number;
  /** 最先出现的那条消息（播报时给个具体的例子，而不是只报码） */
  sample: string;
}

export interface PatrolSnapshot {
  /** 本轮跑完的时间（epoch ms）——前端用「已消费到哪个 at」避免重复弹 */
  at: number;
  /** 参与巡检的源数 */
  sources: number;
  /** 全量发现条数（三档都记，详情页用） */
  counts: { error: number; warn: number; info: number };
  /** error 级：按源聚合（**播报只用它**），按 id 升序 */
  issues: PatrolIssue[];
  /** warn 级：按源聚合（**详情里看，不播报**） */
  warned: Array<{ id: string; name: string; codes: string[] }>;
  /** 本轮耗时 ms（可观测：巡检不该是黑盒） */
  ms: number;
}

export interface PatrolRow {
  id: string;
  name?: string;
  kind: string;
  /** `#542` lint 表的产出（与 `pnpm check:lint` 同一判据） */
  lint?: LintFinding[];
  /** 引擎 `validate()` 的结构校验产出 */
  struct?: ValidationIssue[];
}

export interface PatrolDelta {
  /** 新出现 error、或**缺陷码变多**的源（播报的对象） */
  added: PatrolIssue[];
  /** 这轮恢复（error 全没了）的源 id */
  fixed: string[];
  /** 上一轮就有、这轮还在的源 id（存量，**不播报**） */
  persisted: string[];
  /** 首轮（没有上一轮）⇒ `added` 恒为空，只建基线 */
  baseline: boolean;
}

/** 结构化缺陷码前缀（与 lint 的 `L00x` 区分开，一眼看出是哪套判据出的） */
export const STRUCT_CODE_PREFIX = 'STRUCT:';

function uniqSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/**
 * 把「每源的 lint + 结构校验产出」汇总成一份快照。
 *
 * ⚠️ 只收 **error 级**进 `issues`（warn 进 `warned`、info 只记条数）——
 * 实测 warn 11 源 / info 41 源，若也播报就是每 6h 一次噪音。
 */
export function buildSnapshot(rows: PatrolRow[], at: number, ms: number): PatrolSnapshot {
  const counts = { error: 0, warn: 0, info: 0 };
  const issues: PatrolIssue[] = [];
  const warned: Array<{ id: string; name: string; codes: string[] }> = [];
  for (const r of rows) {
    const lint = r.lint ?? [];
    const struct = r.struct ?? [];
    for (const f of lint) counts[f.severity] += 1;
    for (const s of struct) counts[s.level] += 1;

    const errCodes = [
      ...lint.filter((f) => f.severity === 'error').map((f) => f.ruleId),
      ...struct.filter((s) => s.level === 'error').map((s) => `${STRUCT_CODE_PREFIX}${s.path ?? '(源)'}`),
    ];
    const errCount =
      lint.filter((f) => f.severity === 'error').length + struct.filter((s) => s.level === 'error').length;
    if (errCount > 0) {
      const sample =
        lint.find((f) => f.severity === 'error')?.message ??
        struct.find((s) => s.level === 'error')?.message ??
        '';
      issues.push({
        id: r.id,
        name: r.name ?? r.id,
        kind: r.kind,
        codes: uniqSorted(errCodes),
        count: errCount,
        sample,
      });
    }
    const warnCodes = [
      ...lint.filter((f) => f.severity === 'warn').map((f) => f.ruleId),
      ...struct.filter((s) => s.level === 'warn').map((s) => `${STRUCT_CODE_PREFIX}${s.path ?? '(源)'}`),
    ];
    if (warnCodes.length) warned.push({ id: r.id, name: r.name ?? r.id, codes: uniqSorted(warnCodes) });
  }
  issues.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  warned.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { at, sources: rows.length, counts, issues, warned, ms };
}

/**
 * **与上一轮差分** —— 播报只报 `added`。
 *
 * ★ `prev == null` ⇒ `baseline: true` 且 **`added` 恒为空**：
 * 首轮那 36 个 error 源是存量，弹它不是「发现问题」而是「念一遍存量」（见文件头实测数字）。
 */
export function diffSnapshots(prev: PatrolSnapshot | null, next: PatrolSnapshot): PatrolDelta {
  if (!prev) return { added: [], fixed: [], persisted: next.issues.map((i) => i.id), baseline: true };
  const prevById = new Map(prev.issues.map((i) => [i.id, i.codes]));
  const nextById = new Map(next.issues.map((i) => [i.id, i.codes]));

  const added: PatrolIssue[] = [];
  const persisted: string[] = [];
  for (const i of next.issues) {
    const before = prevById.get(i.id);
    if (!before) {
      added.push(i); // 新出现
      continue;
    }
    // 码变多 ⇒ 也算「新增」（同一个源又坏了一种，用户刚改过的可能性最大）
    const grew = i.codes.some((c) => !before.includes(c));
    if (grew) added.push(i);
    else persisted.push(i.id);
  }
  const fixed = [...prevById.keys()].filter((id) => !nextById.has(id)).sort();
  return { added, fixed, persisted, baseline: false };
}

/**
 * 播报文案；**返回 null = 不弹**。
 *
 * 不弹的三种情况（都必须是**显式**的，不是「忘了弹」）：
 *  ① 首轮（建基线）· ② 没有新增 · ③ 只恢复了（也弹，但用 ok 口吻 —— 修好了要给正反馈）。
 */
export function patrolToastText(
  delta: PatrolDelta,
  opts: { maxNames?: number } = {},
): { text: string; level: 'warn' | 'ok' } | null {
  const maxNames = Math.max(1, Math.min(8, opts.maxNames ?? 3));
  if (delta.baseline) return null; // 首轮只建基线
  if (delta.added.length === 0) {
    if (delta.fixed.length === 0) return null;
    const names = delta.fixed.slice(0, maxNames).join('、');
    const more = delta.fixed.length > maxNames ? ` 等 ${delta.fixed.length} 个` : '';
    return { text: `源医生：${names}${more} 规则异常已修复`, level: 'ok' };
  }
  /**
   * 展示顺序：**错得多的在前**（同数按名字）。
   *
   * 为什么不用 `added` 本身的顺序（按 id 升序）：id 是 `bookSourceUrl` 的规范化形态
   * （`_____VIP5.0` / `https___x.com` 这类），**对人没有意义** —— 按它取前 3 个等于随机抽样。
   * 错得多 ⇒ 更可能是用户刚动过、也更该先修。
   */
  const a = [...delta.added].sort((x, y) => y.count - x.count || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const names = a.slice(0, maxNames).map((i) => i.name).join('、');
  const more = a.length > maxNames ? ` 等 ${a.length} 个` : '';
  const first = a[0]!;
  const code = first.codes[0] ?? '';
  // 「N 个源规则异常」+ 一个具体例子（只报码用户不知道发生了什么）
  const detail = a.length === 1 ? `（${code} ${first.sample}）`.slice(0, 90) : '';
  return { text: `源医生：${a.length} 个源规则异常 —— ${names}${more}${detail}`, level: 'warn' };
}
