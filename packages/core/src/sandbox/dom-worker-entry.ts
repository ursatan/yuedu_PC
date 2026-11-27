/**
 * `#743` A 轮：DOM 后端 worker 入口（常驻线程）。
 *
 * 职责很小：`{ client, args }` → `handleDomCall(JsoupDom, args)` → 回包。
 * `client` 对应宿主的一个求值器（一个源）；**一个 client 一份 `JsoupDom` 活节点表**，
 * 因此 `parse` 返回的 `nid` 在该 client 的所有后续 op 里都有效（`#333` 语义不变）。
 *
 * 内存：`JsoupDom` 自身 `CAP=4096` 节点（按插入序淘汰），一个 client 上限几 MB；
 * 这里再按 **client 数**做 LRU 上限（默认 24，`YUEDU_DOM_CLIENTS` 可调），
 * 淘汰最久未用的 client —— 求值是按请求成对出现的，老 client 的树早已是垃圾。
 *
 * 兼容：开发/测试时本文件由 tsx 直接以 `.ts` 作为 Worker 入口；桌面版由
 * `build-server.mjs` 打包成同目录的 `dom-worker.mjs`（jsdom 一起打进去）。
 */
import { parentPort } from 'node:worker_threads';
import { JsoupDom } from '../selector/jsoup-dom';
import { handleDomCall } from '../selector/dom-rpc';

const MAX_CLIENTS = Math.max(2, Number(process.env['YUEDU_DOM_CLIENTS'] ?? 24) || 24);
const clients = new Map<number, JsoupDom>();

/** 取（或建）client 的活节点表；Map 插入序即 LRU 序。 */
function clientDom(client: number): JsoupDom {
  let dom = clients.get(client);
  if (dom) {
    // touch → 移到队尾
    clients.delete(client);
    clients.set(client, dom);
    return dom;
  }
  if (clients.size >= MAX_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest !== undefined) clients.delete(oldest);
  }
  dom = new JsoupDom();
  clients.set(client, dom);
  return dom;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  ms?: number;
}

if (parentPort) {
  parentPort.on('message', (msg: { id: number; client: number; args?: unknown }) => {
    const t0 = Date.now();
    let reply: WorkerReply;
    try {
      /**
       * `#754` 启动预热：`ping` 只验证「线程已起、模块（jsdom）已装载」，**不建 `JsoupDom`** ——
       * 预热的槽位随后会由真实求值器复用，不能提前给 `client=-1` 留一份空文档。
       */
      const op = (msg.args as { op?: string } | null | undefined)?.op;
      const result = op === 'ping' ? true : handleDomCall(clientDom(msg.client), msg.args, false);
      reply = { id: msg.id, ok: true, result, ms: Date.now() - t0 };
    } catch (e) {
      reply = { id: msg.id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 400), ms: Date.now() - t0 };
    }
    parentPort!.postMessage(reply);
  });
}
