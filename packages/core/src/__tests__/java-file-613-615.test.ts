/**
 * `#613` / `#615` 回归锁：`java.getFile/readFile/getTxtInFolder` + `unzipFile/getZip*Content`。
 *
 * 上游依据 `JsExtensions.kt:802-925`（文件）与 `:877-995`（zip）。三条硬语义必须照做：
 *   ① **越界路径抛「非法路径」**（上游 `SecurityException`，不给书源任意读文件的能力）；
 *   ② `readFile` 缺失返回 **null**（上游 `ByteArray?`），`readTxtFile` 缺失返回**空串**；
 *   ③ zip 的 `url` 是绝对 URL ⇒ 下载，否则按 **hex** 解码（上游 `HexUtil.decodeHex`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeJavaFileApi, javaFileRoot, resolveJavaFilePath } from '../selector/java-file';
import { createVariableStore } from '../store';
import { makeCacheOps } from '../selector/js';
import { fileCacheKey } from '../selector/js-file';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-java-file-'));
process.env['YUEDU_JAVA_FILE_DIR'] = ROOT;

function api() {
  const vars = createVariableStore();
  return makeJavaFileApi(makeCacheOps(vars) as never, { fetchText: () => '' });
}

test('#613 安全目录：越界路径抛「非法路径」（上游 SecurityException）', () => {
  const a = api();
  assert.throws(() => a.getFile('../../etc/passwd'), /非法路径/);
  assert.throws(() => a.readFile('/../..//etc/shadow'), /非法路径/);
  assert.equal(resolveJavaFilePath('../../etc/passwd'), null);
  // 目录内合法
  const r = resolveJavaFilePath('a/b.txt');
  assert.ok(r && r.abs.startsWith(javaFileRoot()));
});

test('#613 真文件系统：写 → getFile/readFile/readTxtFile 往返', () => {
  const a = api();
  fs.mkdirSync(path.join(ROOT, 'book'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'book', 'a.txt'), '第一章 山雨欲来', 'utf-8');
  const f = a.getFile('book/a.txt') as { exists: () => boolean; getAbsolutePath: () => string; length: () => number };
  assert.equal(f.exists(), true);
  assert.equal(f.getAbsolutePath(), path.join(ROOT, 'book', 'a.txt'));
  assert.ok(f.length() > 0);
  const bytes = a.readFile('book/a.txt');
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes!), '第一章 山雨欲来');
  assert.equal(a.readTxtFile('book/a.txt'), '第一章 山雨欲来');
});

test('#613 文件层（downloadFile 的落点）也能被 readFile 读到（data: URL 形态）', () => {
  const vars = createVariableStore();
  const layer = makeCacheOps(vars) as never;
  const a = makeJavaFileApi(layer, {});
  const key = fileCacheKey('x.bin');
  (layer as unknown as { putFile: (k: string, v: string, t?: number) => void }).putFile(
    key,
    `data:application/octet-stream;base64,${Buffer.from('hello', 'utf-8').toString('base64')}`,
    0,
  );
  const bytes = a.readFile('x.bin');
  assert.equal(new TextDecoder().decode(bytes!), 'hello');
  assert.equal(a.readTxtFile('x.bin'), 'hello');
});

test('#613 缺失语义：readFile → null，readTxtFile → 空串（与上游一致）', () => {
  const a = api();
  assert.equal(a.readFile('nope/missing.txt'), null);
  assert.equal(a.readTxtFile('nope/missing.txt'), '');
});

test('#613 getTxtInFolder：目录内所有文本按 \\n 连接（上游 :907-925）', () => {
  const a = api();
  fs.mkdirSync(path.join(ROOT, 'folder'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'folder', '1.txt'), '一');
  fs.writeFileSync(path.join(ROOT, 'folder', '2.txt'), '二');
  assert.equal(a.getTxtInFolder('folder'), '一\n二');
});

test('#615 getZip*Content：hex 分支（上游 HexUtil.decodeHex）逐条比对 entry.name', () => {
  const a = api();
  // 手造一个最小 zip（STORED，无压缩）——“最小 zip 构造”与 local-book/zip 的解析对拍
  const name = 'inner/a.txt';
  const data = Buffer.from('zip 内的正文', 'utf-8');
  const crc = crc32(data);
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6); // STORED
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  local.write(name, 30, 'utf-8');
  data.copy(local, 30 + name.length);
  const cen = Buffer.alloc(46 + name.length);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(0, 10); // method STORED
  cen.writeUInt16LE(0, 12);
  cen.writeUInt16LE(0, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(0, 42);
  cen.write(name, 46, 'utf-8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  const zip = Buffer.concat([local, cen, eocd]);
  const hex = zip.toString('hex');

  assert.equal(a.getZipStringContent(hex, name), 'zip 内的正文');
  const bytes = a.getZipByteArrayContent(hex, name);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes!), 'zip 内的正文');
  // 条目不存在 ⇒ 空串 / null（不抛）
  assert.equal(a.getZipStringContent(hex, 'inner/nope.txt'), '');
  assert.equal(a.getZipByteArrayContent(hex, 'inner/nope.txt'), null);
});

test('#615 unzipFile：解压到 tmp/<md5Encode16(文件名)>，返回相对路径（上游 :877-886）', () => {
  const a = api();
  // 复用上一条用例的 zip：写到安全目录再解压
  const zipPath = path.join(ROOT, 'pack.zip');
  const name = 'c/t.txt';
  const data = Buffer.from('解压后可见', 'utf-8');
  const crc = crc32(data);
  const mk = (): Buffer => {
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.write(name, 30, 'utf-8');
    data.copy(local, 30 + name.length);
    const cen = Buffer.alloc(46 + name.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.write(name, 46, 'utf-8');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cen.length, 12);
    eocd.writeUInt32LE(local.length, 16);
    return Buffer.concat([local, cen, eocd]);
  };
  fs.writeFileSync(zipPath, mk());
  const rel = a.unzipFile('pack.zip');
  assert.ok(/^tmp[/\\]/.test(rel), `返回值应是相对路径：${rel}`);
  const abs = path.join(ROOT, rel, 'c', 't.txt');
  assert.equal(fs.readFileSync(abs, 'utf-8'), '解压后可见');
  // 解压产物能被 readTxtFile 读到
  assert.equal(a.readTxtFile(`${rel}/c/t.txt`), '解压后可见');
});

test('#615 7z/rar 无解码器 ⇒ 留痕返回空（上游靠 LibArchiveUtils；不静默假装成功）', () => {
  const a = api();
  assert.equal(a.un7zFile('a.7z'), '');
  assert.equal(a.unrarFile('a.rar'), '');
});

/** CRC32（zip 必须；与 local-book/zip 的校验同源算法） */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] as number;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
