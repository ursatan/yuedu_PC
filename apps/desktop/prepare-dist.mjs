/**
 * electron-builder 打包前准备：把运行所需资源拷入 apps/desktop。
 *  - web-dist/   前端构建产物（服务端 YUEDU_WEB_DIST 指向）
 *  - ~~book-482/~~  已退役（）：开发构建也不再拷源，源只存在于 data/yuedu.db
 *  - cms/        CMS 源目录（历史遗留，仅开发/测试构建清理用，服务端不再读取）
 * server-bundle.mjs / xhr-sync-worker.js 由 build-server.sh 产出。
 *
 * ## ★★ 发布模式（`YUEDU_RELEASE=1`，用户 2026-09-28 明确要求）
 * **发布的 server / web / PC 三端都不得携带任何书源 / 影视源** —— 源只能由用户自己导入或新建
 * （吸取 Legado 的教训：源随包分发会带来法律与维护双重麻烦）。
 * 因此发布模式下：
 *   ① **不拷**源目录；② **主动删掉**上一次开发构建可能残留的 `book-482/` 与 `cms/`
 *      （否则「这次没拷」会被上次的残留悄悄补上 —— 这正是最容易漏的一步）；
 *   ③ 打印醒目提示。
 * 缺源目录是**正常且受支持**的状态：源只从 `data/yuedu.db` 的 `sources` 表读取，
 * 桌面端也不再注入 `YUEDU_BOOK_DIR`/`YUEDU_CMS_DIR` ⇒ 应用照常启动、源列表为空。
 *
 * 用法：
 *   开发构建（默认，带源）  node apps/desktop/prepare-dist.mjs
 *   发布构建（不带任何源）  YUEDU_RELEASE=1 node apps/desktop/prepare-dist.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
/** 发布模式：不携带任何源 */
const RELEASE = ['1', 'true', 'yes'].includes(String(process.env.YUEDU_RELEASE ?? '').toLowerCase());

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * web 前端产物：**每次打包都重新构建**。
 *
 * 早先是「dist 不存在才构建」⇒ 11/9 20:24 构建的旧 dist（还在调 small-* API）
 * 被原样拷进 release-818，而 desktop 侧已换成 float-* ⇒ 实机「歌词窗正常、小窗打不开，
 * 提示 desktop-shell-outdated」。版本一代不一致的坑必须从**构建**这一层堵住。
 */
const webDist = path.join(root, 'apps/web/dist');
execFileSync('pnpm', ['--filter', '@yuedu/web', 'exec', 'vite', 'build'], { cwd: root, stdio: 'inherit', shell: true });
copyDir(webDist, path.join(here, 'web-dist'));

const bookDest = path.join(here, 'book-482');
const cmsDest = path.join(here, 'cms');

if (RELEASE) {
  // ①②：不拷源，并清掉上一次开发构建的残留（不清就等于带源发布）
  let removed = 0;
  for (const d of [bookDest, cmsDest]) {
    if (fs.existsSync(d)) {
      fs.rmSync(d, { recursive: true, force: true });
      removed += 1;
    }
  }
  console.log(
    `打包资源就绪（★ 发布模式）：web-dist 已拷入；**未携带任何源**` +
      (removed ? `（已清掉 ${removed} 处上次开发构建残留）` : ''),
  );
  console.log('  ⚠️ 源由用户自行导入/新建；请确认 server/web/PC 三端产物内都搜不到书源文件。');
} else {
  /**
   * `#651` **开发模式也不再拷源目录**。
   *
   * 源现在只有一处：`data/yuedu.db` 的 `sources` 表；空库时从 `data/seed/bookSource.json`
   * （单个 Legado JSON 数组；**该语料不入库，仅本机自备**）自动铺底。继续拷「1 源 1 文件」目录，等于把已经退役的
   * **第二种存储形态**又带回产物里 —— 那正是「同一个源两处存、两套 id」的来源。
   */
  let cleaned = 0;
  for (const d of [bookDest, cmsDest]) {
    if (fs.existsSync(d)) {
      fs.rmSync(d, { recursive: true, force: true });
      cleaned += 1;
    }
  }
  console.log(
    '打包资源就绪（开发模式）：web-dist 已拷入；**不带任何源文件**' +
      (cleaned ? `（已清掉 ${cleaned} 处旧构建残留的源目录）` : ''),
  );
  console.log('  源由 data/yuedu.db 提供；空库时若本机自备 data/seed/bookSource.json 则自动铺底。');
}
