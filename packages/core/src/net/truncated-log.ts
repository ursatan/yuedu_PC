/**
 * **截断登记环**（`#152`）—— 「响应被体积护栏截断」的进程内留痕，供一次引擎请求结束后
 * 把「这次运行期间发生了几次截断、是哪些 URL」随结果回传前端。
 *
 * ## 为什么需要（用户可见层面分不开「被截断」与「返回空」）
 * 体积护栏（`YUEDU_NET_MAX_BODY_MB`）截断响应后，规则拿到的是**前半段**：
 * 表现是「目录少了一截 / 正文缺后半段 / 列表为空」，与「站点返回空 / 源失效」**看起来一模一样**。
 * 此前唯一留痕是服务端 `console.warn`（`[net-guard]` / `[syncfetch:worker]`）—— 用户看不到。
 *
 * ## 为什么是「环 + 序号」而不是计数器
 * `/api/run` 需要的是「**这次运行期间**新增的截断」，而进程里同时还有图片代理等其它请求在跑。
 * 用单调递增序号做水位（run 前记 `mark`，run 后 `takeTruncatedSince(mark)`），
 * 即使并发请求交错，也只会**多报不会漏报**（语义如实：这些截断确实发生在本次运行期间）。
 *
 * ## 只登记**文本类**截断
 * `responseType: 'arraybuffer'`（媒体）的截断已有自己的如实通路（`/api/proxy` 的
 * `Content-Range` 改写为 `bytes 0-(N-1)/*`，播放器按部分内容处理）—— 不在这里重复报，
 * 否则一张大封面就会让正文请求挂上无关的截断提示。登记点：
 * · `net/index.ts` 的 `fetchOnce`（宿主侧全部**异步文本**响应，含 worker RPC 回宿主）；
 * · `selector/js.ts` 的 `syncHttp`（L1 侧全部**同步** `java.ajax`，worker SAB 与 curl 回落）。
 */

export interface TruncatedFetch {
  /** 最终 URL（跟随重定向后） */
  url: string;
  /** 截断发生时间（本地毫秒） */
  at: number;
  /** 截断前实际收到的字节数 */
  bytes: number;
}

const MAX_ENTRIES = 200;
const log: TruncatedFetch[] = [];
let seq = 0;

/** 登记一次文本类截断（由两条传输出口调用；别在别处调） */
export function recordTruncatedFetch(url: string, bytes: number): void {
  seq += 1;
  log.push({ url, at: Date.now(), bytes });
  if (log.length > MAX_ENTRIES) log.shift();
}

/** 当前水位（调用方在运行前记下，事后传给 {@link takeTruncatedSince}） */
export function truncatedMark(): number {
  return seq;
}

/**
 * 取水位之后的截断记录。
 * @returns `list` = 截断记录（时间序）；`next` = 新水位（调用方保存供下次使用）
 */
export function takeTruncatedSince(mark: number): { list: TruncatedFetch[]; next: number } {
  // log 与 seq 同步推进 ⇒ 「seq−mark」就是环里待取的条数（环溢出时全取，宁可多报不漏报）
  const count = Math.min(log.length, Math.max(0, seq - mark));
  const list: TruncatedFetch[] = [];
  for (let i = log.length - count; i < log.length; i += 1) {
    const e = log[i];
    if (e) list.push(e);
  }
  return { list, next: seq };
}

/** 测试用：清空（生产别调） */
export function __resetTruncatedLogForTest(): void {
  log.length = 0;
  seq = 0;
}
