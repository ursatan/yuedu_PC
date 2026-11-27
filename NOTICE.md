# NOTICE —— 协议与来源说明

## 本项目协议

**GNU General Public License v3.0**（GPL-3.0），完整协议文本见 [LICENSE](./LICENSE)。

## 为什么是 GPL-3.0

本项目是 **Legado（阅读）** 的**移植与再实现**：书源解析的规则语义、字段契约与大量行为细节
（`AnalyzeRule` / `AnalyzeUrl` / `BookInfo` / `BookChapterList` 的求值顺序、`SourceRule` 的
`mode` 判定、`@put`/`@get`/`{{}}` 的作用域、jsoup 选择器兼容层等）都以 Legado 的实现为准绳**逐条对齐**——
例如「`@get:{k}` 与 `java.get(k)` 是同一条链」这类语义，是逐行读上游源码定下来的。

> 上游源码**不随本仓库分发**（2026-09-28 起）：此前放在 `docs/ref/legado-src/` 的 6 个 `.kt` 摘录已移除。
> 对照语义请直接读 `F:\legado`（或自行克隆上游）。
> 即便如此，本仓仍以 **GPL-3.0** 发布 —— 移植自 GPL 项目的派生作品同样受 GPL 约束；
> 采用**更保守**的一侧，既合规也尊重上游作者。

对 `"license"` 字段的取值说明：上游只在 `LICENSE` 里给出 GPLv3 全文，未见「or any later version」
的表述，因此本仓取 **GPL-3.0-only**。

## 上游致谢

| 项目 | 说明 |
|---|---|
| **Legado（阅读）** | Android 小说阅读器，书源规则引擎的语义来源 <https://github.com/gedoor/legado> |
| **byl669/legado-lyrics-overlay** | 朗读桌面歌词悬浮窗（Android `TYPE_APPLICATION_OVERLAY`）的**显隐门槛 / 三段式布局 / 文字恒不透明**设计参考 <https://github.com/byl669/legado-lyrics-overlay>（GPL-3.0）。本仓只在 Electron 外壳里以独立 `BrowserWindow` 重实现，未拷贝其 `--el-*` 样式；见 `apps/desktop/lyrics.js`、`lyrics.html`、`lyrics-preload.js` 文件头注释 |
| **jsoup** | HTML 解析与选择器；本仓的 `jsoup-select` 兼容层按 1.16.2 的 `Evaluator` 语义逐条对齐 |
| **apple-cms 生态** | 影视源（CMS）采集接口的事实标准（本仓 `engine-maccms`） |

## ⚠️ 本仓库**不携带任何源**（源由用户自己导入/新建）

**用户的明确要求（2026-09-28 制定，2026-11-26 收紧）**：

- **源语料不入库**：书源 / 漫画源 / 影视源 / RSS 订阅源的**任何规则文件**——
  `data/seed/` 下的 `bookSource.json` / `rssSource.json`、`data/jslib-mirror/` 里的第三方脚本镜像、
  以及测试里抓取的源规则快照——**一律不进公开仓库**；本地自备，按需自行导入。
- 源**只能由用户自己导入或新建**（吸取 Legado 的教训：源随包分发会带来法律与维护双重麻烦）。

> 历史：2026-09-28 的策略是「开发期源照常入库、发版才清」。仓库转为公开后该策略作废 ——
> 源语料是第三方站点规则/订阅的转载集，公开仓库不得携带，故已整体 `git rm --cached`
> （**本地文件保留**），并由 `.gitignore` 拦住回流；需要语料时在本机自行准备。

`data/yuedu.db` 仍是源运行时唯一存储（不入库）；空库时若本地存在 `data/seed/bookSource.json`
会自动铺底，缺失则**空库启动并告警**（见 `apps/server/src/index.ts` 的种子导入段）。

### 发布前的清源动作（桌面打包已自动化）

```bash
# 开发/测试构建（带源）
node apps/desktop/prepare-dist.mjs

# ★ 发布构建（不带任何源）
YUEDU_RELEASE=1 node apps/desktop/prepare-dist.mjs
```

`YUEDU_RELEASE=1` 时 `prepare-dist.mjs` 会：① **不拷**源目录；② **主动删掉**上一次开发构建
可能残留的 `apps/desktop/book-482/` 与 `apps/desktop/cms/`（不清就等于带源发布）；
③ 打印醒目提示。

**缺源目录是受支持的状态**：`hub.loadDir()` 对不存在的目录返回 `[]`（`hub.ts:310`），
`main.js:158` 也只在目录存在时才设 `YUEDU_BOOK_DIR`/`YUEDU_CMS_DIR` ⇒ 应用照常启动，源列表为空。

> 发版检查：产物目录里 `grep -rl "bookSourceName" .` 应为空 —— 这个字符串只出现在源文件里。

> 注：源本身**不是**本项目的著作权客体（是从公开站点采集/网友分享的规则数据）。
> 不在发布版里带源，既是为了减小体积与法律风险，也是为了**不替用户决定他用哪些源**。

**发版前必须自检**（`#153`）：产物目录用发布模式生成后跑

```bash
pnpm check:release          # = node scripts/check-release-clean.mjs
```

必须 **exit 0**。该检查第一次运行就抓到过 `apps/desktop/release/win-unpacked/resources/book-482`
里有 **477 个源** —— 一个**已经打出来的包带着源**。完整发版清单属内部开发文档，不随公开仓库分发。
