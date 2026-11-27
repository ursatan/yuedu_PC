/**
 * `#842` HTTP TTS 预取回归：
 *  · 预取命中时不再发第二次请求；
 *  · 预取失败后 `speak()` 回退串行请求，不把朗读打断；
 *  · `cancel()` 后旧代预取作废；
 *  · 起播前先停上一段，不得叠声。
 *
 * 用假的 `fetch` / `Audio` 把时序变成可判定事件，不依赖真实浏览器。
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTtsEngine } from '../src/utils/http-tts-engine';

interface CallbackSet {
  onStart: () => void;
  onBoundary: (n: number) => void;
  onEnd: () => void;
  onError: (m: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 所有假播放器共享：用来判定「上一段还在播就起下一段」= 叠声 */
class FakeAudio {
  static playing = new Set<FakeAudio>();
  static overlaps = 0;
  src = '';
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(src: string) { this.src = src; }

  play(): Promise<void> {
    if (FakeAudio.playing.size > 0) FakeAudio.overlaps += 1;
    this.paused = false;
    FakeAudio.playing.add(this);
    setTimeout(() => {
      if (FakeAudio.playing.has(this)) {
        FakeAudio.playing.delete(this);
        this.paused = true;
        this.onended?.();
      }
    }, 60);
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    FakeAudio.playing.delete(this);
  }
}

let fetchCalls: string[] = [];
let failOnce = new Set<string>();
let fetchDelayMs = 15;
const realFetch = globalThis.fetch;
const realAudio = (globalThis as { Audio?: unknown }).Audio;
const realCreate = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
const realRevoke = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;

function installMocks(): void {
  fetchCalls = [];
  failOnce = new Set();
  fetchDelayMs = 15;
  FakeAudio.playing.clear();
  FakeAudio.overlaps = 0;

  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:test';
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const text = (JSON.parse(String(init?.body ?? '{}')).text ?? '') as string;
    fetchCalls.push(text);
    await sleep(fetchDelayMs);
    if (failOnce.has(text)) {
      failOnce.delete(text);
      return new Response('boom', { status: 502, headers: { 'content-type': 'application/json' } });
    }
    return new Response(new Uint8Array([0xff, 0xf3, 1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  }) as typeof fetch;
}

function restoreMocks(): void {
  globalThis.fetch = realFetch;
  (globalThis as { Audio?: unknown }).Audio = realAudio;
  if (realCreate) (URL as unknown as { createObjectURL: typeof realCreate }).createObjectURL = realCreate;
  if (realRevoke) (URL as unknown as { revokeObjectURL: typeof realRevoke }).revokeObjectURL = realRevoke;
}

beforeEach(installMocks);
afterEach(restoreMocks);

function speakOnce(engine: ReturnType<typeof createHttpTtsEngine>, text: string): {
  ended: Promise<void>;
  error: Promise<string>;
} {
  let done!: () => void;
  let fail!: (m: string) => void;
  const ended = new Promise<void>((r) => { done = r; });
  const error = new Promise<string>((r) => { fail = r; });
  const cb: CallbackSet = {
    onStart: () => {},
    onBoundary: () => {},
    onEnd: () => done(),
    onError: (m) => fail(m),
  };
  engine.speak(text, cb);
  return { ended, error };
}

test('预取命中：同一段只发一次请求', async () => {
  const engine = createHttpTtsEngine({ engineId: 'e1', speed: () => 1 });
  engine.prefetch?.('乙');
  await sleep(25); // 让预取先完成
  assert.equal(fetchCalls.length, 1);

  const { ended } = speakOnce(engine, '乙');
  await ended;
  assert.equal(fetchCalls.length, 1, 'speak 应命中预取，不重复请求');
});

test('预取失败：speak 回退串行请求并正常念完（不报错）', async () => {
  const engine = createHttpTtsEngine({ engineId: 'e1', speed: () => 1 });
  failOnce.add('乙');
  engine.prefetch?.('乙');
  await sleep(30); // 预取失败已被内部吞掉
  let errored = '';
  const { ended, error } = speakOnce(engine, '乙');
  void error.then((m) => { errored = m; });
  await ended; // 若预取失败直接中断，这里会超时/失败
  assert.equal(fetchCalls.length, 2, '预取失败后应重新请求一次');
  assert.equal(errored, '', '预取失败不能上报成朗读错误');
});

test('cancel 后旧代预取作废：下一段不会误用旧结果', async () => {
  const engine = createHttpTtsEngine({ engineId: 'e1', speed: () => 1 });
  engine.prefetch?.('乙');
  await sleep(5);
  engine.cancel();
  const { ended } = speakOnce(engine, '乙');
  await ended;
  assert.equal(fetchCalls.length, 2, '取消后必须重新请求，不能命中旧预取');
});

test('起播前先停上一段：不叠声', async () => {
  const engine = createHttpTtsEngine({ engineId: 'e1', speed: () => 1 });
  speakOnce(engine, '甲'); // 甲被乙打断后不会触发 onEnd（不是「念完」），只等乙
  await sleep(35); // 甲已在播
  const b = speakOnce(engine, '乙');
  await b.ended;
  assert.equal(FakeAudio.overlaps, 0, '每次 play 时上一段必须已暂停');
});
