/**
 * `#835` P0 回归锁：Web Speech 的「起播后立刻被自己 stop」时序。
 *
 * 用户实机四条路径（右键朗读本段 / 上句 / 下句 / 章末自动换章）都会在起播的同一拍里
 * `engine.cancel()`（或 `speechSynthesis.cancel()`），浏览器随后**异步**给旧 utterance
 * 派发 `onerror('interrupted')`。旧实现把它当成新播放出错 ⇒ `朗读出错：interrupted`。
 *
 * 这里用假 `speechSynthesis` 手动派发回调，锁住三件事：
 *  · 旧代（被 cancel / 被新 speak 顶掉）的 callbacks 一律丢弃；
 *  · `interrupted` / `canceled` 不上浮给状态机；
 *  · 其它系统错误翻成人话（不再把英文原名怼给用户）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWebSpeechEngine } from '../src/stores/read-aloud';

interface FakeUtterance {
  text: string;
  rate: number;
  voice: unknown;
  onstart?: () => void;
  onend?: () => void;
  onerror?: (e: { error: string }) => void;
  onboundary?: (e: { charIndex: number }) => void;
}

interface FakeSynth {
  getVoices: () => { voiceURI: string; name: string; lang: string }[];
  speak: (u: FakeUtterance) => void;
  cancel: () => void;
  resume: () => void;
}

/** 每个用例前重置全局替身；返回「被记录下来的 utterances」 */
function installFakeSpeech(): { spoken: FakeUtterance[]; cancels: number[]; synth: FakeSynth } {
  const spoken: FakeUtterance[] = [];
  const cancels: number[] = [];
  const synth: FakeSynth = {
    getVoices: () => [],
    speak: (u) => { spoken.push(u); },
    cancel: () => { cancels.push(cancels.length + 1); },
    resume: () => {},
  };
  (globalThis as unknown as { speechSynthesis: FakeSynth }).speechSynthesis = synth;
  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    class {
      text: string;
      rate = 1;
      voice: unknown = null;
      onstart?: () => void;
      onend?: () => void;
      onerror?: (e: { error: string }) => void;
      onboundary?: (e: { charIndex: number }) => void;
      constructor(text: string) { this.text = text; }
    };
  return { spoken, cancels, synth };
}

test('#835 上句/下句：cancel 后旧 utterance 的 interrupted 不上浮', () => {
  const { spoken } = installFakeSpeech();
  const events: string[] = [];
  const engine = createWebSpeechEngine();

  engine.speak('第一句', {
    rate: 1,
    onStart: () => events.push('start:1'),
    onEnd: () => events.push('end:1'),
    onError: (m) => events.push(`error:1:${m}`),
    onBoundary: () => {},
  });
  // 模拟「先 cancel 再 speak 下一句」
  engine.cancel();
  engine.speak('第二句', {
    rate: 1,
    onStart: () => events.push('start:2'),
    onEnd: () => events.push('end:2'),
    onError: (m) => events.push(`error:2:${m}`),
    onBoundary: () => {},
  });

  // 浏览器异步派发旧 utterance 的 interrupted（这正是用户看到的时序）
  spoken[0]!.onerror?.({ error: 'interrupted' });
  spoken[0]!.onend?.(); // 旧代的 end 也不能推进状态机
  spoken[1]!.onstart?.();

  assert.deepEqual(events, ['start:2'], '只有新一句的 onStart；旧代 end/error 全部丢弃');
});

test('#835 右键朗读本段：play → 立刻 pause → resume 的同一拍不报错', () => {
  const { spoken } = installFakeSpeech();
  const events: string[] = [];
  const engine = createWebSpeechEngine();

  // ① play() 起播第 1 句
  engine.speak('开头', {
    rate: 1,
    onStart: () => events.push('start:1'),
    onEnd: () => events.push('end:1'),
    onError: (m) => events.push(`error:1:${m}`),
    onBoundary: () => {},
  });
  // ② 同一拍 pause() → cancel()（旧实现就是这里埋雷）
  engine.cancel();
  // ③ resume() 从本段重念
  engine.speak('本段', {
    rate: 1,
    onStart: () => events.push('start:2'),
    onEnd: () => events.push('end:2'),
    onError: (m) => events.push(`error:2:${m}`),
    onBoundary: () => {},
  });

  // 旧代中断错误晚到
  spoken[0]!.onerror?.({ error: 'interrupted' });
  spoken[1]!.onstart?.();

  assert.deepEqual(events, ['start:2']);
});

test('#835 章末换章：旧章 utterance 的 end/error 不会打断新章', () => {
  const { spoken } = installFakeSpeech();
  const events: string[] = [];
  const engine = createWebSpeechEngine();

  engine.speak('末句', {
    rate: 1,
    onStart: () => events.push('start:old'),
    onEnd: () => events.push('end:old'),
    onError: (m) => events.push(`error:old:${m}`),
    onBoundary: () => {},
  });
  // 换章：旧章被 cancel，新章起播
  engine.cancel();
  engine.speak('新章首句', {
    rate: 1,
    onStart: () => events.push('start:new'),
    onEnd: () => events.push('end:new'),
    onError: (m) => events.push(`error:new:${m}`),
    onBoundary: () => {},
  });
  spoken[0]!.onerror?.({ error: 'interrupted' });
  spoken[0]!.onend?.();
  spoken[1]!.onstart?.();

  assert.deepEqual(events, ['start:new']);
});

test('#835 非中断类系统错误翻成人话（不暴露英文原名）', () => {
  const { spoken } = installFakeSpeech();
  const errors: string[] = [];
  const engine = createWebSpeechEngine();

  engine.speak('文本', {
    rate: 1,
    onStart: () => {},
    onEnd: () => {},
    onError: (m) => errors.push(m),
    onBoundary: () => {},
  });
  spoken[0]!.onerror?.({ error: 'network' });
  spoken[0]!.onerror?.({ error: 'synthesis-failed' });
  assert.match(errors[0] ?? '', /网络/);
  assert.match(errors[1] ?? '', /失败/);
  assert.doesNotMatch(errors.join('|'), /synthesis-failed|network/i);
});
