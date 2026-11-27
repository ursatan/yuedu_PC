/**
 * 本地书的**服务端主键**（`#202` 第一条不变量）—— 全仓**唯一**算法。
 *
 * ## 为什么单独一个文件（而不是在用到的地方各写一行）
 * `#202` 的四条不变量里，第一条代价最大：
 * > `bookUrl` 由前端算，且必须与 `contractToShelfBook()` 读回时算出的 key **完全对称** ——
 * > 否则本地书被判成「不在书架」，续读进度 / 书签 / 高亮全部丢失（**症状最像「功能没做」**）。
 *
 * 这个式子原先只在 `ShelfView.vue` 里（「导入本地书」按钮），`#209` 的**双击打开**也要用它。
 * 抄第二份 = 「同一判据被写侧/读侧各写一遍必然漂移」的经典入口 —— 迟早会出现
 * 「点按钮导入的书在书架里，双击导入的不在」这种极难定位的差别。
 * 所以抽到这里：`ShelfView.vue` 与 `desktop.ts` 都从这儿取。
 *
 * ## 三层各是什么
 * · `itemKey(sourceId, payload)` —— 本仓的条目唯一标识（`sourceId\0id`，见 `stores/reader.ts`）；
 * · `encodeItemKey()` —— 把里面的 `\u0000` 转义掉（SQLite 读写回会截断，见 `utils/user-map.ts`）；
 * · `localBookPayload(fileName)` —— 本地书的 payload 就是 `{ fileName }`（契约层定义）。
 *
 * ## `#212` Step3：算法已下沉到契约层
 * 压缩包批量导入在**服务端**进行，而服务端拿不到前端这三个函数 ⇒ 把整个式子落成
 * `@yuedu/core/contract` 的 `localBookUrlOf()`，**本函数改为委派**（对外签名不变）。
 * 否则「单本导入」与「压缩包导入」会算出两个不同的主键 —— 正是这份文件头警告过的漂移。
 */
import { localBookUrlOf as coreLocalBookUrlOf } from '@yuedu/core/contract';

/**
 * 由**文件名**算本地书主键。
 *
 * ⚠️ 传入的必须是**原始文件名**（如 `三体.txt`），不是路径 ——
 * 服务端 `safeLocalBookName()` 会 `path.basename` 一次，前端这里也要与它对齐，
 * 否则「路径形态」与「文件名形态」会算出两个不同的主键。
 */
export function localBookUrlOf(fileName: string): string {
  return coreLocalBookUrlOf(fileName);
}
