/**
 * `#873` **TTS 引擎级 Cookie 罐**（对齐 Legado `HttpTTS.enabledCookieJar`）。
 *
 * 上游的语义是「该引擎共享一份 Cookie（登录态可复用）」；本仓还没有 TTS 登录窗，
 * 所以这里先实现可验证的那一半：
 *  · 把每次合成响应里的 `Set-Cookie` 收进**按引擎隔离**的罐；
 *  · 罐是**显式开启**（`enabledCookieJar: true`）才读写，默认关、不串引擎；
 *  · 落盘 `data/tts-cookies.json`（`tmp` + `rename` 原子写），重启后登录态仍在。
 *
 * 不做的部分（见差距清单）：`loginUrl` 的 WebView 登录流程、`loginUi` 表单渲染。
 */
import fs from 'node:fs';
import path from 'node:path';

interface JarFile {
  version: 1;
  jars: Record<string, Record<string, string>>;
}

const MAX_COOKIES = 40;
const MAX_VALUE = 2048;

export interface TtsCookieJar {
  /** 取该引擎的 Cookie 头值（`a=1; b=2`）；没有返回空串 */
  header(engineId: string): string;
  /** 收一条响应（`set-cookie` 可能是多行/多段） */
  absorb(engineId: string, setCookie: string): void;
  /** 清空某引擎（删引擎时调用，避免同 id 重新导入继承旧登录态） */
  clear(engineId: string): void;
}

function parseFile(raw: string): JarFile {
  try {
    const j = JSON.parse(raw) as Partial<JarFile>;
    if (!j || typeof j !== 'object' || !j.jars || typeof j.jars !== 'object') throw new Error('bad');
    return { version: 1, jars: j.jars as Record<string, Record<string, string>> };
  } catch {
    return { version: 1, jars: {} };
  }
}

/** `Set-Cookie` → 名字/值；`Max-Age=0` 或过期清空视为删除 */
function parseSetCookie(line: string): { name: string; value: string; remove: boolean } | null {
  const first = line.split(';')[0]?.trim() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name || name.length > 64) return null;
  const lower = line.toLowerCase();
  const remove = /max-age\s*=\s*0(?![0-9])/.test(lower)
    || /expires\s*=\s*thu,?\s*01\s*jan\s*1970/.test(lower);
  return { name, value: value.slice(0, MAX_VALUE), remove };
}

export function createTtsCookieJar(file?: string): TtsCookieJar {
  let data: JarFile | null = null;

  const load = (): JarFile => {
    if (data) return data;
    data = file && fs.existsSync(file) ? parseFile(fs.readFileSync(file, 'utf8')) : { version: 1, jars: {} };
    return data;
  };

  const save = (): void => {
    if (!file || !data) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      /* 落盘失败不影响朗读（内存里仍然有效） */
    }
  };

  return {
    header(engineId) {
      const jar = load().jars[engineId];
      if (!jar) return '';
      return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    },

    absorb(engineId, setCookie) {
      if (!setCookie) return;
      const jar = { ...(load().jars[engineId] ?? {}) };
      let touched = false;
      for (const line of setCookie.split(/\r?\n/)) {
        const c = parseSetCookie(line);
        if (!c) continue;
        if (c.remove) {
          if (jar[c.name] != undefined) {
            delete jar[c.name];
            touched = true;
          }
          continue;
        }
        if (jar[c.name] !== c.value) {
          jar[c.name] = c.value;
          touched = true;
        }
      }
      if (!touched) return;
      const names = Object.keys(jar);
      if (names.length > MAX_COOKIES) {
        for (const n of names.slice(0, names.length - MAX_COOKIES)) delete jar[n];
      }
      data = { version: 1, jars: { ...load().jars, [engineId]: jar } };
      save();
    },

    clear(engineId) {
      const jars = load().jars;
      if (!jars[engineId]) return;
      const next = { ...jars };
      delete next[engineId];
      data = { version: 1, jars: next };
      save();
    },
  };
}

/** 合并 Cookie 头：配置里的显式 Cookie 优先，罐里只补缺 */
export function mergeCookieHeader(explicit: string, jar: string): string {
  if (!jar) return explicit;
  if (!explicit) return jar;
  const seen = new Set(
    explicit.split(';').map((s) => s.split('=')[0]?.trim().toLowerCase()).filter(Boolean),
  );
  const extra = jar
    .split(';')
    .map((s) => s.trim())
    .filter((s) => {
      const name = s.split('=')[0]?.trim().toLowerCase();
      return name && !seen.has(name);
    });
  return extra.length ? `${explicit}; ${extra.join('; ')}` : explicit;
}

/** 在头对象上取/写 `Cookie`（大小写不敏感） */
export function setCookieHeader(headers: Record<string, string>, value: string): Record<string, string> {
  if (!value) return headers;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'cookie') return { ...headers, [k]: value };
  }
  return { ...headers, Cookie: value };
}
