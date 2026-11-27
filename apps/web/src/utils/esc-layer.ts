/**
 * `#459` **Esc 层级栈** —— 「按一次 Esc 只关最上面那一层」的唯一实现。
 *
 * ## 为什么要单开一个模块
 * 阅读浮层 / 播放浮层 / 详情浮层原先各自在 `window` 上挂一个 `keydown` 监听，靠
 * `document.querySelector('.pl-mask')` / `.se-mask` **互相探测 DOM** 来让位。这条路不可扩展：
 * 每加一层就要在每个监听里补一句 `if (querySelector(…)) return`，漏一处就退化成
 * 「一次 Esc 关掉两层」（用户 2026-10-14 报的正状）。
 *
 * 这里改成**显式栈**：组件在**打开**时入栈、**关闭/卸载**时出栈；全局只挂**一个**捕获阶段的
 * `keydown`，仅把 Escape 交给栈顶那一层。
 *
 * ⚠️ 刻意**不** `stopPropagation()`：入栈的只是那三个「整屏浮层」，而它们的**子对话框**
 * （净化规则 / 高亮样式 / 加入书架 …）仍各自在 `window` 上处理 Esc。一旦拦断传播，那些子对话框
 * 的 Esc 就会失效（表现：对话框关不掉，反倒把后面的浮层关了）。交给各自的监听器处理，
 * 结果正好是「先关最里面那层」。
 *
 * 栈序 = 入栈序 = 视觉层叠序（后开的在上）。因此调用方**只需按「打开/关闭」入出栈**，
 * 不需要自己排优先级。
 */

interface EscLayer {
  close: () => void;
}

const stack: EscLayer[] = [];
let bound = false;

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // 焦点在输入框 / 可编辑区里时让给它自己（备注、搜索框等各有各的 Esc 语义）
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

/** 入栈（返回幂等的出栈函数） */
export function pushEscLayer(close: () => void): () => void {
  if (!bound) {
    bound = true;
    window.addEventListener('keydown', onKeydown, true);
  }
  const entry: EscLayer = { close };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** 当前栈深（测试/诊断用） */
export function escLayerDepth(): number {
  return stack.length;
}
