/**
 * `read_records.author` 的多作者聚合（照抄 Legado `ReadRecordAuthors`，`ReadRecord.kt:24-59`）。
 *
 * ## 为什么要编码
 * Legado 的 `readRecord` 主键是 `(deviceId, bookName)` —— **按书名聚合，不按 bookUrl**（D2 决策）。
 * 于是「同名不同作者」的书会产生多条记录，DAO 聚合展示时需要把多个作者值合并。
 * 源码里的做法是：**复用 `author` 列**，单个作者存纯文本（兼容旧记录），
 * 多个作者存 `\u001Eauthors:[...]` 前缀 + JSON 数组；跨行聚合时用 `\u001F` 分隔后再解码去重。
 *
 * 这两个魔数必须原样照抄，否则导出的数据与 Legado 备份不互通。
 */

/** 多作者编码前缀（Legado 原样） */
export const AUTHORS_PREFIX = '\u001Eauthors:';
/** DAO 聚合多行时用的分隔符（Legado `AGGREGATE_SEPARATOR`） */
export const AGGREGATE_SEPARATOR = '\u001F';

/** 作者列 → 作者数组（`ReadRecordAuthors.decode`）。空值解码为 `['']`，与 Legado 一致 */
export function decodeAuthors(value: string): string[] {
  if (value === '') return [''];
  if (!value.startsWith(AUTHORS_PREFIX)) return [value];
  try {
    const arr = JSON.parse(value.slice(AUTHORS_PREFIX.length)) as unknown;
    if (!Array.isArray(arr)) return [''];
    const out = [...new Set(arr.filter((x): x is string => typeof x === 'string' && x !== ''))];
    return out.length ? out : [''];
  } catch {
    return [''];
  }
}

/** 合并作者集合（`ReadRecordAuthors.merge`）：0 个 → `''`、1 个 → 原样、多个 → 前缀 + JSON 数组 */
export function mergeAuthors(current: string, incoming: string): string {
  const set = new Set<string>();
  for (const a of decodeAuthors(current)) if (a !== '') set.add(a);
  for (const part of incoming.split(AGGREGATE_SEPARATOR)) {
    for (const a of decodeAuthors(part)) if (a !== '') set.add(a);
  }
  if (set.size === 0) return '';
  if (set.size === 1) return [...set][0]!;
  return AUTHORS_PREFIX + JSON.stringify([...set].sort());
}

/** 展示用作者串（`ReadRecordAuthors.display`：聚合 → 去重 → 排序 → 顿号连接） */
export function displayAuthors(value: string): string {
  if (value === '') return '';
  const out = new Set<string>();
  for (const part of value.split(AGGREGATE_SEPARATOR)) {
    for (const a of decodeAuthors(part)) if (a !== '') out.add(a);
  }
  return [...out].sort().join('、');
}
