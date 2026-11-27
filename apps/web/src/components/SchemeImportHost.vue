<script setup lang="ts">
/**
 * `#392` **唤起导入宿主**（`#343` 深链/网页链接的落点）—— 常驻，不受任何浮层开关门控。
 *
 * ## 为什么必须单独有这样一个宿主（实测出的真缺陷）
 * 原实现把 `onLegadoUrl` 与两个导入对话框放在 `ReaderOverlay` 里，而 `ReaderOverlay` 的
 * 模板**根节点**是 `<div class="se-mask" v-if="r.open">` ⇒ **阅读页没打开时整棵子树都不渲染**。
 * 后果：在**登录界面**的内置浏览器里点「导入书源」——`srcImportOpen` 置真了，但对话框的父级
 * 没渲染 ⇒ **界面上什么都不会发生**（连提示都没有）。
 * 只有「阅读页里点导入链接」那条路看起来是好的（用户原话印证：「RSS源，源仓库(官方纯净)，
 * 已经可以页面导入书源了」—— 那正是**阅读页**场景，`r.open === true`）。
 *
 * ⇒ 处理器与对话框搬到**常驻**宿主（挂在 `MainLayout` 里，与 `ReaderOverlay` 平级）。
 * 判据（`classifySchemeImport` / `detectJsonImportType`）仍然**只有一份**，在 `utils/scheme-import.ts`；
 * 本组件只做 IO 与提示 —— 别在任何组件里重写这层判型。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import type { ImportFormatHint } from '../api';
import { toast } from '../toast';
import { useSourcesStore } from '../stores/sources';
import { classifySchemeImport, detectJsonImportType, setSchemeImportHandler } from '../utils/scheme-import';
import ImportReplaceRulesDialog from './ImportReplaceRulesDialog.vue';
import ImportSourcesDialog from './ImportSourcesDialog.vue';

/**
 * `#343` 唤起导入：替换（净化）规则的对话框状态。
 * 显式 replaceRule 链接 ⇒ 喂 URL（对话框 URL 通道自动抓）；determine 判出 replaceRule ⇒ 喂已抓文本。
 */
const replaceImportOpen = ref(false);
const replaceImportText = ref('');
const replaceImportUrl = ref('');
function onReplaceImported(r: { inserted: number; updated: number; skipped: number; failed: number }): void {
  const tail = r.failed ? ` · 失败 ${r.failed}` : '';
  toast(`净化规则已导入：新增 ${r.inserted} · 更新 ${r.updated} · 跳过 ${r.skipped}${tail}`, 'ok');
}

/**
 * `#343` 唤起导入：**书源 / 订阅源**的对话框状态。
 *
 * ★ 用户明确要求（2026-10-08 复测）：「不管是源导入，还是订阅源导入，导入都应有预览
 *   （和恢复备份不同）；现在是静默导入，只发出 toast，而且导入失败」。
 * ⇒ 唤起链接一律**打开导入对话框并走预览**（可看格式/条数/新增·重复/逐条名单），
 *   绝不静默直连 `/api/sources/import`。源导入对话框自己负责预览与提交。
 */
const srcImportOpen = ref(false);
const srcImportUrl = ref('');
const srcImportText = ref('');
/** 唤起链接已判定的格式提示（判出 rssSource 就锁 rss，别锁成 legado 后满屏「缺 bookSourceUrl」） */
const srcImportFormat = ref<ImportFormatHint>('auto');
function onSourcesImported(r: { inserted: number; updated: number; skipped: number; failed: number }): void {
  const tail = r.failed ? ` · 失败 ${r.failed}` : '';
  toast(`源已导入：新增 ${r.inserted} · 更新 ${r.updated} · 跳过 ${r.skipped}${tail}`, 'ok');
  void useSourcesStore().loadMeta(true); // 让源列表/发现页立刻看到新源
}

