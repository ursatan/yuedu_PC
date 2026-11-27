/**
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * 浮条渲染脚本（仅 Electron）：同一扇窗的两种形态。
 * · `lyrics`：朗读当前句（既有行为，参考 byl669/legado-lyrics-overlay，GPL-3.0）；
 * · `reading`：小窗·条形档的阅读正文流（不朗读，当前行大字 + 前后行小字 + 向上滚动）。
 *
 * 滚动实现：视口只露 3 行（上/当前/下），轨道多放 1 行；每推进一行把轨道
 * translateY(-25%) 做一次动画，动画结束后把轨道数据整体前移一格并复位 —— 观感连续。
 */
(() => {
  const el = {
    title: document.getElementById('flTitle'),
    prev: document.getElementById('flPrev'),
    read: document.getElementById('flRead'),
    unread: document.getElementById('flUnread'),
    next: document.getElementById('flNext'),
    toggle: document.getElementById('flToggle'),
    track: document.getElementById('barTrack'),
    speedLabel: document.getElementById('barSpeedLabel'),
    ignoreBtn: document.getElementById('barIgnoreBtn'),
    dock: document.querySelector('[data-dock]'),
    settings: document.querySelector('[data-settings]'),
    toc: document.querySelector('[data-toc]'),
    tocList: document.getElementById('tocList'),
    opacity: document.getElementById('flOpacity'),
    opacityVal: document.getElementById('flOpacityVal'),
    rdBody: document.getElementById('rdBody'),
    rdTitle: document.getElementById('rdTitle'),
    rdCount: document.getElementById('rdCount'),
  };

  /**
   * 色表由主进程下发（与 Web 共用 `float-geometry.json`），这里不再自带一份十六进制表。
   * `''` = 跟随主题：桌面映射为各自的默认色（窗口没有页面主题可跟随）。
   */
  const DEFAULT_TEXT_COLOR = '#F2F2F2';
  const DEFAULT_BG_COLOR = '#0C0E12';
  const FONT_MIN = 14;
  const FONT_MAX = 40;
  /** 条形推进动画：位移与字号变化共用一条 280ms 时间轴（与 Web PiP 同值） */
  const BAR_ANIM_MS = 280;

  let mode = 'lyrics';
  /** 条形轨道当前行文本（标题行在第一个；正文由段落按窗宽现切） */
  let lines = [];
  let index = 0;
  let speedMs = 2600;
  let clickThrough = true;
  let lastReadingStamp = 0;
  let timer = null;
  let animating = false;
  /* ---- 条形：段落缓存 / 折行宽度 / 标题 / 自动窗高 / 章末推进 ---- */
  let barParagraphs = [];
  let barLegacyLines = [];
  let barTitle = '';
  let barWidth = 0;
  let barFs = 0;
  let barTitleFirst = false;
  /** 条形态是否显示前后句：与歌词态共用 `floatShowNeighbors`（关掉只留当前行） */
  let barNeighbors = true;
  let barBodyEmpty = true;
  let barAdvanceRequested = false;
  let lastBarFitH = 0;
  let barResizeRaf = 0;
  /** 重建代次：动画中途换章/换宽时，旧动画的收尾不能再推进 index */
  let barGen = 0;
  /** 最近一次主进程下发的外观偏好（设置面板 & 拖动锁定都读它） */
  let prefsCache = null;
  /** 设置面板是否敞着（敞着时主进程已临时加高，别再按正文高度缩回去） */
  let settingsOpen = false;
  /** 工具条是否浮现（常规/条形只认顶部 48px 热区；歌词态整窗） */
  let dockOn = false;
  /** 目录浮层状态与已渲染的目录 key（避免每次 update 重建列表） */
  let tocOpen = false;
  let tocKey = '';
  /** 最近一份正文载荷里的目录/当前章（目录按钮随时可开） */
  let tocChapters = [];
  let tocIndex = -1;
  /** 上次上报的内容高度：同高不重复发 IPC（尺寸由主进程一次设到位） */
  let lastFitH = 0;
  /** 上次应用的字号：字号一变，窗口高度可能被主进程改过 ⇒ 去重基准要清掉 */
  let lastFitFs = 0;
  /** 色块只建一次（色表来自主进程，第一次 payload 到达后才建） */
  let swatchesBuilt = false;
  /* ---- 歌词进度：边界做锚点 + 按语速时间外推 ---- */
  let lastCurrent = '';
  let lastPlaying = false;
  let lastInnerPos = 0;
  const prog = { chars: 0, pos: 0, at: 0, lastInner: 0, rate: 0.005, timer: null };

  /** `#RRGGBB` + alpha → `rgba(...)`；非法值退回默认底色（透明度只作用于背景） */
  function bgRgba(hex, alpha) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    const a = Math.min(1, Math.max(0, Number(alpha)));
    if (!m) return `rgba(12, 14, 18, ${Number.isFinite(a) ? a : 0.72})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Number.isFinite(a) ? a : 0.72})`;
  }

  function setText(node, text, show) {
    node.textContent = show ? text : '';
    node.style.display = show ? '' : 'none';
  }

  /**
   * 按**真实内容高度**请求主进程调整歌词窗（长句换行后行数会变）。
   * 只量可见行的 offsetHeight，不依赖 scrollHeight —— 后者不会比当前窗口矮，
   * 内容变少时窗口永远缩不回去。窗口宽度不变 ⇒ 换行结果稳定，不会来回跳。
   *
   * ★ 必须**同步**量、一次到位：早先放在 requestAnimationFrame 里，窗口还偏矮时
   *   flex 会把行压扁（`.fl-line` 现在已 `flex:0 0 auto`，兜住这一点），
   *   逐帧量到的只是「比现在高一点点」⇒ 窗高像动画一样慢慢涨。
   *   这里量完即设，并记 `lastFitH` 去重，同高不重复发 IPC。
   */
  function requestFitHeight() {
    if (mode !== 'lyrics' || settingsOpen) return;
    const cur = document.getElementById('flCur');
    const vis = [el.title, el.prev, cur, el.next].filter((node) => node && node.style.display !== 'none');
    let h = 10 + 8 + 2; // .fl-card 上下 padding（10/8）+ 亚像素取整余量
    if (vis.length > 1) h += (vis.length - 1) * 2; // flex gap: 2px
    for (const node of vis) h += node.offsetHeight;
    const target = Math.ceil(h);
    if (target === lastFitH) return;
    lastFitH = target;
    window.yueduLyrics.fitHeight(target);
  }

  /** `#RRGGBB` + alpha → `rgba(...)`；非法值退回当前文字色默认值（只用于前后句的「同色系降透明」） */
  function textRgba(hex, alpha) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    const a = Math.min(1, Math.max(0, Number(alpha)));
    if (!m) return `rgba(242, 242, 242, ${Number.isFinite(a) ? a : 0.55})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Number.isFinite(a) ? a : 0.55})`;
  }

  /* ------------------------------------------------------------------ *
   * 外观（两种形态共用）
   * ------------------------------------------------------------------ */
  function applyAppearance(prefs) {
    if (!prefs) return;
    prefsCache = prefs;
    const root = document.documentElement;
    root.style.setProperty('--float-bg-opacity', String(prefs.bgOpacity));
    root.style.setProperty('--float-bg-rgba', bgRgba(prefs.bgColor, prefs.bgOpacity));
    /* ★ 字号/行高一律整数像素：小数会让 Chromium 走次像素排版（22px 字配 20px 行高那种发虚）。
       这里算好四个角色（当前 / 前后句 / 常规正文 / 条形）的字号与行高，只落在对应行上。 */
    const fs = Math.round(Number(prefs.fontSize) || 22);
    // 字号变了 ⇒ 主进程可能已按静态估算改过窗高，去重基准作废，强制重报一次
    if (fs !== lastFitFs) {
      lastFitFs = fs;
      lastFitH = 0;
      lastBarFitH = 0;
      // 面板敞着改字号：面板自身高度也会变 ⇒ 重新量一次并上报，主进程按实测加高
      if (settingsOpen) {
        requestAnimationFrame(() => {
          refreshPanelHeight();
          window.yueduLyrics.panel(true, el.settings ? Math.ceil(el.settings.offsetHeight) : 0);
        });
      }
    }
    const adj = Math.max(12, fs - 6);
    const read = Math.max(13, Math.round(fs * 0.72));
    const bar = Math.max(13, Math.round(fs * 0.66));
    root.style.setProperty('--float-font-size', `${fs}px`);
    root.style.setProperty('--fl-fs-cur', `${fs}px`);
    root.style.setProperty('--fl-fs-adj', `${adj}px`);
    root.style.setProperty('--fl-fs-read', `${read}px`);
    root.style.setProperty('--fl-fs-bar', `${bar}px`);
    root.style.setProperty('--fl-lh-cur', `${Math.round(fs * 1.35)}px`);
    root.style.setProperty('--fl-lh-adj', `${Math.round(adj * 1.35)}px`);
    root.style.setProperty('--fl-lh-read', `${Math.round(read * 1.72)}px`);
    root.style.setProperty('--fl-lh-bar', `${Math.round(bar * 1.3)}px`);
    root.style.setProperty('--float-text', prefs.textColor);
    // 强调色是壳内设计令牌（`--float-accent`，写在 :root），不再作为可调偏好下发
    // 前后句颜色 = 当前文字色的同色系降透明度（改文字色时跟着变，不再写死深灰）
    root.style.setProperty('--float-dim', textRgba(prefs.textColor, 0.55));
    // ★ transform 与字号变化共用这一条时长/曲线：推进时同帧起、同帧落（对齐 Web PiP 的 280ms）
    root.style.setProperty('--bar-anim-ms', `${BAR_ANIM_MS}ms`);
    renderSettings(prefs);
  }

  function colorOf(kind, value) {
    const hex = String(value || '');
    if (/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    return kind === 'text' ? DEFAULT_TEXT_COLOR : DEFAULT_BG_COLOR;
  }

  /** 设置面板：把当前偏好回填到控件（色块选中态 / 自定义取色 / 透明度 / 锁定态） */
  function renderSettings(prefs) {
    if (!prefs) return;
    document.body.classList.toggle('fl-locked', prefs.dragLocked === true);
    if (el.opacity) el.opacity.value = String(prefs.bgOpacity);
    if (el.opacityVal) el.opacityVal.textContent = `${Math.round(Number(prefs.bgOpacity) * 100)}%`;
    const palette = prefs.palette && Array.isArray(prefs.palette.text) ? prefs.palette : null;
    if (palette && !swatchesBuilt && palette.text.length && Array.isArray(palette.bg) && palette.bg.length) {
      buildSwatches(palette);
      swatchesBuilt = true;
    }
    markSwatch('text', prefs.textColor);
    markSwatch('bg', prefs.bgColor);
    syncPicker('text', prefs.textColor);
    syncPicker('bg', prefs.bgColor);
  }

  function markSwatch(kind, value) {
    const box = document.querySelector(`[data-swatches="${kind}"]`);
    if (!box) return;
    const raw = String(value || '');
    box.querySelectorAll('button').forEach((b) => {
      const v = String(b.dataset.color || '');
      // 空串 = 「跟随主题」：只有存储值也是空串时才算选中（桌面一般存具体 hex）
      b.classList.toggle('sel', raw ? v.toLowerCase() === raw.toLowerCase() : v === '');
    });
  }

  function syncPicker(kind, value) {
    const input = document.querySelector(`[data-picker="${kind}"]`);
    if (input) input.value = colorOf(kind, value).toLowerCase();
  }

  /** 色块按钮只在第一次收到色表时构建；点击即落盘（与设置页同一份 prefs） */
  function buildSwatches(palette) {
    for (const [kind, colors, key] of [
      ['text', palette.text, 'floatTextColor'],
      ['bg', palette.bg, 'floatBgColor'],
    ]) {
      const box = document.querySelector(`[data-swatches="${kind}"]`);
      if (!box) continue;
      box.textContent = '';
      for (const item of colors) {
        const color = String(item && item.v ? item.v : '');
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.color = color;
        b.title = (item && item.label) || color || '跟随主题';
        if (color) {
          b.style.background = color;
        } else {
          b.classList.add('fl-sw-default');
        }
        b.addEventListener('click', () => {
          // 桌面没有页面主题可跟随 ⇒ 「跟随主题」落到各自的默认色
          window.yueduLyrics.setPrefs({ [key]: color || colorOf(kind, '') });
        });
        box.appendChild(b);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 设置浮层：三态共用一份 DOM；打开时正文让位，Esc / 点空白关闭
   * ------------------------------------------------------------------ */
  function refreshPanelHeight() {
    const root = document.documentElement;
    const h = settingsOpen && el.settings ? Math.ceil(el.settings.offsetHeight) : 0;
    if (h > 0) root.style.setProperty('--fl-panelh', `${h}px`);
    else root.style.removeProperty('--fl-panelh');
  }

  function setPanelOpen(open) {
    const on = open === true;
    settingsOpen = on;
    if (el.settings) el.settings.classList.toggle('on', on);
    document.body.classList.toggle('fl-panel-on', on);
    // 面板高度是渲染结果（换行会变）⇒ 打开后量一次，正文按它让位；
    // 主进程再按同一高度把窗加高（面板落在窗内、底边不动），不会「拼在窗口外面」。
    refreshPanelHeight();
    window.yueduLyrics.panel(on, settingsOpen && el.settings ? Math.ceil(el.settings.offsetHeight) : 0);
    if (on) return;
    // 关掉面板：主进程已把窗缩回正文高度 ⇒ 去重基准作废，按当前内容重报一次
    lastFitH = 0;
    lastBarFitH = 0;
    requestFitHeight();
    requestBarFitHeight();
  }

  function patchPrefs(patch) {
    window.yueduLyrics.setPrefs(patch);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (tocOpen) {
      e.preventDefault();
      setTocOpen(false);
      return;
    }
    if (!settingsOpen) return;
    e.preventDefault();
    setPanelOpen(false);
  }, true);

  // 点空白关闭：点在面板/目录外、也不是对应开关本身（开关自己负责 toggle）
  document.addEventListener('pointerdown', (e) => {
    if (!settingsOpen && !tocOpen) return;
    const t = e.target;
    if (t && t.closest && t.closest('[data-tool="toc"]')) return;
    if (settingsOpen && t && t.closest && (t.closest('.fl-settings') || t.closest('[data-act="settings"]'))) return;
    if (tocOpen && t && t.closest && t.closest('.fl-toc')) return;
    if (settingsOpen) setPanelOpen(false);
    if (tocOpen) setTocOpen(false);
  }, true);

  // 自定义取色：原生取色器需要窗口可聚焦（这个浮窗平时 focusable:false）
  document.querySelectorAll('[data-picker]').forEach((input) => {
    const kind = input.dataset.picker;
    const key = kind === 'text' ? 'floatTextColor' : 'floatBgColor';
    input.addEventListener('pointerdown', () => {
      if (typeof window.yueduLyrics.focusable === 'function') window.yueduLyrics.focusable(true);
    });
    input.addEventListener('input', () => patchPrefs({ [key]: input.value }));
    const done = () => {
      if (typeof window.yueduLyrics.focusable === 'function') window.yueduLyrics.focusable(false);
    };
    input.addEventListener('change', done);
    input.addEventListener('blur', done);
  });

  /* ------------------------------------------------------------------ *
   * 歌词形态（保持原行为）
   * ------------------------------------------------------------------ */
  function paintRead(chars) {
    const cur = lastCurrent || '';
    const pos = Math.max(0, Math.min(cur.length, Math.round(Number(chars) || 0)));
    el.read.textContent = cur.slice(0, pos);
    el.unread.textContent = cur.slice(pos);
  }

  function stopProgress() {
    if (prog.timer) { clearInterval(prog.timer); prog.timer = null; }
  }

  /**
   * 已读色推进：`onboundary` 报的是**当前词起点**，直接用它上色会永远落后一个词。
   * 这里以边界为锚点、按校准出的语速做时间外推；边界落后于已推进位置时不回拨。
   */
  function startProgress() {
    if (prog.timer) return;
    prog.timer = setInterval(() => {
      if (mode !== 'lyrics' || !lastPlaying) return;
      const len = (lastCurrent || '').length;
      if (!len) return;
      const est = prog.pos + (performance.now() - prog.at) * prog.rate;
      // max(边界, 外推) ⇒ 边界落后时不倒退；永不越过当前句长度
      const next = Math.min(len, Math.max(lastInnerPos, est));
      if (next - prog.chars < 1) return;
      prog.chars = next;
      paintRead(prog.chars);
    }, 60);
  }

  function onBoundary(pos) {
    const now = performance.now();
    if (!prog.at) prog.at = now;
    const dt = now - prog.at;
    if (pos > prog.pos && dt > 40) {
      const r2 = (pos - prog.pos) / dt;
      // 只在合理区间内采信（防止暂停/跳句把语速带飞）
      if (r2 > 0.0002 && r2 < 0.05) prog.rate = prog.rate * 0.6 + r2 * 0.4;
    }
    // 边界落后时不回拨：只在新锚点不落后于已推进位置时校准
    if (pos >= prog.chars) {
      prog.pos = pos;
      prog.at = now;
      prog.chars = pos;
    }
    paintRead(prog.chars);
  }

  function renderLyrics(payload) {
    const { state, prefs } = payload;
    if (!state || !prefs) return;

    const showNeighbors = prefs.showNeighbors === true;
    setText(el.prev, state.prev || '', showNeighbors && !!state.prev);
    setText(el.next, state.next || '', showNeighbors && !!state.next);
    // 章节标题行：朗读到「章首且还没进第一句」时显示（与 Web PiP 歌词的标题行同位置）
    const title = String(payload.reading?.chapterTitle || '');
    const atStart = Number(state.index) === 0 && Number(state.innerPos) === 0 && !state.prev;
    setText(el.title, title, atStart && !!title);

    const current = state.current || '';
    const innerPos = Math.max(0, Math.min(current.length, Number(state.innerPos) || 0));
    const playing = state.playing === true;
    const changed = current !== lastCurrent;
    const resumed = playing && !lastPlaying;
    lastCurrent = current;
    lastInnerPos = innerPos;
    lastPlaying = playing;

    if (changed) {
      prog.pos = innerPos;
      prog.at = performance.now();
      prog.chars = innerPos;
      prog.lastInner = innerPos;
      paintRead(prog.chars);
    } else if (innerPos !== prog.lastInner) {
      prog.lastInner = innerPos;
      onBoundary(innerPos);
    } else if (resumed) {
      // 暂停后继续：从当前已推进位置重新起表，避免按暂停时长一口气跳到句尾
      prog.pos = prog.chars;
      prog.at = performance.now();
    }
    if (playing) startProgress();
    else stopProgress();

    el.toggle.innerHTML = state.playing
      ? '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    el.toggle.title = state.playing ? '暂停' : '继续';

    // 长句换行后行数会变 ⇒ 让主进程按真实内容高度调整窗口（多行完整可见，不截断）
    requestFitHeight();
  }

  /* ------------------------------------------------------------------ *
   * 条形档（阅读正文流）
   * ------------------------------------------------------------------ */
  const SPEED_LABEL = { 1: '慢', 2: '中', 3: '快' };
  const BAR_GAP = 2;
  const BAR_BREAK_CHARS = '，。！？；：、,.!?;:)]}」』”’ ';

  let measureCtx = null;
  function measureWidth(text, px) {
    if (!measureCtx) {
      try { measureCtx = document.createElement('canvas').getContext('2d'); } catch { measureCtx = null; }
    }
    if (!measureCtx) return String(text).length * px;
    measureCtx.font = `650 ${px}px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
    return measureCtx.measureText(String(text)).width;
  }

  /** 与 Web PiP `reader-float-shared.splitParagraphs` 同一套算法：按真实窗宽折行 */
  function splitParagraphs(paragraphs, maxW, px) {
    const src = paragraphs.filter((s) => s && String(s).trim()).join(' ');
    if (!src) return [];
    const out = [];
    let from = 0;
    while (from < src.length) {
      let width = 0;
      let i = from;
      let lastBreak = -1;
      for (; i < src.length; i += 1) {
        const w = measureWidth(src[i], px);
        if (width + w > maxW && i > from) break;
        width += w;
        if (BAR_BREAK_CHARS.includes(src[i])) lastBreak = i;
      }
      if (i < src.length && lastBreak >= from && i - lastBreak <= Math.ceil((i - from) / 3)) i = lastBreak + 1;
      const text = src.slice(from, i);
      if (text) out.push(text);
      from = i;
      while (from < src.length && src[from] === ' ') from += 1;
    }
    return out;
  }

  function barBasePx() {
    const fs = Math.round(Number(prefsCache?.fontSize) || 22);
    return Math.max(13, Math.round(fs * 0.66));
  }

  function rebuildBarLines(maxW, px) {
    let next = [];
    if (barParagraphs.length) next = splitParagraphs(barParagraphs, maxW, px);
    else if (barLegacyLines.length) next = barLegacyLines.slice();
    barBodyEmpty = next.length === 0;
    if (barTitle) next.unshift(barTitle);
    barTitleFirst = !!barTitle;
    lines = next;
  }

  function rowText(i) {
    if (!lines.length) return i === index ? '（正文加载中…）' : '';
    return lines[i] || '';
  }

  function rowIsTitle(i) {
    return barTitleFirst && i === 0;
  }

  /** 可见行数：显示前后句 = 3（前 / 当前 / 后）；关掉只留当前行（与歌词态同语义） */
  function barVisibleCount() {
    return barNeighbors ? 3 : 1;
  }

  /**
   * 可见行的「角色标称行高」：当前行按字号算，前后句按条形态小字号算（与 Web PiP 同口径）。
   * 章首/章末的空占位行也需要一个非零高度，否则视口会在章首缩一下、推进时又涨回去。
   */
  function barRoleHeights() {
    const fs = Math.round(Number(prefsCache?.fontSize) || 22);
    const adj = Math.round(barBasePx() * 1.3);
    return barNeighbors ? [adj, Math.round(fs * 1.35), adj] : [Math.round(fs * 1.35)];
  }

  /**
   * 视口高度 = 可见行「角色标称高度」与「实测高度」的较大者之和。
   * ★ 这两处（写 `--bar-view-h` 的视口、上报窗高的 fitHeight）必须用**同一套算法**：
   *   早先视口量实测、窗高按角色标称，章首空占位行高度为 0 ⇒ 视口 54 而窗高 86，
   *   既留 20px 空白，首行推进时标题还会上跳。
   */
  function barViewHeight() {
    const track = el.track;
    if (!track) return 0;
    const rows = Array.from(track.children).slice(0, barVisibleCount());
    const roles = barRoleHeights();
    let h = 0;
    rows.forEach((row, i) => {
      h += Math.max(roles[i] || 0, row.offsetHeight);
      if (i) h += BAR_GAP;
    });
    return Math.ceil(h);
  }

  /**
   * 把视口固定成恰好三行（关掉前后句时一行）。
   * ★ 窗高有下限（主进程还会按屏幕夹取）⇒ 窗口比内容高时只留白，
   *   绝不能把视口撑到 100%：那样会多露出下一行的半截，看起来就是「4 行」。
   */
  function syncBarViewHeight() {
    document.documentElement.style.setProperty('--bar-view-h', `${Math.max(1, barViewHeight())}px`);
  }

  /** 轨道 = [index-1, index, index+1, index+2]；视口只露前 3 行（关掉前后句时只放当前行） */
  function renderRows() {
    const track = el.track;
    if (!track) return;
    track.classList.remove('slide');
    track.innerHTML = '';
    const offsets = barNeighbors ? [-1, 0, 1, 2] : [0];
    for (const off of offsets) {
      const i = index + off;
      const row = document.createElement('div');
      row.className = 'bar-row' + (off === 0 ? ' is-cur' : '') + (rowIsTitle(i) ? ' is-title' : '');
      row.textContent = rowText(i);
      track.appendChild(row);
    }
    // 空章时不滚动
    track.classList.toggle('bar-empty-track', !lines.length);
    syncBarViewHeight();
    centerBar();
    requestBarFitHeight();
  }

  /** 以第 rowIdx 行为中心换算 translateY（与 Web PiP `centerTarget` 同一口径：内容比视口矮时整体居中且不越界） */
  function centerTarget(rowIdx) {
    const track = el.track;
    const view = track && track.parentElement;
    const row = track && track.children[rowIdx];
    if (!track || !view || !row) return 0;
    const viewH = view.clientHeight;
    const trackH = track.offsetHeight;
    const t = viewH / 2 - (row.offsetTop + row.offsetHeight / 2);
    const lo = Math.min(0, viewH - trackH);
    const hi = Math.max(0, viewH - trackH);
    return Math.round(Math.min(hi, Math.max(lo, t)));
  }

  function centerBar() {
    const track = el.track;
    if (!track) return;
    track.style.transform = `translateY(${centerTarget(barNeighbors ? 1 : 0)}px)`;
  }

  /**
   * 条形态桌面独有：按**视口高度 + 卡片 padding** 一次设好窗高（不逐帧涨）。
   * 与 `syncBarViewHeight` 共用 `barViewHeight()` ⇒ 视口与窗口永远严丝合缝，
   * 不会出现「窗口比三行高 ⇒ 露出第 4 行」。
   */
  function requestBarFitHeight() {
    if (mode !== 'bar' || !el.track) return;
    if (!el.track.children.length) return;
    const target = Math.ceil(12 + barViewHeight()); // .bar-card 上下各 6px padding
    if (target === lastBarFitH) return;
    lastBarFitH = target;
    window.yueduLyrics.fitHeight(target);
  }

  function clearTimer() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function schedule() {
    clearTimer();
    if (mode !== 'bar' || !lines.length) return;
    if (index >= lines.length - 1) {
      // 章末：先让最后一行停留一个节拍，再请主窗切下一章；正文为空时只等加载
      if (barBodyEmpty) return;
      timer = setTimeout(() => {
        timer = null;
        if (mode !== 'bar' || !lines.length) return;
        if (!barAdvanceRequested) {
          barAdvanceRequested = true;
          window.yueduLyrics.floatCommand({ cmd: 'chapterNext' });
        }
        // 新章载荷没来（或切章失败）⇒ 清标志重试，不把条形态卡死
        timer = setTimeout(() => {
          timer = null;
          barAdvanceRequested = false;
          schedule();
        }, Math.max(2000, speedMs));
      }, speedMs);
      return;
    }
    timer = setTimeout(tick, speedMs);
  }

  function tick() {
    timer = null;
    if (mode !== 'bar' || animating || !lines.length || index >= lines.length - 1) return;
    /* 关掉前后句：没有「下一行」可看，滑动只会把当前行推出视野、留一片空白 ⇒ 直接换词 */
    if (!barNeighbors) {
      index = Math.min(lines.length - 1, index + 1);
      barGen += 1;
      renderRows();
      if (index < lines.length - 1) timer = setTimeout(tick, speedMs);
      else schedule();
      return;
    }
    animating = true;
    const animMs = BAR_ANIM_MS;
    const gen = barGen;
    /* ★ 字号与 transform 同一条时间轴：先把「下一行即将成为当前行」的角色换好，
       让 font-size/line-height 的过渡与轨道上滑同帧起、同帧落；动画结束再重建 DOM
       （此时可见的三行文字与位置完全一致，收尾压回 3 行不会跳）。 */
    const track = el.track;
    const rows = track ? track.children : [];
    if (rows.length >= 3) {
      rows[1].classList.remove('is-cur');
      rows[2].classList.add('is-cur');
    }
    // 动画期临时补第 4 行（新 next），结束后压回 3 行
    if (track) {
      const ghost = document.createElement('div');
      const ghostIdx = index + 3;
      ghost.className = 'bar-row' + (rowIsTitle(ghostIdx) ? ' is-title' : '');
      ghost.textContent = rowText(ghostIdx);
      track.appendChild(ghost);
      void track.offsetHeight;
    }
    const view = track && track.parentElement;
    const viewH = view ? view.clientHeight : 0;
    const h0 = rows.length ? rows[0].offsetHeight : 0;
    const adjH = Math.round(barBasePx() * 1.3);
    const curH = Math.round((Math.round(Number(prefsCache?.fontSize) || 22)) * 1.35);
    // 目标 = 动画最后一帧把「新当前行」顶到视口中心所需的位移
    if (track) {
      track.classList.add('slide');
      track.style.transform = `translateY(${Math.round(viewH / 2 - (h0 + BAR_GAP + adjH + BAR_GAP + curH / 2))}px)`;
    }
    setTimeout(() => {
      animating = false;
      if (mode !== 'bar' || gen !== barGen) { if (mode === 'bar') renderRows(); return; }
      index = Math.min(lines.length - 1, index + 1);
      renderRows();
      // 下一次推进按「速度 - 动画时长」补齐节奏
      clearTimer();
      if (index < lines.length - 1) timer = setTimeout(tick, Math.max(120, speedMs - animMs));
      else schedule();
    }, animMs);
  }

  /* ------------------------------------------------------------------ *
   * 三态统一工具条 / 目录
   * ------------------------------------------------------------------ */
  function setDockOn(on) {
    const next = on === true;
    if (next === dockOn) return;
    dockOn = next;
    el.dock?.classList.toggle('dock-on', next);
  }

  function updateDockVisibility() {
    if (!el.dock) return;
    el.dock.querySelectorAll('[data-modes]').forEach((node) => {
      const modes = String(node.dataset.modes || '').split(/\s+/);
      node.hidden = !modes.includes(mode);
    });
    const tier = el.dock.querySelector('[data-tool="tier"]');
    if (tier) {
      tier.textContent = mode === 'bar' ? '▭' : '▤';
      tier.title = mode === 'bar' ? '切回小窗·常规' : '切换为条形';
      tier.setAttribute('aria-label', tier.title);
    }
    if (el.speedLabel) el.speedLabel.textContent = SPEED_LABEL[prefsCache?.speed] || '中';
    if (el.ignoreBtn) {
      // 条形：点击穿透（Linux 无 forward，隐藏）；歌词/常规：锁定窗口（只锁拖动），全平台可用
      el.ignoreBtn.hidden = mode === 'bar' && prefsCache?.clickThroughSupported === false;
    }
    const neighbors = el.dock.querySelector('[data-tool="neighbors"]');
    if (neighbors) {
      const on = prefsCache?.showNeighbors === true;
      neighbors.classList.toggle('on', on);
      neighbors.textContent = on ? '👁' : '◌';
      neighbors.title = `显示前后句：${on ? '开' : '关'}`;
      neighbors.setAttribute('aria-label', neighbors.title);
    }
    if (el.toggle) {
      el.toggle.innerHTML = lastPlaying
        ? '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
      el.toggle.title = lastPlaying ? '暂停' : '继续';
    }
    updateIgnoreLabel();
  }

  function syncTocData(reading) {
    tocChapters = reading && Array.isArray(reading.chapters) ? reading.chapters : [];
    const idx = Number(reading?.chapterIdx);
    tocIndex = Number.isFinite(idx) ? idx : -1;
    if (tocOpen) renderToc();
  }

  function renderToc() {
    if (!el.tocList) return;
    const key = `${tocIndex}|${tocChapters.join('\u0001')}`;
    if (key === tocKey) return;
    tocKey = key;
    el.tocList.textContent = '';
    if (!tocChapters.length) {
      const empty = document.createElement('div');
      empty.className = 'fl-toc-empty';
      empty.textContent = '（目录加载中…）';
      el.tocList.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    tocChapters.forEach((title, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fl-toc-item' + (i === tocIndex ? ' cur' : '');
      b.textContent = title || `第 ${i + 1} 章`;
      b.addEventListener('click', () => {
        setTocOpen(false);
        window.yueduLyrics.floatCommand({ cmd: 'chapterOpen', value: i });
      });
      frag.appendChild(b);
    });
    el.tocList.appendChild(frag);
    const cur = el.tocList.querySelector('.fl-toc-item.cur');
    if (cur) el.tocList.scrollTop = Math.max(0, cur.offsetTop - Math.floor(el.tocList.clientHeight / 2));
  }

  function setTocOpen(open) {
    const on = open === true;
    tocOpen = on;
    el.toc?.classList.toggle('on', on);
    if (on) {
      renderToc();
      setDockOn(true);
    }
  }

  function updateIgnoreLabel() {
    if (!el.ignoreBtn) return;
    if (mode === 'bar') {
      el.ignoreBtn.textContent = clickThrough ? '🔒' : '🔓';
      el.ignoreBtn.title = clickThrough ? '点击穿透：开（点击关闭）' : '点击穿透：关（可拖动/选字）';
      return;
    }
    // 歌词 / 常规：锁定 = 只锁窗口拖动，正文滚动/选字不受影响
    const locked = prefsCache?.dragLocked === true;
    el.ignoreBtn.textContent = locked ? '🔒' : '🔓';
    el.ignoreBtn.title = locked ? '窗口已锁定（点击解锁，可拖动）' : '窗口未锁定（点击锁定，禁止拖动）';
  }

  function renderBar(reading, prefs) {
    if (!prefs) return;
    speedMs = Number(prefs.speedMs) || 2600;
    clickThrough = prefs.clickThrough === true;
    applyAppearance(prefs);
    updateIgnoreLabel();
    /* 显示前后句：与歌词态同一份偏好（顶部 👁 开关） */
    const nb = prefs.showNeighbors === true;
    const nbChanged = nb !== barNeighbors;
    barNeighbors = nb;

    const stamp = Number(reading && reading.updatedAt) || 0;
    const fs = Math.round(Number(prefs.fontSize) || 22);
    const host = el.track && el.track.parentElement;
    const maxW = Math.max(80, (host ? host.clientWidth : 0) - 12);
    const stampChanged = stamp !== lastReadingStamp;
    if (stampChanged) {
      lastReadingStamp = stamp;
      barGen += 1;
      barParagraphs = reading && Array.isArray(reading.paragraphs)
        ? reading.paragraphs.filter((s) => typeof s === 'string' && s.trim())
        : [];
      barLegacyLines = reading && Array.isArray(reading.lines)
        ? reading.lines.filter((s) => typeof s === 'string' && s.trim())
        : [];
      barTitle = String((reading && reading.chapterTitle) || '');
      barAdvanceRequested = false;
      barWidth = maxW;
      barFs = fs;
      rebuildBarLines(maxW, fs);
      const ratio = Number(reading && reading.ratio);
      const want = Number(reading && reading.index);
      const last = Math.max(0, lines.length - 1);
      index = Number.isFinite(ratio) && ratio > 0
        ? Math.round(Math.max(0, Math.min(1, ratio)) * last)
        : Math.max(0, Math.min(last, Number.isFinite(want) ? Math.round(want) : 0));
      animating = false;
      renderRows();
      schedule();
      return;
    }
    // 窗宽 / 字号变化：重新按宽折行，位置按当前行比例保留
    if (fs !== barFs || maxW !== barWidth) {
      const keep = lines.length > 1 ? index / (lines.length - 1) : 0;
      barFs = fs;
      barWidth = maxW;
      barGen += 1;
      rebuildBarLines(maxW, fs);
      index = Math.round(keep * Math.max(0, lines.length - 1));
      animating = false;
      renderRows();
      schedule();
      return;
    }
    // 仅速度/穿透/显示前后句变化：不重置进度，只按新可见行数重排并刷新节奏
    if (nbChanged) {
      barGen += 1;
      animating = false;
      lastBarFitH = 0;
      renderRows();
    }
    if (el.speedLabel) el.speedLabel.textContent = SPEED_LABEL[prefs.speed] || '中';
    schedule();
  }

  /* 窗宽变化 ⇒ 折行结果变化；按当前行比例保留位置后一次重排 + 一次重报窗高。
     窗高变化（主进程按内容高度设窗）⇒ 只需按新视口重新居中，别重排正文。 */
  window.addEventListener('resize', () => {
    if (mode !== 'bar' || !el.track) return;
    if (barResizeRaf) cancelAnimationFrame(barResizeRaf);
    barResizeRaf = requestAnimationFrame(() => {
      barResizeRaf = 0;
      if (mode !== 'bar' || !el.track) return;
      const host = el.track.parentElement;
      const maxW = Math.max(80, (host ? host.clientWidth : 0) - 12);
      if (maxW === barWidth) {
        // ★ 主进程按 fitHeight 改完窗高后必须重新居中：否则轨道还停在旧视口的位移上，
        //   可见三行会被顶出窗外（表现为条形档一片空白）。
        if (!animating) centerBar();
        return;
      }
      const keep = lines.length > 1 ? index / (lines.length - 1) : 0;
      barWidth = maxW;
      barFs = Math.round(Number(prefsCache?.fontSize) || 22);
      barGen += 1;
      rebuildBarLines(maxW, barFs);
      index = Math.round(keep * Math.max(0, lines.length - 1));
      animating = false;
      lastBarFitH = 0;
      renderRows();
      schedule();
    });
  });

  /* ------------------------------------------------------------------ *
   * 常规形态（自绘正文，可滚动；窗口尺寸由用户拖）
   * ------------------------------------------------------------------ */
  let rdKey = '';

  function renderRegular(reading, prefs) {
    if (!prefs || !el.rdBody) return;
    applyAppearance(prefs);
    const incoming = reading && Array.isArray(reading.paragraphs) && reading.paragraphs.length
      ? reading.paragraphs
      : (reading && Array.isArray(reading.lines) ? reading.lines : []);
    const title = reading?.chapterTitle
      ? `${reading.title || ''} · ${reading.chapterTitle}`.replace(/^ · /, '')
      : (reading?.title || reading?.chapterLabel || '');
    if (el.rdTitle) el.rdTitle.textContent = title;
    if (el.rdCount) {
      const chapters = Array.isArray(reading?.chapters) ? reading.chapters.length : 0;
      const idx = Number(reading?.chapterIdx);
      el.rdCount.textContent = chapters > 0 && Number.isFinite(idx)
        ? `${idx + 1} / ${chapters}`
        : (Number(reading?.total) > 0 ? `${Math.max(1, (Number(reading?.index) || 0) + 1)} / ${Number(reading.total)}` : '');
    }
    // 内容/章节没变就什么都不做 —— 用户正在滚的位置不能被一次无关的 prefs 更新打回去
    const stamp = Number(reading?.updatedAt) || 0;
    const key = `${stamp}|${title}|${incoming.join('\u0001')}`;
    if (key === rdKey) return;
    rdKey = key;
    el.rdBody.textContent = '';
    if (!incoming.length) {
      const p = document.createElement('p');
      p.textContent = '（正文加载中…）';
      p.style.color = 'var(--float-muted)';
      el.rdBody.appendChild(p);
      return;
    }
    for (const line of incoming) {
      if (!line) continue;
      const p = document.createElement('p');
      p.textContent = line;
      el.rdBody.appendChild(p);
    }
    // 进入浮窗/切形态时按主窗阅读位置恢复；换章 ratio=0 ⇒ 回到章首
    const ratio = Math.max(0, Math.min(1, Number(reading?.ratio) || 0));
    const max = el.rdBody.scrollHeight - el.rdBody.clientHeight;
    el.rdBody.scrollTop = max > 0 ? Math.round(ratio * max) : 0;
  }

  function setMode(next) {
    const prev = mode;
    mode = next === 'bar' ? 'bar' : next === 'regular' ? 'regular' : 'lyrics';
    document.body.dataset.mode = mode;
    if (mode !== 'bar') {
      clearTimer();
      barAdvanceRequested = false;
    } else if (prev !== 'bar') {
      // 进入条形态：按新形态的窗宽重新折行、重新报一次内容高
      lastReadingStamp = 0;
      barWidth = 0;
      barFs = 0;
      lastBarFitH = 0;
    }
    if (mode !== 'lyrics') stopProgress();
    else if (lastPlaying) startProgress();
    if (prev !== mode) {
      setDockOn(false);
      setTocOpen(false);
    }
    updateDockVisibility();
    // 从阅读形态切回歌词：主进程按形态改过窗高 ⇒ 去重基准作废
    if (mode === 'lyrics' && prev !== 'lyrics') lastFitH = 0;
    // 阅读形态 ⇄ 歌词形态共用面板；只有「退出阅读回到歌词」时收起（歌词窗高度按三行算）
    if (mode === 'lyrics' && prev !== 'lyrics' && settingsOpen) {
      setPanelOpen(false);
      return;
    }
    // 三态共用同一份浮层：切形态不关闭，只按新形态重新量一次高度（正文照旧让位）
    if (settingsOpen) requestAnimationFrame(refreshPanelHeight);
  }

  function render(payload) {
    if (!payload) return;
    // 主进程显式要求重排（如「重置位置」把窗宽改回 720 ⇒ 折行变了）：
    // 清掉窗高去重基准，让本次 renderLyrics 末尾按新折行重新上报一次
    if (payload.forceFit === true) lastFitH = 0;
    setMode(payload.mode);
    applyAppearance(payload.prefs);
    syncTocData(payload.reading);
    if (mode === 'lyrics') {
      renderLyrics(payload);
    } else if (mode === 'bar') {
      renderBar(payload.reading, payload.prefs);
      if (el.speedLabel) el.speedLabel.textContent = SPEED_LABEL[payload.prefs?.speed] || '中';
    } else {
      renderRegular(payload.reading, payload.prefs);
    }
    updateDockVisibility();
  }

  /* ------------------------------------------------------------------ *
   * 交互
   * ------------------------------------------------------------------ */
  /* ---- 三态统一工具条：动作与 Web PiP 对齐 ---- */
  function handleTool(tool) {
    const prefs = prefsCache;
    if (!prefs) return;
    /* 阅读态动作走主窗阅读页；歌词态的朗读动作走既有 lyrics 通道 */
    const readOrBar = () => window.yueduLyrics.floatCommand({ cmd: tool });
    switch (tool) {
      case 'toc':
        setTocOpen(!tocOpen);
        return;
      case 'chapterPrev':
        if (mode === 'lyrics') window.yueduLyrics.command('chapterPrev');
        else readOrBar();
        return;
      case 'chapterNext':
        if (mode === 'lyrics') window.yueduLyrics.command('chapterNext');
        else readOrBar();
        return;
      case 'fontDown':
        patchPrefs({ floatFontSize: Math.max(FONT_MIN, Number(prefs.fontSize) - 1) });
        return;
      case 'fontUp':
        patchPrefs({ floatFontSize: Math.min(FONT_MAX, Number(prefs.fontSize) + 1) });
        return;
      case 'color':
        setPanelOpen(!settingsOpen);
        return;
      case 'tier':
        window.yueduLyrics.floatCommand({ cmd: 'mode', value: mode === 'bar' ? 'regular' : 'bar' });
        return;
      case 'neighbors':
        patchPrefs({ floatShowNeighbors: prefs.showNeighbors !== true });
        return;
      case 'sentencePrev':
        window.yueduLyrics.command('prev');
        return;
      case 'play':
        window.yueduLyrics.command('toggle');
        return;
      case 'sentenceNext':
        window.yueduLyrics.command('next');
        return;
      case 'speed': {
        const next = speedMs >= 3600 ? 2 : speedMs >= 2100 ? 3 : 1;
        window.yueduLyrics.floatCommand({ cmd: 'speed', value: next });
        return;
      }
      case 'resetPos':
        // 歌词窗自身能力：清掉位置偏好 ⇒ 主进程回到「底部居中 + 按内容量高」。
        // 锁定态也受理（锁定只拦拖动/缩放，不拦工具条上的显式动作）。
        window.yueduLyrics.floatCommand({ cmd: 'reset-pos' });
        return;
      case 'clickThrough':
        // 歌词/常规：切换「窗口拖动锁定」（主进程 floatDragLocked）；
        // 条形：维持点击穿透（条形态本来就不需要滚动正文）。
        if (mode === 'bar') {
          clickThrough = !clickThrough;
          updateIgnoreLabel();
          window.yueduLyrics.floatCommand({ cmd: 'click-through', value: clickThrough });
        } else {
          patchPrefs({ floatDragLocked: prefsCache?.dragLocked !== true });
        }
        return;
      case 'close':
        // ★ 歌词态走独立通道 `close()`；`command()` 那条通道只认上一句/播放/下一句/章节，
        //   塞 'close' 进去会被主进程白名单丢掉（这就是点 X 没反应的原因）。
        if (mode === 'lyrics') window.yueduLyrics.close();
        else window.yueduLyrics.floatCommand({ cmd: 'close' });
        return;
      default:
    }
  }

  el.dock?.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => handleTool(btn.dataset.tool));
  });

  el.toc?.querySelector('[data-toc-close]')?.addEventListener('click', () => setTocOpen(false));

  /* ---- 浮条设置面板（外观全部写回主进程 prefs，与设置页共用；三态同一份 DOM） ---- */
  if (el.opacity) {
    // 拖动滑块时先本地预览（不写盘），松手才落盘：避免每像素一次 JSON 写
    el.opacity.addEventListener('input', () => {
      const value = Number(el.opacity.value);
      if (el.opacityVal) el.opacityVal.textContent = `${Math.round(value * 100)}%`;
      const bg = prefsCache ? prefsCache.bgColor : '#0C0E12';
      document.documentElement.style.setProperty('--float-bg-rgba', bgRgba(bg, value));
    });
    el.opacity.addEventListener('change', () => patchPrefs({ floatBgOpacity: Number(el.opacity.value) }));
  }

  /* ---- 拖动：整块歌词可拖；主进程按增量 setBounds（不用 app-region，避免吞点击） ----
     ★ `.fl-actions` 不在忽略列表里：条形态只有 ~86px 高，鼠标一进顶部 48px 热区
       工具条就整宽浮现，若把它也算「不可拖」，条形态几乎无处可抓（用户实机：未锁定也拖不动）。
       工具条里的按钮仍由 `button` 选择器排除，点按钮不会触发拖动。 */
  const DRAG_IGNORE = 'button, input, .fl-settings, .fl-toc, .rd-body';
  let drag = null;

  /* ---- 歌词形态自定义缩放 ----
     浮窗是透明无边框窗，Windows 上连 `WS_THICKFRAME` 都没有 ⇒ 没有可抓的系统缩放边缘，
     只把 `resizable` 置 true 用户仍然拉不动。这里自己判定鼠标是否贴着四条边/四个角，
     发增量给主进程改几何（主进程按「歌词形态 + 未锁定」放行）。 */
  const RESIZE_EDGE = 5;
  const RESIZE_CURSOR = {
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
  };
  let resizing = null;

  function resizeEdgeAt(e) {
    if (mode !== 'lyrics' || (prefsCache && prefsCache.dragLocked === true)) return '';
    const w = window.innerWidth;
    const h = window.innerHeight;
    const x = Number(e.clientX);
    const y = Number(e.clientY);
    const l = x <= RESIZE_EDGE;
    const r = x >= w - RESIZE_EDGE;
    const t = y <= RESIZE_EDGE;
    const b = y >= h - RESIZE_EDGE;
    if (t && l) return 'nw';
    if (t && r) return 'ne';
    if (b && l) return 'sw';
    if (b && r) return 'se';
    if (l) return 'w';
    if (r) return 'e';
    if (t) return 'n';
    if (b) return 's';
    return '';
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    // 贴边优先：未锁定的歌词形态从边缘按下 ⇒ 缩放而不是拖动
    const edge = resizeEdgeAt(e);
    if (edge) {
      resizing = { id: e.pointerId, edge, x: e.screenX, y: e.screenY };
      document.body.style.cursor = RESIZE_CURSOR[edge];
      e.preventDefault();
      return;
    }
    // 条形态的 🔒 是「点击穿透」，不是拖动锁定 ⇒ 条形态永远允许拖（穿透开着时收不到事件）
    if (mode !== 'bar' && prefsCache && prefsCache.dragLocked === true) return;
    const target = e.target;
    if (target && target.closest && target.closest(DRAG_IGNORE)) return;
    // 常规/歌词态：工具条条面（按钮之间的空隙、左侧渐变区）不当拖动柄。
    // 那里按下会拖窗 ⇒ 窗体挪走、click 落空，用户看到的就是「按了没反应」；
    // 条形态只有 ~86px 高，必须整条能抓，所以只在 bar 保留。
    if (mode !== 'bar' && target && target.closest && target.closest('.fl-actions')) return;
    drag = { id: e.pointerId, x: e.screenX, y: e.screenY };
    document.body.classList.add('fl-dragging');
  }

  function onPointerMove(e) {
    if (resizing && e.pointerId === resizing.id) {
      const dx = e.screenX - resizing.x;
      const dy = e.screenY - resizing.y;
      if (dx === 0 && dy === 0) return;
      resizing.x = e.screenX;
      resizing.y = e.screenY;
      window.yueduLyrics.resizeBy(resizing.edge, dx, dy);
      return;
    }
    if (!drag || e.pointerId !== drag.id) {
      // 空闲时把边缘光标提示出来（锁定/其他形态自动落回默认）
      const edge = resizeEdgeAt(e);
      document.body.style.cursor = edge ? RESIZE_CURSOR[edge] : '';
      return;
    }
    const dx = e.screenX - drag.x;
    const dy = e.screenY - drag.y;
    if (dx === 0 && dy === 0) return;
    drag.x = e.screenX;
    drag.y = e.screenY;
    window.yueduLyrics.moveBy(dx, dy);
  }

  function onPointerUp(e) {
    if (resizing && (!e || e.pointerId === resizing.id)) {
      resizing = null;
      document.body.style.cursor = '';
      return;
    }
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
    document.body.classList.remove('fl-dragging');
  }

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  // 拖动中不要在文字上选中
  document.addEventListener('dragstart', (e) => e.preventDefault());

  /* ---- 工具条浮现：常规/条形只认顶部 48px，歌词态整窗（与 Web PiP 一致） ---- */
  /** 最后一次指针位置：窗口在指针底下被程序性改高矮后，要靠它自愈（见 repairDockAfterResize） */
  let lastPt = null;
  function updateDockFromPointer(e) {
    lastPt = { x: e.clientX, y: e.clientY };
    if (mode === 'lyrics') {
      setDockOn(true);
      return;
    }
    setDockOn(Number(e.clientY) <= 48);
  }
  document.addEventListener('pointermove', updateDockFromPointer, { passive: true });
  document.addEventListener('pointerleave', () => setDockOn(false));
  // 指针离开窗口时 relatedTarget 必为 null；比 pointerleave 多一路兜底
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) setDockOn(false); });
  el.dock?.addEventListener('mouseenter', () => setDockOn(true));

  /**
   * 窗口在指针底下被程序性改高矮时，Chromium **不会**重算 hover：
   * 实测歌词窗 show 时先按三行 125px 亮相、随后按实测内容缩到 59px；指针停在旧范围内时
   * 一条 `pointerleave` 都不发 ⇒ `dock-on` 永远挂着（鼠标再到窗外时 OS 已不再投递事件）。
   * 所以每次 resize 都用「最后一次指针位置」重判一次：已落到新视口外就收起。
   */
  function repairDockAfterResize() {
    if (!lastPt) return;
    const outside = lastPt.x < 0 || lastPt.y < 0 || lastPt.x > innerWidth || lastPt.y > innerHeight;
    if (outside) setDockOn(false);
    else if (mode !== 'lyrics') setDockOn(lastPt.y <= 48);
  }
  window.addEventListener('resize', repairDockAfterResize);

  // 点击穿透时，只有鼠标移入交互区（工具条 / 设置浮层 / 目录）才临时接收点击
  // （主进程 setIgnoreMouseEvents 切换；forward:true 保证穿透状态下仍能收到 move/enter）
  for (const zone of [el.dock, el.settings, el.toc]) {
    if (!zone) continue;
    zone.addEventListener('mouseenter', () => window.yueduLyrics.hover(true));
    zone.addEventListener('mouseleave', () => window.yueduLyrics.hover(false));
  }

  window.yueduLyrics.onUpdate(render);
})();
