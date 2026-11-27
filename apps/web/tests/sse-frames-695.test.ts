/**
 * `#695` SSE 帧解析（`readSse`）—— 全链试跑流式化用到它。
 *
 * 为什么要单测：帧解析有三个必踩的边界，出错时表现为「时间轴少一段 / 卡在最后一段」，
 * 而服务端日志看起来一切正常（frame 都 write 出去了）。
 *  ① 一次 `read()` 可能带**多帧**；
 *  ② 一个帧可能被**切开**（`\n\n` 落在两个 chunk 之间）；
 *  ③ 没有 `data:` 的心跳/空帧要跳过，不能当成空对象往界面上塞。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSse } from '../src/api';

/** 把若干片段拼成一个 Response（模拟服务端一次 write 一片） */
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('#695 readSse ① 一帧多段 data 拼起来；多帧按顺序回调', async () => {
  const res = sseResponse([
    'event: stage\ndata: {"stage":"search","ok":true,"ms":12}\n\n',
    'event: stage\ndata: {"stage":"info","ok":true}\n\n',
    'event: done\ndata: {"ok":true,"respondTime":34}\n\n',
  ]);
  const got: Array<[string, Record<string, unknown>]> = [];
  await readSse(res, (e, d) => got.push([e, d]));
  assert.deepEqual(got.map((x) => x[0]), ['stage', 'stage', 'done']);
  assert.equal(got[0]![1]['stage'], 'search');
  assert.equal(got[0]![1]['ms'], 12);
  assert.equal(got[2]![1]['respondTime'], 34);
});

test('#695 readSse ② 帧被切开（\\n\\n 跨 chunk、data 半截）也要拼回完整帧', async () => {
  const res = sseResponse([
    'event: stage\ndata: {"stage":"sea',
    'rch","ok":true,"ms":7}\n',
    '\nevent: done\ndata: {"ok":tru',
    'e}\n\n',
  ]);
  const got: Array<[string, Record<string, unknown>]> = [];
  await readSse(res, (e, d) => got.push([e, d]));
  assert.equal(got.length, 2, '两个帧不能因为被切开而丢一个');
  assert.deepEqual(got[0]![1], { stage: 'search', ok: true, ms: 7 });
  assert.equal(got[1]![1]['ok'], true);
});

test('#695 readSse ③ 没有 data 的帧（心跳/空帧）跳过，不回调', async () => {
  const res = sseResponse(['event: ping\n\n', 'event: stage\ndata: {"stage":"toc","ok":true}\n\n']);
  const events: string[] = [];
  await readSse(res, (e) => events.push(e));
  assert.deepEqual(events, ['stage'], 'ping 帧没有 data，不该产生事件');
});

test('#695 readSse ④ 多字节中文被 chunk 边界劈开也不乱码（TextDecoder stream 模式）', async () => {
  const enc = new TextEncoder();
  const whole = enc.encode('event: stage\ndata: {"detail":"目录 1279 章"}\n\n');
  // 故意在 UTF-8 多字节中间切
  const cut = Math.floor(whole.length / 2);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(whole.slice(0, cut));
      c.enqueue(whole.slice(cut));
      c.close();
    },
  });
  let detail = '';
  await readSse(new Response(body), (_e, d) => {
    detail = String(d['detail'] ?? '');
  });
  assert.equal(detail, '目录 1279 章');
});