/** 用 URL 打开「导入源」对话框（预览由对话框内部完成） */
function openSourceImportByUrl(url: string): void {
  srcImportUrl.value = url;
  srcImportText.value = '';
  srcImportFormat.value = 'auto';
  srcImportOpen.value = true;
}

/** 用已抓文本打开「导入源」对话框（determine 通道：我们已下载，避免对话框二次抓取） */
function openSourceImportByText(text: string, format: ImportFormatHint = 'auto'): void {
  srcImportText.value = text;
  srcImportUrl.value = '';
  srcImportFormat.value = format;
  srcImportOpen.value = true;
}

/**
 * `#336`/`#343` 一键导入链接（`legado://` 与 `yuedu://` 等价 —— 上游 Manifest 406-407 双注册）。
 * path/host 归类与 JSON 判型在 `utils/scheme-import.ts`（上游语义唯一实现）；这里只做 IO 与提示。
 */
async function onLegadoUrl(raw: string): Promise<void> {
  const { action, src } = classifySchemeImport(raw);
  switch (action.kind) {
    case 'invalid':
      toast('无法识别的导入链接：' + raw.slice(0, 80), 'error');
      return;
    case 'unsupported':
      toast('链接指向「' + action.label + '」，本仓暂不支持该类型导入', 'warn');
      return;
    case 'replaceRule':
      replaceImportUrl.value = src;
      replaceImportText.value = '';
      replaceImportOpen.value = true;
      return;
    case 'sources':
      // 书源 / 订阅源：**打开导入对话框走预览**（不静默）
      openSourceImportByUrl(src);
      return;
    case 'determine': {
      // 上游 determineType：下载后按 jsonImportType 判型（判型表在 scheme-import.ts）
      let text = '';
      try {
        const res = await fetch('/api/proxy?u=' + encodeURIComponent(src), {
          headers: { accept: 'application/json,text/*,*/*' },
        });
        if (!res.ok) {
          toast('抓取导入地址失败：HTTP ' + res.status, 'error');
          return;
        }
        text = await res.text();
      } catch (e) {
        toast('抓取导入地址失败：' + String(e instanceof Error ? e.message : e), 'error');
        return;
      }
      const t = detectJsonImportType(text);
      if (t === 'bookSource' || t === 'rssSource') {
        /**
         * 已抓文本 ⇒ 直接喂对话框预览（不二次抓取）。格式提示必须**按判型结果**给：
         * 旧实现两种都锁 `legado`，于是导入 Legado 订阅源时对话框停在「Legado 书源」，
         * 每条都报缺 bookSourceUrl、导入 0 条（用户实测）；切到「自动识别」才正常。
         */
        openSourceImportByText(text, t === 'rssSource' ? 'rss' : 'legado');
      } else if (t === 'replaceRule') {
        replaceImportText.value = text;
        replaceImportUrl.value = '';
        replaceImportOpen.value = true;
      } else if (t) {
        toast('链接内容是「' + t + '」，本仓暂不支持该类型导入', 'warn');
      } else {
        toast('无法识别导入内容格式（不是书源/订阅源/净化规则）', 'error');
      }
      return;
    }
  }
}

onMounted(() => setSchemeImportHandler((u) => void onLegadoUrl(u)));
onBeforeUnmount(() => setSchemeImportHandler(null));
</script>

<template>
  <!-- `#343` 唤起导入：legado/yuedu 链接指到替换（净化）规则时复用导入对话框 -->
  <ImportReplaceRulesDialog
    v-if="replaceImportOpen"
    :initial-text="replaceImportText"
    :initial-url="replaceImportUrl"
    @close="replaceImportOpen = false"
    @imported="onReplaceImported"
  />
  <!-- `#343` 唤起导入：书源 / 订阅源 ⇒ 打开导入对话框走**预览**（不静默导入） -->
  <ImportSourcesDialog
    v-if="srcImportOpen"
    :initial-url="srcImportUrl"
    :initial-text="srcImportText"
    :initial-format="srcImportFormat"
    @close="srcImportOpen = false"
    @imported="onSourcesImported"
  />
</template>
