<script setup lang="ts">
/**
 * ShelfView —— 我的书架（左分组 / 右书格）
 *
 * 本轮（用户实测 ①）按 Legado 的书架分组模型重做左栏：
 *   · 顶部「我的书架」右侧 → **分组管理**按钮 → 浮层（新建 / 分组排序 / 编辑 / 删除）
 *   · 左栏列表：**全部分组 / 未分组 / 各分组 / ＋新建分组**
 *   · 每个分组有自己的**组内书籍排序**；`跟随全局` 的分组用左栏底部的全局排序
 *   · 书卡 hover 增加「分组」→ 与「加入书架」同一个对话框（改分组）
 *
 * 分组模型（字段 / bookSort 取值 / 未分组判据 / groupId 分配）全部照 Legado，
 * 说明见 `apps/web/src/shelf-groups.ts` 顶部；存储暂时仍是 localStorage（Phase 1.4 待迁移）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useReaderStore, itemKey, type ShelfBook } from '../stores/reader';
// `#207` 整本下载中心（缓存/离线任务视图）
import { useDownloadsStore } from '../stores/downloads';
// `#202` 本地书导入（txt/epub）：文件放服务端，正文按偏移/章节现取
// `#209`：主键式子抽到 `utils/local-book-key.ts`（双击打开也要用它，**不许抄第二份**）
import { localBookUrlOf } from '../utils/local-book-key';
import { encodeItemKey } from '../utils/user-map';
import { importLocalBookArchive, importLocalBookFile } from '../user-data';
import {
  BOOK_SORT_OPTIONS, SHELF_ALL, SHELF_UNGROUPED, bookSortLabel, isInGroup, isUngrouped,
  resolveBookSort, sortBooks, type ShelfGroup,
} from '../shelf-groups';
import CoverImage from '../components/CoverImage.vue'; /* `#163` 封面统一出口 */
import ShelfGroupManager from '../components/ShelfGroupManager.vue';
import GroupEditDialog from '../components/GroupEditDialog.vue';
import AddToShelfDialog from '../components/AddToShelfDialog.vue';
import CoverEditorDialog from '../components/CoverEditorDialog.vue'; /* `#204` 换自定义封面 */
// `#625` 粘贴链接加书（URL → 书源识别：`,{origin}` → 域名 → `bookUrlPattern`）
import AddByUrlDialog from '../components/AddByUrlDialog.vue';
import { toast } from '../toast';

// 封面统一走服务端代理（防盗链 Referer + 源图片解密 + 动图原样透传）——见 utils/img.ts
import { imgSrc } from '../utils/img';

const router = useRouter();
const reader = useReaderStore();
const downloads = useDownloadsStore();

/* ---- `#202` / `#214` 导入本地书（txt / epub） ---- */

/** 隐藏的多选文件框（在「导入本地书」对话框里，由「📄 选择本地书籍」触发） */
const localFileInput = ref<HTMLInputElement | null>(null);
/** 逐条上传中（对话框此时已关，进度走侧栏 tip 与 toast） */
const importingLocal = ref(false);
/**
 * 导入对话框开关。**复用「加入书架」对话框**（选分组下拉 + 就地新建分组）——
 * 用户 2026-10-02 要求：导入本地书时也走这个对话框，并在其中挑文件（可多选）。
 */
const importOpen = ref(false);

/**
 * `#625` 「粘贴链接加书」对话框开关。
 *
 * 与「导入本地书」并列的入口：本地文件走 `#202`，**网络书靠一只详情页链接**走这里。
 * 识别逻辑全在服务端（core 的 `source-match.ts`），本视图只负责开场与「进详情」。
 */
const addByUrlOpen = ref(false);

/**
 * `#234` **本地 TXT 的文本编码**。
 *
 * ## 为什么要给界面选项（先查清缺口再动手）
 * 底层能力**早就有了**：`core/local-book/encoding.ts` 有 `detectCharset`（BOM/UTF-8 合法性/
 * GBK 特征字节）与 `decodeBuffer`；服务端 `POST /api/local-books/import` 也已读
 * `x-book-charset` 头（`charsetHint`）；前端 `importLocalBookFile(file, bookUrl, charset)`
 * 第三个参数就是它。★ **唯独 `onImportConfirm` 调用时没传** ⇒ 只能靠自动探测。
 *
 * 探测在多数情况下够用（BOM / 合法 UTF-8 / GBK 特征字节都能认出），
 * 但**无 BOM 的 GBK 与 Big5 存在互相误判的可能**（都是双字节高位序列），
 * 一旦认错就是「整本乱码 + 目录全乱」且没有任何报错 ⇒ 必须让用户能手动指定。
 *
 * ## 取值口径
 * · `''`（自动）⇒ **不传** `x-book-charset`，由服务端 `detectCharset` 决定（默认行为不变）；
 * · 其余值原样传，服务端 `normaliseCharset` 归一（`gbk`/`gb2312`/`cp936` 都会落到 `gb18030`）。
 * ★ 列表里**不单独列 ansi** —— Windows 的「ANSI」就是系统默认代码页（简体中文机器 = GBK/GB18030），
 *   与 `gb18030` 是同一个东西；单列一个「ANSI」反而会让人以为还有第五种编码。
 */
const CHARSET_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '自动识别（推荐）' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gb18030', label: 'GBK / GB18030（简体中文 ANSI）' },
  { value: 'big5', label: 'Big5（繁体中文）' },
  { value: 'utf-16le', label: 'UTF-16 LE（Windows Unicode）' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
];
const localCharset = ref('');
/** 对话框里已挑好、**尚未导入**的文件（点「导入」才落库） */
const pendingLocalFiles = ref<File[]>([]);
/** 逐条结果（成功几条 / 失败几条 + 失败原因）—— 失败**必须说清楚原因**，不吞 */
const localImportResult = ref<{ ok: string[]; bad: string[] } | null>(null);

/**
 * `B26` 书架拖入导入。支持格式与服务端解析器一致（zip 走包内逐本导入）。
 * 整个书架页与「导入本地书」浮层都可作为投放目标；格式不支持的**逐条拒绝并说明**。
 */
const LOCAL_BOOK_EXTS = ['.txt', '.epub', '.umd', '.pdf', '.mobi', '.azw3', '.zip'] as const;
const LOCAL_BOOK_ACCEPT = '.txt,.epub,.umd,.pdf,.mobi,.azw3,.zip,text/plain,application/epub+zip,application/pdf,application/zip';
const LOCAL_BOOK_FMT = 'txt / epub / umd / pdf / mobi / azw3 / zip';
/** 拖拽中的文件是否可导入（只看扩展名；真正解析在服务端） */
function isLocalBookFile(f: File): boolean {
  const name = f.name.toLowerCase();
  return LOCAL_BOOK_EXTS.some((ext) => name.endsWith(ext));
}
/** 本轮被拒绝的文件名（对话框里逐条说明，不静默丢） */
const rejectedLocalFiles = ref<string[]>([]);
/** 本轮按 fileSig 去重时忽略的个数 */
const skippedDupFiles = ref(0);
/** 书架页面拖拽高亮（用计数抵消 dragenter/dragleave 在子元素间的抖动） */
const shelfDragDepth = ref(0);
const shelfDragActive = computed(() => shelfDragDepth.value > 0);
/** 「导入本地书」浮层内投放区高亮 */
const dialogDragging = ref(false);

function eventHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * 把一批文件并入待导入列表：支持的多选追加、重复的忽略、不支持的留下可读原因。
 * 返回本批实际加入的个数（=0 表示全是拒绝/重复）。
 */
function addLocalFiles(files: readonly File[]): number {
  const supported = files.filter(isLocalBookFile);
  rejectedLocalFiles.value = files.filter((f) => !isLocalBookFile(f)).map((f) => f.name);
  const seen = new Set(pendingLocalFiles.value.map(fileSig));
  let added = 0;
  let dup = 0;
  for (const f of supported) {
    const sig = fileSig(f);
    if (seen.has(sig)) {
      dup += 1;
      continue;
    }
    seen.add(sig);
    pendingLocalFiles.value.push(f);
    added += 1;
  }
  skippedDupFiles.value = dup;
  if (rejectedLocalFiles.value.length) {
    const shown = rejectedLocalFiles.value.slice(0, 3).join('、');
    const more = rejectedLocalFiles.value.length > 3 ? `…等 ${rejectedLocalFiles.value.length} 个` : '';
    toast(`不支持 ${rejectedLocalFiles.value.length} 个文件（仅支持 ${LOCAL_BOOK_FMT}）：${shown}${more}`, 'warn', 10000);
  }
  if (dup) toast(`已忽略 ${dup} 个重复文件（同名 + 同大小 + 同修改时间）`, 'warn', 6000);
  return added;
}

