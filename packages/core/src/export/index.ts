/**
 * `#620` 书籍导出的纯函数族（核心入口）。
 *
 * 分成三个文件的原因（不是「为了拆而拆」）：
 *  · `sanitize.ts` —— 上游 `ExportContentSanitizer` 的移植，**导出链路专属**的清洗
 *    （段评图 / 不可见字符），与阅读链路的净化**语义不同**，不能混用；
 *  · `txt.ts` —— 上游 `exportTxt` + `getAllContents` + `HtmlFormatter` 的等价物；
 *  · `epub.ts` —— 自己拼 EPUB 容器（不引 epublib），只依赖 `zip-write.ts`；
 *  · `images.ts` —— `#626` 正文图片转存的纯函数（定名 / 嗅类型 / 改写 src），
 *    与 `sanitize.ts` 共用一条 `<img>` 正则（净化剔掉的图不该再被下载）。
 *
 * 这一层**零 Node 依赖**（`TextEncoder` / `Blob` / `CompressionStream` 都是两端通用的），
 * 因为导出动作在**前端**执行：替换规则（`apps/web/src/utils/replace-rules.ts`）住在 web，
 * 放服务端就要把净化语义再实现一遍 —— 那正是仓内铁律「同一判据写两处必然漂移」的禁区。
 */

export * from './sanitize';
export * from './txt';
export * from './epub';
export * from './images';
export * from './zip-write';
