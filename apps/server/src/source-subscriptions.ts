/**
 * `B21` 远程书源订阅（规则订阅）。
 *
 * 只做**地址簿**：记住用户订阅的源列表 URL；「更新」永远走「源管理 → 导入源」的
 * 抓取 → 预览 → 勾选 → 确认流程（强制预览，不静默覆盖），所以这里**不缓存源内容**、
 * 也不做后台轮询。
 *
 * 存储：`DATA_DIR/source-subscriptions.json`，独立文件（不污染引擎 kv / 用户库）。
 * 写入用「临时文件 + rename」原子替换，避免写一半断电把地址簿写坏。
 */
import fs from 'node:fs';
import path from 'node:path';

export type SourceSubFormat = 'auto' | 'legado' | 'maccms';

export interface SourceSubscription {
  id: string;
  name: string;
  url: string;
  format: SourceSubFormat;
  /** 创建时间（毫秒） */
  createdAt: number;
  /** 最近一次成功确认导入的时间（毫秒）；0 = 从未更新过 */
  updatedAt: number;
}

export interface SourceSubsStore {
  file: string;
  list(): SourceSubscription[];
  /** 整体替换地址簿（顺序即展示顺序）；非法条目会抛错，交给路由回 400 */
  replace(input: unknown): SourceSubscription[];
}

const MAX_SUBS = 200;
const FORMATS: readonly SourceSubFormat[] = ['auto', 'legado', 'maccms'];

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 生成稳定可读的默认名：URL 最后一段（去掉扩展名），空则用主机名 */
function autoName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    const base = last.replace(/\.(json|txt|ya?ml)$/i, '');
    return (base || u.hostname).slice(0, 60);
  } catch {
    return '未命名订阅';
  }
}

/** 把请求体（未知形状）规范成地址簿；任何一条 URL 非法 ⇒ 整批拒绝，避免静默丢订阅 */
function normalize(input: unknown, prev: SourceSubscription[]): SourceSubscription[] {
  if (!Array.isArray(input)) throw new Error('订阅列表必须是数组');
  if (input.length > MAX_SUBS) throw new Error(`最多 ${MAX_SUBS} 条订阅`);
  const byId = new Map(prev.map((s) => [s.id, s]));
  const seenUrl = new Set<string>();
  const now = Date.now();
  const out: SourceSubscription[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new Error('订阅条目格式错误');
    const r = raw as Partial<SourceSubscription>;
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    if (!url || !isHttpUrl(url)) throw new Error(`订阅地址必须是 http/https：${url || '(空)'}`);
    if (seenUrl.has(url)) throw new Error(`订阅地址重复：${url}`);
    seenUrl.add(url);
    const old = typeof r.id === 'string' ? byId.get(r.id) : undefined;
    const id = (typeof r.id === 'string' && r.id.trim()) || `sub-${now.toString(36)}-${out.length + 1}`;
    const name = (typeof r.name === 'string' ? r.name.trim() : '').slice(0, 80) || old?.name || autoName(url);
    const format: SourceSubFormat = FORMATS.includes(r.format as SourceSubFormat)
      ? (r.format as SourceSubFormat)
      : 'auto';
    const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : (old?.createdAt ?? now);
    const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : (old?.updatedAt ?? 0);
    out.push({ id, name, url, format, createdAt, updatedAt });
  }
  return out;
}

export function createSourceSubsStore(dir: string): SourceSubsStore {
  const file = path.join(dir, 'source-subscriptions.json');
  const list = (): SourceSubscription[] => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      // 读取时宽松：手改坏的单条跳过，不因一条坏数据让整个入口打不开
      return normalize(raw, []).filter((s) => isHttpUrl(s.url));
    } catch {
      return [];
    }
  };
  const replace = (input: unknown): SourceSubscription[] => {
    const items = normalize(input, list());
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return items;
  };
  return { file, list, replace };
}