/** 拖到书架页：只接管「文件」拖拽，普通文字/链接拖拽不干扰书架 */
function onShelfDragEnter(e: DragEvent): void {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  shelfDragDepth.value += 1;
}
function onShelfDragOver(e: DragEvent): void {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}
function onShelfDragLeave(e: DragEvent): void {
  if (!eventHasFiles(e)) return;
  shelfDragDepth.value = Math.max(0, shelfDragDepth.value - 1);
}
function onShelfDrop(e: DragEvent): void {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  shelfDragDepth.value = 0;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  if (importingLocal.value) {
    toast('正在导入上一批文件，请稍候再拖入', 'warn');
    return;
  }
  // 拖入是「直接触发导入本地书」：清空上一轮结果，但**保留**用户已挑好的文件
  localImportResult.value = null;
  const added = addLocalFiles(files);
  if (pendingLocalFiles.value.length) importOpen.value = true;
  if (!added && !pendingLocalFiles.value.length) {
    // 全被拒绝时也把浮层打开，让用户看到逐条原因与支持格式
    importOpen.value = true;
  }
}

/** 浮层内投放区：stop 冒泡，避免同时触发整页的拖拽高亮 */
function onDialogDragEnter(e: DragEvent): void {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dialogDragging.value = true;
}
function onDialogDragOver(e: DragEvent): void {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}
function onDialogDragLeave(e: DragEvent): void {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dialogDragging.value = false;
}
function onDialogDrop(e: DragEvent): void {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dialogDragging.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) addLocalFiles(files);
}

/**
 * 「重复书」提示：同名文件的主键与服务端一致（`localBookUrlOf`），
 * 已存在 ⇒ 导入是**更新**（阅读进度/书签保留），而不是新增一本。
 */
function existingLocalBook(f: File): ShelfBook | undefined {
  const url = localBookUrlOf(f.name);
  return reader.bookShelf.find((b) => (b.key ? encodeItemKey(b.key) === url : false));
}

/**
 * `bookUrl`（服务端主键）由前端算 —— 算法在 `utils/local-book-key.ts`（全仓唯一那份）。
 * 与 `contractToShelfBook()` 读回时的算法**完全对称** —— 这是「本地书也能记住读到第几章」的前提。
 */

