/**
 * **只留痕一次** 的 `console.warn`（全仓唯一实现）。
 *
 * 为什么要有它（铁律 3「兜底必须留痕」）：静默兜底是「反复出现形同问题」的温床 ——
 * 出问题的人看不到任何线索，只能靠猜。但**同类问题反复刷日志又会淹掉真正要紧的那条**
 * ⇒ 按 `key` 去重，每个 key 只在**首次**发生时留痕。
 *
 * ⚠️ 原先这份实现是 `utils/chinese-convert.ts` 里的**私有函数**（2026-09-30 抽出共用），
 * 新增代码一律 import 这里，**不要再各自写一份**（两份 `Set` 会让「只留一次」的语义失效）。
 */
const warned = new Set<string>();

export function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** 测试用：清空去重表（否则单测之间会互相吞掉留痕） */
export function resetWarnOnce(): void {
  warned.clear();
}
