/**
 * `#614` 字体反爬（`queryTTF` / `queryBase64TTF` / `replaceFont` 的纯函数部分）。
 *
 * 只有两个文件：
 *  · `ttf.ts` —— TTF 解析 + 替换算法（上游 `analyzeRule/QueryTTF.java` 的移植）；
 *  · 本文件 —— 出口。
 *
 * 为什么放在 core 而不是引擎：它是**纯字节运算**，Web 端将来要「把导出正文里的
 * 加密字先还原再写文件」也得用同一份；引擎只负责 `java.*` 面的取字节与缓存。
 */

export { parseTtf, replaceFont } from './ttf';
export type { QueryTtf } from './ttf';