/** 文件去重键：同名 + 同大小 + 同修改时间视为同一个文件（两次挑到同一文件不该导入两遍） */
function fileSig(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 打开导入对话框（**每次从干净状态开始**：上一轮的文件与结果不该混进来） */
function openLocalImport(): void {
  pendingLocalFiles.value = [];
  localImportResult.value = null;
  rejectedLocalFiles.value = [];
  skippedDupFiles.value = 0;
  importOpen.value = true;
}

/** 对话框里的「选择本地书籍」→ 系统文件框（可多选） */
function pickLocalBooks(): void {
  localFileInput.value?.click();
}

function onLocalBookPicked(e: Event): void {
  const el = e.target as HTMLInputElement;
  const files = Array.from(el.files ?? []);
  el.value = ''; // 允许重复选同一批文件
  if (!files.length) return;
  // 追加而不覆盖：分几次挑也能累积（按 fileSig 去重，不支持的走同一套可读拒绝）
  addLocalFiles(files);
}

function removePendingFile(i: number): void {
  pendingLocalFiles.value.splice(i, 1);
}

function clearPendingFiles(): void {
  pendingLocalFiles.value = [];
}

/**
 * 对话框确认：逐个导入 → 对齐服务端书架 → 把这一批**归入所选分组**。
 *
 * 归组用的主键与导入时传给服务端的 `bookUrl` 是**同一个式子**（`encodeItemKey(b.key)`），
 * 所以匹配不会错位；`groupId <= 0`（未分组）时跳过归组。
 *
 * `#212` Step3：`.zip` 走**批量导入**端点（服务端一次收包、内部逐本落库）。
 * ⚠️ 包内每本书的主键由**服务端**按包内文件名算（前端不自己解 zip、预知不了），
 *    所以归组不能用上面那套「前端预算主键」的式子，而要用**服务端回执里的 `bookUrl`**
 *    （与单本导入「前端算好传进去」正好相反，别照抄单本的写法）。
 */
async function onImportConfirm(groupId: number): Promise<void> {
  const files = pendingLocalFiles.value.slice();
  if (!files.length) {
    // 还没挑文件 ⇒ **不关对话框**（关了反而要重开一次）
    toast('请先点「选择本地书籍」挑要导入的文件', 'warn');
    return;
  }
  importOpen.value = false;
  pendingLocalFiles.value = [];
  importingLocal.value = true;
  const ok: string[] = [];
  const bad: string[] = [];
  const urls = new Set<string>();
  for (const f of files) {
    try {
      if (/\.zip$/i.test(f.name)) {
        // ---- zip 压缩包：一次请求，服务端内部逐本导 ----
        const r = await importLocalBookArchive(f, localCharset.value || undefined);
        for (const it of r.items) {
          if (it.ok) {
            const label = `${it.name || it.entry} · ${it.chapterCount ?? 0} 章${it.format ? `（${it.format}）` : ''}`;
            ok.push(label);
            // 归组用服务端回执的 bookUrl（前端算不出包内主键）
            if (it.bookUrl) urls.add(it.bookUrl);
          } else {
            bad.push(`${it.entry}：${it.error || '未知错误'}`);
          }
        }
      } else {
        // ---- 单个书文件：既有路径（前端算主键由服务端存，与打开时对称）----
        const url = localBookUrlOf(f.name);
        // `#234`：只有用户**显式选了**编码才传；留空 = 自动探测（保持原行为）
        const r = await importLocalBookFile(f, url, localCharset.value || undefined);
        urls.add(url);
        ok.push(`${r.book.name || f.name} · ${r.chapterCount} 章${r.summary?.tocRuleName ? `（${r.summary.tocRuleName}）` : ''}`);
      }
    } catch (err) {
      bad.push(`${f.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 拉回服务端书架（导入是在服务端落库的，本地缓存需要重新对齐）
  try {
    await reader.hydrateShelf();
  } catch (err) {
    console.warn('[shelf] 导入后对齐书架失败：', err);
  }
  // 归组：上面已经对齐过书架，这里按主键把这一批书找出来移入分组
  if (urls.size) {
    const targets = reader.bookShelf.filter((b) => b.key && urls.has(encodeItemKey(b.key)));
    if (targets.length) reader.moveBooksToGroup(targets, groupId);
  }
  importingLocal.value = false;
  localImportResult.value = { ok, bad };
  if (ok.length) toast(`已导入 ${ok.length} 本本地书${groupId > 0 ? '，并归入所选分组' : ''}`);
  // 失败**逐条说明原因**；tip 里也留一份（toast 会被下一条顶掉，长原因留不住）
  // ⚠️ zip 里可能几十本失败 ⇒ toast 里的明细**截断**（完整清单在上面的 tip 里，可逐条看）
  if (bad.length) {
    const shown = bad.slice(0, 5).join('；');
    const more = bad.length > 5 ? `……等共 ${bad.length} 个` : '';
    toast(`有 ${bad.length} 个文件没能导入：${shown}${more}`, 'warn', 12000);
  }
}

/** 分组管理浮层 / 新建分组对话框 */
const managerOpen = ref(false);
const newGroupOpen = ref(false);

/**
 * ⚠️ **单本书的「改分组」入口已移除，等用户确认接口形态**（2026-09-26 用户要求）：
 * 之前书卡 hover 里放过一个「⇄ 分组」按钮（复用「加入书架」对话框），
 * 用户明确要求「鼠标移入不浮现分组调整按钮，单书籍的分组调整接口等我确认」
 * ⇒ 先撤掉；当前**只有加入书架那一刻**能选分组（`components/AddToShelfDialog.vue`）。
 * 数据层（`reader.setBookGroup` / 位掩码）与 UI 组件都还在，接口定了直接接上即可。
 */

/**
 * 左栏底部「＋ 新建分组」：建完**直接切到新分组**（否则新建完看不到效果，像没成功）。
 *
 * ⚠️ `GroupEditDialog` 只 emit `{ groupName, bookSort }`（它没有「是否显示在左栏」这个字段，
 * 见其 `defineEmits`）—— 新建的分组**默认进左栏**（`show = true`），要隐藏去「分组管理」里关。
 */
function onCreateGroup(p: { groupName: string; bookSort: number }): void {
  const g = reader.createGroup(p.groupName, p.bookSort, true);
  newGroupOpen.value = false;
  if (g) activeGroupId.value = g.groupId;
}

/**
 * 当前选中的分组（`SHELF_ALL` / `SHELF_UNGROUPED` / 用户分组 id）。
 * 持久化：切到别的页面再回来仍停在原分组（Legado 也记最近分组）。
 */
const ACTIVE_KEY = 'yuedu-shelf-active-group';
const activeGroupId = ref<number>(Number(localStorage.getItem(ACTIVE_KEY) ?? String(SHELF_ALL)));
watch(activeGroupId, (v) => localStorage.setItem(ACTIVE_KEY, String(v)));
// 分组被删掉/隐藏后不能停在幽灵分组上
watch(
  () => reader.groupsSorted.map((g) => g.groupId).join(','),
  () => {
    const id = activeGroupId.value;
    if (id > 0 && !reader.groupsSorted.some((g) => g.groupId === id)) activeGroupId.value = SHELF_ALL;
  },
);

/**
 * 书架**真实总数**：只用于「书架是否为空」的判定。
 * ⚠️ 头部「共 N 本」不能直接用它 —— 全部用户分组都隐藏时在列数是 0，
 * 若拿它判空会掉进「书架空空如也」，连「⚙ 分组管理」入口都没有了（没法再把分组显示出来）。
 */
const bookCount = computed(() => reader.bookShelf.length);
/** 「我的书架 · 共 N 本」：在列（未隐藏）分组的书 + 未分组的书，隐藏分组不计（用户 2026-11-14） */
const visibleBookCount = computed(() => reader.visibleBookCount);
/** 当前分组对象（虚拟分组为 null） */
const activeGroup = computed<ShelfGroup | null>(
  () => reader.groupsSorted.find((g) => g.groupId === activeGroupId.value) ?? null,
);
const activeGroupName = computed(() => {
  if (activeGroupId.value === SHELF_ALL) return '全部分组';
  if (activeGroupId.value === SHELF_UNGROUPED) return '未分组';
  return activeGroup.value?.groupName ?? '全部分组';
});
/** 实际生效的排序：用户组按自己的 `bookSort`（<0 = 跟随全局） */
const effectiveSort = computed(() =>
  resolveBookSort(activeGroup.value ? activeGroup.value.bookSort : reader.shelfSort),
);
const sortHint = computed(() =>
  activeGroup.value && activeGroup.value.bookSort >= 0
    ? `该分组固定为「${bookSortLabel(activeGroup.value.bookSort)}」`
    : `跟随全局：${bookSortLabel(reader.shelfSort)}`,
);

const filteredBooks = computed(() => {
  const id = activeGroupId.value;
  const all = reader.bookShelf;
  /**
   * 「全部分组」= **未分组的书 + 所有显示中分组里的书**（同一本只出现一次），
   * 与它的数字、头部「共 N 本」同用 {@link reader.visibleBooks} 这一份口径 ——
   * 用户 2026-11-24：「隐藏一个分组就等于把里面的书一起藏起来；未分组的书始终计入」。
   * 2026-11-08 的「全部分组只显示未分组书」已被本口径取代（否则数字与列表自相矛盾）。
   */
  const list =
    id === SHELF_ALL
      ? reader.visibleBooks
      : id === SHELF_UNGROUPED
        ? all.filter((b) => isUngrouped(b.group, reader.groups))
        : all.filter((b) => isInGroup(b.group, id));
  // ⚠️ sortBooks 只排序、不复制元素（书架的移除按引用相等判断，见 shelf-groups.ts 注释）
  return sortBooks(list, effectiveSort.value, reader.progressPercentOf);
});

/** 左栏条目：全部分组 / 未分组 / 各（可见）分组 */
const groupRows = computed(() => [
  // 「全部分组」= 未分组 + 显示中分组的书（去重），与 filteredBooks / 头部「共 N 本」同源
  { id: SHELF_ALL, name: '全部分组', icon: '≡', count: reader.visibleBookCount, hint: '' },
  { id: SHELF_UNGROUPED, name: '未分组', icon: '○', count: reader.ungroupedCount, hint: '' },
  ...reader.groupsVisible.map((g) => ({
    id: g.groupId,
    name: g.groupName,
    icon: '▣',
    count: reader.groupBookCount(g.groupId),
    hint: bookSortLabel(g.bookSort),
  })),
]);

function posterClass(i: number): string {
  return 'p' + ((i % 8) + 1);
}
/** 来源内容类型标记（引擎契约 `kind`，对齐 Legado BookSourceType）：
 *  2=image(漫画) / 1=audio(有声) / 3=file(文件)。'book' 是默认值，不显示标记。 */
const KIND_TAG: Record<string, { text: string; cls: string }> = {
  image: { text: '漫', cls: 'orange' },
  audio: { text: '听', cls: 'cy' },
  file: { text: '文', cls: 'green' },
  video: { text: '影', cls: 'gold' },
  article: { text: '报', cls: 'acc' },
};
function kindTag(kind?: string): { text: string; cls: string } | null {
  return kind ? (KIND_TAG[kind] ?? null) : null;
}
/** 相对时间（对齐 OmniFlow 书架卡片的「最近阅读」时间显示） */
function fmtAgo(ts?: number): string {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ts).toLocaleDateString();
}
/** 展示行：把「类型标记 / 相对时间 / 所在分组」预先算好 */
const rows = computed(() =>
  filteredBooks.value.map((book) => ({
    book,
    tag: kindTag(book.kind),
    when: fmtAgo(book.updatedAt),
    // 一本书可属多组（位掩码）；这里列出全部组名，用户才知道它在哪
    groups: reader.groupsSorted.filter((g) => isInGroup(book.group, g.groupId)).map((g) => g.groupName),
    /**
     * 5-1：封面进度条 + 右上角未读角标。判据**照 Legado**（见 reader store 的
     * `readProgressOf` / `unreadOf`）：未开始 ⇒ `progress = null`（画空槽，宽度 0）；
     * 目录没加载过 ⇒ 不显示角标（不编数字）。
     */
    progress: reader.readProgressOf(book),
    unread: reader.unreadOf(book),
    /** 5-1：本次「更新」发现了新章节 ⇒ 角标高亮（Legado `bvUnread.setHighlight(lastCheckCount > 0)`） */
    unreadHot: (book.lastCheckCount ?? 0) > 0,
    /** 「禁止更新」的书在管理模式下标出来（避免用户以为更新按钮失灵） */
    noUpdate: book.canUpdate === false,
  })),
);

function openReader(b: ShelfBook) {
  // 续读：详情/目录优先读**本地化**数据，直接进入上次阅读章节（用户 5-4）
  void reader.openShelfBook(b, { read: true });
}
function openDetail(b: ShelfBook) {
  // 详情：同样读本地化的详情/目录；要最新数据请点浮层里的「↻ 刷新详情」（用户 5-4）
  void reader.openShelfBook(b, { read: false });
}

/* ★ 用户 2026-10-02 Add：点封面 = 点「继续」⇒ 直接进阅读。
   根因：`.poster` 一直有 `cursor:pointer`（说明设计上本就该可点），但**没有挂任何 handler** ——
   卡片根节点的 `@click="manageMode && toggleSelect(...)"` 在非管理模式下条件为假 ⇒ 点了什么也不做。
   修法：**封面本体接管点击**，语义与浮层里的「▶ 继续」完全一致（同一个 `openReader`），
   避免两套逻辑漂移。管理模式仍走「选中」，不冲突（管理模式下浮层本身是删除/分组）。 */
function onPosterClick(b: ShelfBook): void {
  if (manageMode.value) {
    if (b.key) toggleSelect(b);
    return;
  }
  openReader(b);
}

/** 封面的悬浮提示：把「点封面 = 继续/开始」写进 title，兼作无障碍标签。 */
function posterTitle(b: ShelfBook): string {
  const go = b.lastChapter ? '继续阅读' : '开始阅读';
  return manageMode.value ? `${b.title}（点一下选中）` : `${b.title} —— 点封面${go}`;
}

/* ---------------- `#204` 换自定义封面 ---------------- */

/**
 * 正在编辑封面的那本书（`null` = 对话框关闭）。
 *
 * ★ 这里**不能**只用 `v-if="coverEditBook"` 挂对话框 —— 换完封面后 `onCoverDone()` 会
 *   `hydrateShelf()` 换掉整个 books 数组，`coverEditBook` 一变 null，**对话框会当场消失**
 *   （用户刚点「清除」，框就没了，没法接着操作；实测探针抓到了）。
 *   所以对话框用 `coverEditKey`（稳定的 key 字符串）控制显示，书对象每次现查。
 */
const coverEditKey = ref<string | null>(null);
const coverEditBook = computed<ShelfBook | null>(
  () => filteredBooks.value.find((b) => b.key === coverEditKey.value) ?? null,
);

function openCoverEditor(b: ShelfBook): void {
  if (!b.key) {
    toast('这本书缺少主键（key 为空），换封面需要它 —— 试试刷新书架');
    return;
  }
  coverEditKey.value = b.key;
}

/**
 * 换完封面：重新 hydrate 拿服务端的新记录。
 * ★ 必须在 hydrate **之后**才关对话框 —— 否则 `coverEditBook` 先变 null，
 *   `hasCustom`（清除按钮该不该亮）拿到的是旧数据。
 */
async function onCoverDone(): Promise<void> {
  await reader.hydrateShelf();
  toast('封面已更新');
}

function closeCoverEditor(): void {
  coverEditKey.value = null;
}
/** 单本删除：也走「删除确认」（用户 5-3 要求确认后再删） */
function onDeleteOne(b: ShelfBook) {
  selected.value = new Set(b.key ? [b.key] : []);
  confirmDeleteOpen.value = true;
}

/* ============================ 5-3 更新 + 管理模式 ============================ */

const manageMode = ref(false);
/** 管理模式下的选中集合（键 = ShelfBook.key） */
const selected = ref<Set<string>>(new Set());
const confirmDeleteOpen = ref(false);
/** 批量/单个「移入分组」对话框的目标书（复用「加入书架」那个对话框的数据层） */
const groupTargets = ref<ShelfBook[]>([]);

const selectedBooks = computed(() => filteredBooks.value.filter((b) => b.key && selected.value.has(b.key)));
const allSelected = computed(() => filteredBooks.value.length > 0 && selectedBooks.value.length === filteredBooks.value.length);

function toggleSelect(b: ShelfBook) {
  if (!b.key) return;
  const next = new Set(selected.value);
  if (next.has(b.key)) next.delete(b.key);
  else next.add(b.key);
  selected.value = next;
}
function toggleSelectAll() {
  selected.value = allSelected.value ? new Set() : new Set(filteredBooks.value.map((b) => b.key!).filter(Boolean));
}
/** Add：反选 —— 已选的取消、当前分组里未选的选上（只作用于可见书单，与全选同一口径） */
function invertSelect() {
  const next = new Set<string>();
  for (const b of filteredBooks.value) if (b.key && !selected.value.has(b.key)) next.add(b.key);
  selected.value = next;
}
function toggleManage() {
  manageMode.value = !manageMode.value;
  selected.value = new Set();
}
/** 「更新」= 更新**当前分组内**书籍的详情/目录（并写回本地） */
async function updateCurrentGroup() {
  const list = filteredBooks.value.filter((b) => b.canUpdate !== false);
  if (!list.length) { toast('该分组里没有可更新的书（都被设为「禁止更新」）', 'info'); return; }
  toast(`开始更新 ${list.length} 本书的详情/目录…`, 'info');
  await reader.updateShelfBooks(list);
  const s = reader.shelfUpdate;
  toast(`更新完成：成功 ${s.done} · 失败 ${s.failed}`, s.failed ? 'warn' : 'ok');
}
/** 批量：更新详情目录（只作用于选中的书） */
async function batchUpdate() {
  const list = selectedBooks.value;
  if (!list.length) return;
  await reader.updateShelfBooks(list);
  const s = reader.shelfUpdate;
  toast(`更新完成：成功 ${s.done} · 失败 ${s.failed} · 跳过（禁止更新）${list.filter((b) => b.canUpdate === false).length}`, s.failed ? 'warn' : 'ok');
}
function batchAllowUpdate(allow: boolean) {
  const list = selectedBooks.value;
  if (!list.length) return;
  reader.setBooksAllowUpdate(list, allow);
  toast(`已${allow ? '允许' : '禁止'}更新 ${list.length} 本`, 'ok');
}
async function batchClearCache() {
  const list = selectedBooks.value;
  if (!list.length) return;
  for (const b of list) await reader.clearBookCache(b);
  toast(`已清理 ${list.length} 本的本地缓存（详情/目录 + 预缓存正文）`, 'ok');
}
/**
 * `#207` 批量「⬇ 下载整本」：把选中的书交给**下载中心**（`stores/downloads.ts`）。
 *
 * ⚠️ **本地书会被跳过**（正文本就在本机 ⇒ 不需要下载，对齐上游 `CacheBook.start()` 的
 * `if (!book.isLocal)`）；没有源的书同样跳过。跳过了必须**说清楚跳过了几本**，
 * 否则用户会以为「点了没反应」。
 */
async function batchDownload() {
  const list = selectedBooks.value;
  if (!list.length) return;
  const skipped = list.filter((b) => !downloads.canDownload(b.sourceId));
  const targets = list.filter((b) => downloads.canDownload(b.sourceId));
  if (!targets.length) {
    toast('选中的都是本地书（正文本就在本机，不需要下载）', 'info');
    return;
  }
  let ok = 0;
  for (const b of targets) {
    const t = await downloads.enqueue({
      key: b.key ?? itemKey(b.sourceId, b.payload),
      sourceId: b.sourceId,
      payload: b.payload,
      title: b.title,
      ...(b.author ? { author: b.author } : {}),
      ...(b.cover ? { cover: b.cover } : {}),
    });
    if (t) ok += 1;
  }
  const tail = skipped.length ? `（跳过 ${skipped.length} 本本地书）` : '';
  toast(`已加入下载队列 ${ok} 本${tail} —— 进度见「下载管理」`, ok ? 'ok' : 'warn');
}
async function doBatchDelete() {
  const list = selectedBooks.value;
  confirmDeleteOpen.value = false;
  await reader.removeBooks(list);
  toast(`已移出书架 ${list.length} 本`, 'ok');
  selected.value = new Set();
  if (!filteredBooks.value.length) manageMode.value = false;
}
/** 书卡上的「分组」按钮 → 用同一个「加入书架」对话框改分组（复用已有数据层） */
function openGroupSwitch(books: ShelfBook[]) {
  if (!books.length) return;
  groupTargets.value = books;
}
function onGroupPicked(groupId: number) {
  const targets = groupTargets.value;
  groupTargets.value = [];
  if (!targets.length) return;
  reader.moveBooksToGroup(targets, groupId);
  toast(`已把 ${targets.length} 本移入分组`, 'ok');
}
const groupInitial = computed(() => {
  const b = groupTargets.value[0];
  if (!b) return 0;
  return reader.groupsSorted.find((g) => isInGroup(b.group, g.groupId))?.groupId ?? 0;
});
/** 管理模式下 Esc 退出 */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (groupTargets.value.length) { groupTargets.value = []; return; }
  if (confirmDeleteOpen.value) { confirmDeleteOpen.value = false; return; }
  if (manageMode.value) manageMode.value = false;
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
// Esc 由各个浮层**自己**处理（一次 Esc 只关最上面那层）：
//   `ShelfGroupManager` 内部再叠 `GroupEditDialog`，所以那边用「有没有开对话框」做闸门。
</script>

<template>
  <div
    class="bs-layout"
    @dragenter="onShelfDragEnter"
    @dragover="onShelfDragOver"
    @dragleave="onShelfDragLeave"
    @drop="onShelfDrop"
  >
    <!-- `B26` 拖拽高亮：整页投放目标；pointer-events:none 不挡落点 -->
    <div v-if="shelfDragActive" class="bs-drop-mask">
      <div class="bs-drop-card">
        <div class="bs-drop-icon">📥</div>
        <div class="bs-drop-title">松开导入本地书</div>
        <div class="bs-drop-sub">支持 {{ LOCAL_BOOK_FMT }}；可一次拖入多个文件，.zip 会逐本导入</div>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!bookCount" class="empty-state card">
      <div class="empty-icon">📚</div>
      <h2>你的书架空空如也</h2>
      <p>从 <b>书院发现</b> 或 <b>全局搜索</b> 找到书籍后，进入详情页点击「加入书架」即可开始积累你的藏书；也可以直接导入本机的 <b>txt / epub</b>，或<b>把文件拖进书架</b>。</p>
      <div class="empty-btns">
        <button class="empty-btn primary" @click="router.push('/discovery/books')">前往书院发现 →</button>
        <button class="empty-btn" @click="router.push('/search')">去搜索书籍 →</button>
        <!-- `#214`：书架为空时也要能导入（此前入口只在「有书」时渲染 ⇒ 清空书架后就再也导不进来） -->
        <button class="empty-btn" :disabled="importingLocal" @click="openLocalImport()">
          {{ importingLocal ? '导入中…' : '＋ 导入本地书' }}
        </button>
        <!-- `#625` 手里只有一只链接时（多来自浏览器/别人分享）不必先去搜索 -->
        <button class="empty-btn" @click="addByUrlOpen = true">🔗 粘贴链接加书</button>
      </div>
    </div>

    <template v-else>
      <!-- 左：分组 -->
      <div class="bs-side card">
        <div class="bs-head">
          <div class="bs-title">我的书架<span>共 {{ visibleBookCount }} 本</span></div>
          <!-- `#214`：两个入口统一放在**标题下方**一行（此前挤在标题右侧 ⇒ 左栏窄时被挤成竖排换行） -->
          <div class="bs-tools">
            <!-- ①-1：分组管理入口 -->
            <button class="bs-manage" title="分组管理：新建 / 排序 / 编辑 / 删除" @click="managerOpen = true">⚙ 分组管理</button>
            <!-- `#202`/`#214` 导入本地书（txt / epub）：文件存服务端，跨设备可继续读。
                 点它开「导入本地书」对话框（复用加入书架对话框：选分组 + 就地新建分组 + 挑文件） -->
            <button
              class="bs-manage" :disabled="importingLocal"
              title="导入本地书（txt / epub，可多选）"
              @click="openLocalImport()"
            >{{ importingLocal ? '导入中…' : '＋ 导入本地书' }}</button>
          </div>
        </div>
        <div v-if="localImportResult" class="bs-local-tip">
          <span v-if="localImportResult.ok.length">✅ 本次导入 {{ localImportResult.ok.length }} 本：{{ localImportResult.ok.join('；') }}</span>
          <span v-if="localImportResult.bad.length" class="bad">⚠️ {{ localImportResult.bad.length }} 个失败：{{ localImportResult.bad.join('；') }}</span>
          <button class="bs-invert" @click="localImportResult = null">关闭</button>
        </div>
        <!-- 5-3 管理模式：左侧提供「全选 + 批量操作」（用户要求） -->
        <div v-if="manageMode" class="bs-batch">
          <div class="bs-sel">
            <label class="bs-all">
              <input type="checkbox" :checked="allSelected" @change="toggleSelectAll()" />
              <span>全选（已选 {{ selectedBooks.length }} / {{ filteredBooks.length }}）</span>
            </label>
            <!-- Add：反选（已选的取消、未选的选中） -->
            <button
              class="bs-invert" :disabled="!filteredBooks.length"
              title="反选：已选的取消，未选的选中" @click="invertSelect()"
            >⇄ 反选</button>
          </div>
          <div class="bs-batch-btns">
            <button class="bs-bbtn danger" :disabled="!selectedBooks.length" @click="confirmDeleteOpen = true">🗑 删除</button>
            <button class="bs-bbtn" :disabled="!selectedBooks.length" @click="batchAllowUpdate(true)">✓ 允许更新</button>
            <button class="bs-bbtn" :disabled="!selectedBooks.length" @click="batchAllowUpdate(false)">⛔ 禁止更新</button>
            <button class="bs-bbtn" :disabled="!selectedBooks.length" @click="openGroupSwitch(selectedBooks)">▣ 移入分组</button>
            <button class="bs-bbtn" :disabled="!selectedBooks.length" @click="batchClearCache()">🧹 清理缓存</button>
            <button class="bs-bbtn" :disabled="!selectedBooks.length" title="把整本书的正文缓存到本机（后台执行，进度见「下载管理」）" @click="batchDownload()">⬇ 下载整本</button>
            <button class="bs-bbtn" :disabled="!selectedBooks.length" @click="batchUpdate()">↻ 更新详情目录</button>
          </div>
        </div>
        <div class="bs-sep"></div>
        <div class="bs-body">
          <div
            v-for="g in groupRows" :key="g.id" class="bs-row"
            :class="{ on: activeGroupId === g.id }" :title="g.hint" @click="activeGroupId = g.id"
          >
            <span class="ic">{{ g.icon }}</span>
            <span class="nm">{{ g.name }}</span>
            <span v-if="g.hint" class="bs-rowhint">{{ g.hint }}</span>
            <em>{{ g.count }}</em>
          </div>
          <!-- ①-2：底部新建分组 → 直接弹「新建分组」对话框（与分组管理里的新建同一个） -->
          <button class="bs-new" @click="newGroupOpen = true">＋ 新建分组</button>
        </div>
        <div class="bs-sep"></div>
        <div class="bs-foot">
          <span>全局排序</span>
          <select
            :value="reader.shelfSort" :disabled="!!activeGroup && activeGroup.bookSort >= 0"
            :title="sortHint" @change="reader.setShelfSort(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="o in BOOK_SORT_OPTIONS.filter((x) => x.value >= 0)" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </div>
        <div class="bs-foot-hint">{{ sortHint }}</div>
      </div>

      <!-- 右：书格 -->
      <div class="bs-main card">
        <div class="bm-head">
          <h2>{{ activeGroupName }}</h2>
          <span class="sub">{{ filteredBooks.length }} 本 · 点击封面续读</span>
          <span style="flex: 1"></span>
          <!-- `#625` 粘贴链接加书（与左栏「导入本地书」并列：本地文件 / 网络链接两条路） -->
          <button class="bm-btn" title="粘贴书籍详情页链接，自动识别该用哪个书源并进详情" @click="addByUrlOpen = true">🔗 链接加书</button>
          <!-- 5-3：更新当前分组内书籍的详情/目录（写回本地） -->
          <button
            class="bm-btn" :disabled="reader.shelfUpdate.running || !filteredBooks.length"
            :title="'更新本分组内书籍的详情/目录，并写入本地'"
            @click="updateCurrentGroup()"
          >{{ reader.shelfUpdate.running ? `⬆ 更新中 ${reader.shelfUpdate.done}/${reader.shelfUpdate.total}` : '⬆ 更新' }}</button>
          <!-- 5-3：管理模式开关（按钮变「退出管理」） -->
          <button class="bm-btn" :class="{ on: manageMode }" @click="toggleManage()">
            {{ manageMode ? '✕ 退出管理' : '⚙ 管理' }}
          </button>
        </div>
        <div class="bs-sep"></div>
        <div class="bm-body">
          <div v-if="!filteredBooks.length" class="content-empty">
            <div class="ce-icon">🗂️</div>
            <p v-if="activeGroupId === SHELF_ALL">没有可显示的书 —— 若刚隐藏了分组，可在「⚙ 分组管理」里重新显示。</p>
            <p v-else-if="activeGroupId === SHELF_UNGROUPED">没有未分组的书籍 —— 都归好组了，从左侧选一个分组查看。</p>
            <p v-else-if="activeGroupId > 0">该分组下暂无书籍：在书卡的「分组」里把书放进来吧。</p>
            <p v-else>书架还没有书。</p>
          </div>
          <div v-else class="book-grid">
            <div
              v-for="(r, i) in rows" :key="r.book.key ?? r.book.title" class="book-card"
              :class="{ sel: manageMode && r.book.key && selected.has(r.book.key) }"
              @click="manageMode && toggleSelect(r.book)"
            >
              <div
                class="poster" :class="posterClass(i)"
                :title="posterTitle(r.book)"
                :data-shelf-poster="r.book.key ?? ''"
                @click.stop="onPosterClick(r.book)"
              >
                <!-- `#163`：封面统一走 CoverImage。
                     ⚠️ 原先这里叠了一层 `.ph`（封面上再画一遍书名作者），且用 `plain` 禁止组件画字 ——
                     那套是为了「避免同一段字出现两次」，代价是**有真封面时下方信息也一起被隐藏**
                     （用户 2026-10-01 纠错）。现在规则明确（见 CoverImage 组件头注释）：
                     默认封面 ⇒ 组件自己画书名作者；有真封面 ⇒ 组件不画。
                     所以这层 `.ph` 整个删掉 —— 它与组件画字是同一份信息的两个来源。 -->
                <CoverImage
                  class="poster-img"
                  :cover="r.book.cover" :source-id="r.book.sourceId"
                  :title="r.book.title" :author="r.book.author" :index="i"
                />
                <!-- 5-1：封面底部阅读进度条（判据照 Legado readProgress；未开始 ⇒ 空槽，用户要求也画出来） -->
                <span
                  class="pc-prog" :class="{ zero: r.progress === null }"
                  :title="r.progress === null ? '未开始阅读' : `阅读进度 ${Math.round((r.progress ?? 0) * 100)}%`"
                >
                  <i :style="{ width: `${Math.round((r.progress ?? 0) * 100)}%` }"></i>
                </span>
                <!-- 5-1：封面右上角未读章节数（对应 Legado 的 bvUnread；lastCheckCount>0 时高亮）
                     ★ 显示完整数字（用户要求：未读 2846 就写 2846），不截断成 99+ -->
                <span
                  v-if="r.unread !== null && r.unread > 0" class="pc-unread" :class="{ hot: r.unreadHot }"
                  :title="r.unreadHot ? `有更新：未读 ${r.unread} 章` : `未读 ${r.unread} 章`"
                >{{ r.unread }}</span>
                <!-- 5-3 管理模式：左上角复选框
                     ★ 坑：`<label>` 包住 `<input>` 时，点 label 会**转发**一次 click 给 input，
                       input 再触发一次 `change`。原来 label 自己又带了 `@click` ⇒ toggle 走两遍
                       ⇒ 集合「加了又删」＝点了没反应。这里 label 只负责 `@click.stop`（挡卡片冒泡），
                       切换只由 input 的 `change` 触发一次。
                     ★ 位置与「换封面」图标**互斥**：管理模式显示复选框，否则显示换封面图标
                       （两者都在左上角，同一处但不会同时出现 —— 见下面 `#cover-edit-btn`）。 -->
                <label v-if="manageMode" class="pc-check" title="选中 / 取消" @click.stop>
                  <input type="checkbox" :checked="!!r.book.key && selected.has(r.book.key)" @change="toggleSelect(r.book)" />
                </label>
                <!-- `#204` 用户 2026-10-02 纠错：「🖼 换封面」挤占了「▶ 继续」的位置 ⇒ 挪到**封面左上角**，
                     改成一枚 SVG 图标（hover 出一条 tips 说明，点它进换封面界面）。
                     ★ 为什么放左上角：底部浮层是「主操作区」，只留给「详情 / 继续」两个高频动作。
                       换封面是低频操作，不该占主操作位。
                     ★ 与 `.pc-check` 同位置但互斥（管理 vs 非管理），不会重叠。 -->
                <button
                  v-else class="cover-edit-btn" data-cover-open
                  title="换封面：可上传本地图片，或填一个图片地址；点「清除」可恢复源封面"
                  aria-label="换封面"
                  @click.stop="openCoverEditor(r.book)"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <path
                      d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z"
                      fill="none" stroke="currentColor" stroke-width="1.7"
                    />
                    <circle cx="12" cy="10" r="2.4" fill="currentColor" />
                    <path d="M6 18.2c1.4-2.6 3.4-3.9 6-3.9s4.6 1.3 6 3.9H6Z" fill="currentColor" />
                  </svg>
                </button>
                <!-- 5-3 管理模式：中间删除 + 分组切换 -->
                <div v-if="manageMode" class="pc-manage">
                  <button class="pm-btn danger" @click.stop="onDeleteOne(r.book)">🗑 删除</button>
                  <button class="pm-btn" @click.stop="openGroupSwitch([r.book])">▣ 分组</button>
                </div>
                <div v-else class="cover-actions">
                  <button class="cover-btn ghost" @click.stop="openDetail(r.book)">ⓘ 详情</button>
                  <button class="cover-btn primary" @click.stop="openReader(r.book)">▶ {{ r.book.lastChapter ? '继续' : '开始' }}</button>
                </div>
              </div>
              <!-- ⚠️ 下方信息**无条件显示**（用户 2026-10-01 纠错：「封面」仅指封面图片本身）。
                   之前这里是 `v-if="showCardText(r.book.cover)"` ⇒ 书籍有真封面时下方两行整块消失。
                   封面上画不画字是**另一件事**（`CoverImage` 按上游规则自己决定）。 -->
              <div class="nm" :title="r.book.lastChapter?.title">
                {{ r.book.title }}
                <span v-if="r.tag" class="tag" :class="r.tag.cls">{{ r.tag.text }}</span>
                <span v-if="r.noUpdate" class="tag gray" title="已设为「禁止更新」：更新按钮会跳过它">禁更</span>
                <!-- `#165`（用户 2026-09-30）：书名右侧的「×」直删按钮**已移除**。
                     它 `@click` 直接调 `removeFromShelf` —— **点了就删、没有确认**；
                     而删除功能在「⚙ 管理」模式里已有，且**有确认对话框**（`onDeleteOne` → 确认框）。
                     两处入口重复时，该删的是这个危险的那个。移出书架仍可在管理模式里完成
                     （卡片中间的「🗑 删除」→ 确认框），没有功能丢失。 -->
              </div>
              <div class="au">{{ r.book.lastChapter ? `读到：${r.book.lastChapter.title}` : (r.book.author ?? '未开始阅读') }}</div>
              <div v-if="r.when" class="au dim" :title="r.groups.length ? '分组：' + r.groups.join('、') : '未分组'">
                {{ r.when }}<template v-if="r.groups.length"> · {{ r.groups.join('、') }}</template>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 5-3：删除确认（不弹 window.confirm —— 无头浏览器里它恒返回 false，测不了） -->
    <div v-if="confirmDeleteOpen" class="del-mask" @click.self="confirmDeleteOpen = false">
      <div class="del-dlg">
        <h3>删除书籍</h3>
        <p>
          将从书架移出 <b>{{ selectedBooks.length }}</b> 本书，并清理它们的本地缓存
          （详情/目录 + 预缓存正文）。<br />
          <span class="del-tip">源站上的书不受影响，之后还能重新加入书架。</span>
        </p>
        <div class="del-names" v-if="selectedBooks.length <= 8">{{ selectedBooks.map((b) => b.title).join('、') }}</div>
        <div class="del-names" v-else>{{ selectedBooks.slice(0, 8).map((b) => b.title).join('、') }} 等 {{ selectedBooks.length }} 本</div>
        <div class="del-btns">
          <button class="bm-btn" @click="confirmDeleteOpen = false">取消</button>
          <button class="bm-btn danger" @click="doBatchDelete()">🗑 确认删除</button>
        </div>
      </div>
    </div>

    <!-- `#625` 粘贴链接加书（URL → 书源识别） -->
    <AddByUrlDialog v-if="addByUrlOpen" @close="addByUrlOpen = false" />

    <!-- 5-3：移入分组（复用「加入书架」对话框的数据层与对话框） -->
    <AddToShelfDialog
      v-if="groupTargets.length"
      title="移入分组" confirm-text="确定"
      :initial-group-id="groupInitial"
      :book-title="groupTargets.length === 1 ? groupTargets[0]!.title : `${groupTargets.length} 本书`"
      @confirm="onGroupPicked" @close="groupTargets = []"
    />

    <!-- `#214`：导入本地书 —— **复用「加入书架」对话框**（选分组下拉 / 就地新建分组），
         并用 extra 插槽塞进「选择本地书籍」（可多选）。确认时才真正上传，取消零副作用。 -->
    <AddToShelfDialog
      v-if="importOpen"
      title="导入本地书" confirm-text="导入"
      :book-title="pendingLocalFiles.length ? `已选 ${pendingLocalFiles.length} 个文件` : '点击选择或把文件拖到这里'"
      @confirm="onImportConfirm" @close="importOpen = false"
    >
      <template #extra>
        <input
          ref="localFileInput" type="file" :accept="LOCAL_BOOK_ACCEPT" multiple
          style="display: none" @change="onLocalBookPicked"
        />
        <!-- `B26`：点击与拖入都支持；拖拽经过时高亮，与「导入源 → 上传文件」同一手感 -->
        <div
          class="imp-drop" :class="{ over: dialogDragging }"
          role="button" tabindex="0"
          @click="pickLocalBooks"
          @keydown.enter.prevent="pickLocalBooks"
          @keydown.space.prevent="pickLocalBooks"
          @dragenter="onDialogDragEnter" @dragover="onDialogDragOver"
          @dragleave="onDialogDragLeave" @drop="onDialogDrop"
        >
          <div class="imp-drop-main">{{ dialogDragging ? '松开即可加入待导入列表' : '📄 点击选择文件，或把本地文件拖到这里' }}</div>
          <div class="imp-drop-sub">支持 {{ LOCAL_BOOK_FMT }}；可多选、可多次追加</div>
        </div>
        <div class="imp-head">
          <span v-if="pendingLocalFiles.length" class="imp-count">已选 {{ pendingLocalFiles.length }} 个文件</span>
          <button v-if="pendingLocalFiles.length" class="imp-clear" type="button" @click="clearPendingFiles">清空</button>
        </div>
        <p v-if="rejectedLocalFiles.length" class="imp-warn">
          已拒绝 {{ rejectedLocalFiles.length }} 个不支持的文件：{{ rejectedLocalFiles.join('、') }}（仅支持 {{ LOCAL_BOOK_FMT }}）
        </p>
        <p v-if="skippedDupFiles" class="imp-warn">
          已忽略 {{ skippedDupFiles }} 个重复文件（同名 + 同大小 + 同修改时间）
        </p>
        <div v-if="pendingLocalFiles.length" class="imp-list">
          <div v-for="(f, i) in pendingLocalFiles" :key="fileSig(f)" class="imp-item">
            <span class="imp-name" :title="f.name">{{ f.name }}</span>
            <span v-if="existingLocalBook(f)" class="imp-badge" title="书架已有同名书：导入会更新章节并保留阅读进度">将更新</span>
            <span v-else-if="/\.zip$/i.test(f.name)" class="imp-badge zip">压缩包</span>
            <span class="imp-size">{{ fmtBytes(f.size) }}</span>
            <button class="imp-del" type="button" title="移除这个文件" @click="removePendingFile(i)">✕</button>
          </div>
        </div>
        <label class="imp-charset">
          <span class="imp-charset-label" title="txt 乱码时在这里手动指定编码；epub 内部自带编码声明，不受此项影响">文本编码</span>
          <select v-model="localCharset" class="imp-charset-sel">
            <option v-for="o in CHARSET_OPTIONS" :key="o.value || 'auto'" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <p class="imp-hint">先挑文件，再选下面的分组；点「导入」后才会真正上传。同名文件重复导入＝更新（阅读进度保留）。<br />
          .zip 压缩包会被服务端解包，把里面的 txt / epub / umd / pdf / mobi / azw3 **逐本导入**（会递归子目录）；包内每本书按**文件名**入库。<br />
          PDF 与 mobi/azw3 是**扫描版 / 专有格式**：PDF 按每 10 页一章、由浏览器逐页渲染；mobi/azw3 走文本目录。<br />
          导入后若发现**整本乱码**，取消勾选「自动识别」→ 选对应编码 → 重新导入（同名文件会覆盖，阅读进度保留）。</p>
      </template>
    </AddToShelfDialog>

    <ShelfGroupManager v-if="managerOpen" @close="managerOpen = false" />
    <GroupEditDialog
      v-if="newGroupOpen" title="新建分组"
      @submit="onCreateGroup" @close="newGroupOpen = false"
    />
    <!-- `#204` 换自定义封面 -->
    <CoverEditorDialog
      v-if="coverEditKey" :book="coverEditBook"
      @close="closeCoverEditor()" @done="onCoverDone()"
    />
  </div>
</template>

<style scoped>
/* 页面整体锁成「正好一屏高」：高度取 `92vh` 与主区可用高度（`omni-content` 高 100vh-52px、上下 padding 40px）
   的较小值 ⇒ 左/右栏都到 92vh（大屏）且永远不会把 `.omni-content` 再撑出第二条滚动条。
   左右栏各自独立滚动，页面本身不滚（同设置页 `#793` 的口径）。 */
/* 左栏宽度与发现页左栏（`DiscoverView .disc-page` 的 245px）逐值对齐（用户 2026-11-08）。 */
.bs-layout {
  display: grid; grid-template-columns: 245px minmax(0, 1fr); gap: 16px;
  align-items: stretch; position: relative;
  height: min(92vh, calc(100vh - 92px)); overflow: hidden;
}

/* `B26` 书架拖入：整页高亮层（pointer-events:none，不挡 drop 落点） */
.bs-drop-mask {
  position: absolute; inset: -8px; z-index: 30; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  border-radius: 14px; border: 2px dashed var(--acc-dim);
  background: color-mix(in srgb, var(--acc) 10%, transparent);
  backdrop-filter: blur(1px);
}
.bs-drop-card { text-align: center; padding: 22px 30px; border-radius: 12px; background: var(--bg-2); border: 1px solid var(--line2); box-shadow: 0 12px 40px rgba(0, 0, 0, .35); }
.bs-drop-icon { font-size: 34px; margin-bottom: 6px; }
.bs-drop-title { font-size: 15px; font-weight: 700; }
.bs-drop-sub { margin-top: 6px; font-size: 12px; color: var(--muted); line-height: 1.6; }

/* `#234` 文本编码下拉 */
.imp-charset { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--muted); }
.imp-charset-label { flex: none; }
.imp-charset-sel {
  flex: 1; min-width: 0; padding: 5px 8px; font-size: 12px;
  background: var(--bg-3); color: var(--text);
  border: 1px solid var(--line2); border-radius: 6px;
}

/* 空态 */
/* 空态：整行铺满（否则会被塞进 230px 左栏）；高度按内容，不随锁定高度拉伸 */
.empty-state { grid-column: 1 / -1; align-self: start; text-align: center; padding: 70px 30px; }
.empty-icon { font-size: 54px; margin-bottom: 12px; }
.empty-state h2 { margin: 0 0 8px; }
.empty-state p { color: var(--muted); font-size: 13px; max-width: 460px; margin: 0 auto 20px; line-height: 1.7; }
.empty-btns { display: flex; gap: 10px; justify-content: center; }
.empty-btn { padding: 9px 18px; border-radius: 9px; border: 1px solid var(--line2); background: var(--bg-3); color: var(--text); font-size: 13px; cursor: pointer; }
.empty-btn.primary { background: linear-gradient(135deg, var(--acc), #8b5cf6); border: none; color: #fff; }
.empty-btn.primary:hover { box-shadow: 0 4px 18px var(--acc-glow); }

/* 左分组 */
/* 左栏：固定高度，中间「分组列表」撑满剩余空间，组多时只在这一段滚 */
.bs-side { padding: 14px 10px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.bs-head { padding: 0 6px; display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
.bs-title { font-size: 14px; font-weight: 700; min-width: 0; }
.bs-title span { display: block; font-size: 11px; color: var(--muted); font-weight: 400; margin-top: 3px; }
/* `#214`：入口排在标题**下方**一行，两枚按钮等宽（左栏 230px 下也不再被标题挤成竖排） */
.bs-tools { display: flex; gap: 8px; }
.bs-tools .bs-manage { flex: 1; text-align: center; }
.bs-manage {
  flex: none; padding: 5px 9px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg-3); color: var(--text-1);
  font-size: 11.5px; font-family: var(--font);
}
.bs-manage:hover { border-color: var(--acc-dim); color: var(--text-0); }
.bs-local-tip {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 8px 12px; margin: 8px 0; border-radius: 8px;
  background: var(--bg3); font-size: 12px; color: var(--muted);
}
.bs-local-tip .bad { color: #ff8a8a; }

/* `#214`「导入本地书」对话框（AddToShelfDialog 的 extra 插槽内容）里的文件选择器。
   插槽内容编译在**本组件**的作用域 ⇒ 这些 scoped 样式能命中。 */
.imp-drop {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  padding: 15px 12px; border-radius: 8px; cursor: pointer; text-align: center;
  border: 1px dashed var(--border-strong); background: transparent; color: var(--text-1);
  transition: border-color .15s, background .15s;
}
.imp-drop:hover { border-color: var(--acc-dim); color: var(--text-0); }
.imp-drop.over { border-color: var(--acc); background: color-mix(in srgb, var(--acc) 12%, transparent); color: var(--text-0); }
.imp-drop-main { font-size: 12.5px; }
.imp-drop-sub { font-size: 11px; color: var(--muted); }
.imp-head { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.imp-count { flex: 1; font-size: 11.5px; color: var(--muted); }
.imp-warn { margin: 6px 0 0; font-size: 11px; color: #ff8a8a; line-height: 1.6; }
.imp-badge {
  flex: none; padding: 1px 6px; border-radius: 999px; font-size: 10px;
  color: var(--acc); border: 1px solid var(--acc-dim); background: color-mix(in srgb, var(--acc) 10%, transparent);
}
.imp-badge.zip { color: var(--muted); border-color: var(--line2); background: transparent; }
.imp-clear {
  flex: none; padding: 6px 10px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg-3); color: var(--text-1);
  font-size: 11.5px; font-family: var(--font);
}
.imp-clear:hover { border-color: var(--acc-dim); color: var(--text-0); }
.imp-list { max-height: 168px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.imp-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; font-size: 12px; color: var(--text-1); }
.imp-item + .imp-item { border-top: 1px solid var(--border); }
.imp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imp-size { flex: none; font-size: 10.5px; color: var(--faint); }
.imp-del {
  flex: none; width: 20px; height: 20px; border-radius: 6px; cursor: pointer; line-height: 1;
  border: 1px solid var(--line); background: transparent; color: var(--muted); font-size: 11px;
}
.imp-del:hover { color: var(--red); border-color: var(--red); }
.imp-hint { margin: 0; font-size: 11px; color: var(--muted); line-height: 1.6; }
.bs-sep { height: 1px; background: var(--border); margin: 10px 4px; }
/* ★ `both-edges`：只留 `stable` 时滚动条槽只占右侧 15px，分组行会「左贴边、右留白」
   （用户 2026-11-08 实测）。`stable both-edges` 让左右各留同一条槽，行内容自然居中。 */
.bs-body {
  display: flex; flex-direction: column; gap: 2px;
  flex: 1; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain; scrollbar-gutter: stable both-edges;
}
.bs-row {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 10px; border-radius: 8px; cursor: pointer;
  font-size: 13px; color: var(--text-1);
}
.bs-row:hover { background: var(--bg-3); }
.bs-row.on { background: var(--brand-soft); color: #fff; }
.bs-row .ic { width: 20px; text-align: center; flex: none; }
.bs-row .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bs-rowhint { font-size: 10px; color: var(--faint); flex: none; }
.bs-row.on .bs-rowhint { color: rgba(255, 255, 255, 0.7); }
.bs-row em { font-style: normal; font-size: 11px; color: var(--muted); background: var(--bg-3); border-radius: 999px; padding: 1px 8px; flex: none; }
.bs-row.on em { background: rgba(255, 255, 255, 0.15); color: #fff; }
.bs-new {
  margin: 6px 2px 0; padding: 8px 10px; border-radius: 8px; cursor: pointer;
  border: 1px dashed var(--border-strong); background: transparent;
  color: var(--text-1); font-size: 12.5px; font-family: var(--font); text-align: left;
}
.bs-new:hover { border-color: var(--acc-dim); color: var(--text-0); }
.bs-foot { display: flex; align-items: center; gap: 8px; padding: 0 6px; font-size: 12px; color: var(--muted); }
.bs-foot select { flex: 1; min-width: 0; background: var(--bg-3); border: 1px solid var(--border); border-radius: 7px; color: var(--text); padding: 5px 8px; font-size: 12px; outline: none; }
.bs-foot select:disabled { opacity: 0.5; }
.bs-foot-hint { padding: 6px 6px 0; font-size: 10.5px; color: var(--faint); line-height: 1.5; }

/* 右书格 */
/* 右栏：标题栏固定，书格区域（`.bm-body`）独立滚动 */
.bs-main { padding: 14px 16px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.bm-head { display: flex; align-items: baseline; gap: 10px; }
.bm-head h2 { margin: 0; font-size: 16px; }
.bm-head .sub { font-size: 12px; color: var(--muted); }
.bm-body {
  margin-top: 12px;
  flex: 1; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain; scrollbar-gutter: stable;
}
.content-empty { text-align: center; padding: 50px 0; color: var(--muted); font-size: 13px; }
.ce-icon { font-size: 40px; margin-bottom: 8px; }
/* 与发现页内容卡片（`DiscoverView` 的 `.poster-grid` / `.cinema-grid`：minmax(128px) + gap 14）
   逐值对齐；封面比例两页同为 `2/3`（见 `.book-card .poster` 的 aspect-ratio）。 */
.book-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 14px; }
.book-card { min-width: 0; }
/* ★ `#186` 用 `background-color` 长写（理由同 DashboardView：简写会重置 background-size） */
.book-card .poster { position: relative; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden; cursor: pointer; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); transition: transform 0.2s; background-color: var(--bg-3); }
.book-card .poster:hover { transform: translateY(-4px); }
.poster-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
/* `#163`：`.book-card .poster .ph` 整组已删 —— 模板里的覆盖层节点同一轮移除，
   它与 `.nm`/`.au` 是同一份信息的两个来源，留着会在有真封面时重复、在无封面时错位。 */
.cover-actions {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; gap: 4px; padding: 8px;
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.72), transparent);
  opacity: 0; transition: opacity 0.18s;
}
.book-card .poster:hover .cover-actions { opacity: 1; }
.cover-btn { flex: 1; padding: 5px 0; border-radius: 7px; border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(255, 255, 255, 0.12); color: #fff; font-size: 11px; cursor: pointer; backdrop-filter: blur(4px); white-space: nowrap; }
.cover-btn.primary { background: var(--brand); border-color: var(--brand); }
.cover-btn:hover { filter: brightness(1.15); }
.book-card .nm {
  font-size: 12.5px; font-weight: 600; margin-top: 7px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: flex; align-items: center;
}
.book-card .nm .tag { flex: none; margin-left: 5px; }
/* `.rm`（书名右侧直删按钮）的样式随按钮一起移除 —— `#165`。留着会让人以为入口还在。 */
.book-card .au { font-size: 11px; color: var(--muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.book-card .au.dim { color: var(--faint); font-size: 10.5px; }

/* 窄窗口：改成上下两段（左栏限高、右栏占剩余高度继续独立滚）——
   `grid-template-rows: auto minmax(0, 1fr)` 是右栏能真正收缩并滚动的前提，整页仍不滚。 */
@media (max-width: 1000px) {
  .bs-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  /* 左栏限高：矮窗口下按 40vh 收缩，避免把右栏内容区压没 */
  .bs-side { max-height: min(300px, 40vh); }
}
/* ============================ 5-1 封面进度条 / 未读角标 ============================ */
/* ★ 用户 2026-10-02：封面本体可点（= 「继续」）。这两个角标是**纯展示**，
   若吃掉指针事件，点在数字/进度条上会「点了没反应」⇒ 显式穿透。 */
.pc-prog, .pc-unread { pointer-events: none; }
.pc-prog {
  position: absolute; left: 0; right: 0; bottom: 0; height: 4px;
  background: rgba(0, 0, 0, 0.45); border-radius: 0 0 8px 8px; overflow: hidden;
}
.pc-prog i { display: block; height: 100%; background: var(--acc); transition: width 0.2s; }
/* 未开始 ⇒ 0% 空槽：给一层内描边，浅色封面上也能看出「槽」在哪 */
.pc-prog.zero { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); }
.pc-unread {
  position: absolute; top: 5px; right: 5px; z-index: 2;
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  font-size: 10.5px; font-weight: 700; font-family: var(--mono);
  background: rgba(0, 0, 0, 0.62); color: #fff; border: 1px solid rgba(255, 255, 255, 0.25);
}
/* 有更新（Legado lastCheckCount > 0）⇒ 高亮 */
.pc-unread.hot { background: var(--red); border-color: #fff; }

/* ============================ 5-3 管理模式 ============================ */
.bm-btn {
  flex: none; padding: 5px 10px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg-3); color: var(--text-1);
  font-size: 12px; font-family: var(--font);
}
.bm-btn:hover:not(:disabled) { border-color: var(--acc-dim); color: var(--text-0); }
.bm-btn:disabled { opacity: 0.5; cursor: default; }
.bm-btn.on { background: var(--brand-soft); color: #fff; border-color: var(--brand); }
.bm-btn.danger { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }

.bs-batch { padding: 8px 6px 2px; }
.bs-sel { display: flex; align-items: center; gap: 6px; }
.bs-all { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-1); cursor: pointer; flex: 1; min-width: 0; }
.bs-invert {
  flex: none; padding: 3px 7px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg-3); color: var(--text-1);
  font-size: 11px; font-family: var(--font); line-height: 1.5;
}
.bs-invert:hover:not(:disabled) { border-color: var(--acc-dim); color: var(--text-0); }
.bs-invert:disabled { opacity: 0.45; cursor: default; }
.bs-batch-btns { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.bs-bbtn {
  text-align: left; padding: 6px 9px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg-3); color: var(--text-1);
  font-size: 11.5px; font-family: var(--font);
}
.bs-bbtn:hover:not(:disabled) { border-color: var(--acc-dim); color: var(--text-0); }
.bs-bbtn:disabled { opacity: 0.45; cursor: default; }
.bs-bbtn.danger { color: var(--red); }

/* 管理模式下卡片的浮层控件 */
.book-card { position: relative; }
.book-card.sel .poster { outline: 2px solid var(--acc); outline-offset: -2px; }
.pc-check { position: absolute; top: 5px; left: 5px; z-index: 2; cursor: pointer; display: flex; line-height: 0; }
.pc-check input { width: 16px; height: 16px; accent-color: var(--acc); cursor: pointer; }
/* `#204` 换封面入口（左上角 SVG 图标）。
   ★ 用户 2026-10-02 二次纠错：应**hover 封面才浮现**，与底部「详情 / 继续」同一行为
     （我第一版做成「常驻可见」，理由是「hover 才现等于藏起来」—— 但用户要的是**行为一致**，
      不是我替他们决定的可见性）。改用与 `.cover-actions` 相同的 opacity 过渡。 */
.cover-edit-btn {
  position: absolute; top: 5px; left: 5px; z-index: 2;
  width: 26px; height: 26px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 7px; cursor: pointer;
  background: rgba(0, 0, 0, 0.58); color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.28);
  backdrop-filter: blur(4px);
  /* 与 .cover-actions 同一套「hover 渐现」：默认透明 + 不可点，hover 封面才浮现 */
  opacity: 0; pointer-events: none;
  transition: opacity 0.18s;
}
.book-card .poster:hover .cover-edit-btn { opacity: 1; pointer-events: auto; }
.cover-edit-btn:hover { background: var(--brand); border-color: var(--brand); }
/* 键盘可达：focus 时也要看得见（不能只靠 hover，否则键盘用户永远够不到） */
.cover-edit-btn:focus-visible { opacity: 1; pointer-events: auto; outline: 2px solid var(--acc); outline-offset: 1px; }
.pc-manage {
  position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
  display: flex; flex-direction: column; gap: 6px; padding: 0 10px;
}
.pm-btn {
  padding: 6px 0; border-radius: 7px; cursor: pointer; font-size: 11.5px; font-family: var(--font);
  border: 1px solid rgba(255, 255, 255, 0.28); background: rgba(0, 0, 0, 0.55); color: #fff;
}
.pm-btn:hover { background: rgba(0, 0, 0, 0.72); }
.pm-btn.danger { background: rgba(220, 38, 38, 0.85); border-color: rgba(255, 255, 255, 0.3); }
.tag.gray { background: rgba(148, 163, 184, 0.15); color: var(--muted); }

/* 删除确认对话框 */
.del-mask { position: fixed; inset: 0; z-index: 1040; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; }
.del-dlg {
  width: min(440px, 92vw); padding: 16px 18px; border-radius: var(--r);
  background: var(--bg-1); border: 1px solid var(--border-strong); box-shadow: var(--shadow);
}
.del-dlg h3 { margin: 0 0 8px; font-size: 15px; }
.del-dlg p { margin: 0; font-size: 13px; color: var(--text-1); line-height: 1.7; }
.del-tip { font-size: 11.5px; color: var(--muted); }
.del-names {
  margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 12px;
  background: var(--bg-3); color: var(--text-1); line-height: 1.6;
}
.del-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>