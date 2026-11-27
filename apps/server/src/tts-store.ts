/**
 * `#820` **TTS 引擎配置存储**（`data/tts-engines.json`）。
 *
 * 为什么独立文件（不塞 `kv.json` / 不塞源定义 / 不塞用户快照）：
 *  · 引擎配置里**可能有 API Key**（`header: "Authorization: Bearer …"`）——
 *    用户 2026-11-06 明确「引擎 Key 不得进备份 ZIP」；本仓备份走**用户快照**（`user-snapshot.ts`），
 *    独立数据文件天然不进快照，不会被打包外发；
 *  · 与源定义分离：导入别人的源不该把「我的 TTS Key」带过来，反之亦然（同 `#568` 的纪律）。
 *
 * 写入纪律：**先写临时文件再 rename**（进程被杀不会留下半截 JSON 把整表读空）。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeTtsConfigFile,
  normalizeTtsEngine,
  normalizeTtsSettings,
  type TtsConfigFile,
  type TtsEngineConfig,
} from '@yuedu/core';

export interface TtsStore {
  /** 当前全量（只读副本；调用方改不动内部缓存） */
  read(): TtsConfigFile;
  /** 按 id（或 name+url 推出的稳定 id）取一条 */
  findEngine(id: string): TtsEngineConfig | null;
  /** 新增/覆盖一条；校验在 core 的唯一入口做，路由不重复判 */
  upsertEngine(input: unknown): { ok: true; engine: TtsEngineConfig } | { ok: false; error: string; message: string };
  /** 删除一条（不存在 ⇒ false）；若它是默认引擎，默认一并清空 */
  removeEngine(id: unknown): boolean;
  /** 全局开关 / 默认引擎（两者都可单独更新） */
  setSettings(patch: unknown): { ok: true; config: TtsConfigFile } | { ok: false; error: string };
}

function readJson(file: string): TtsConfigFile {
  try {
    return normalizeTtsConfigFile(JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown);
  } catch {
    // 文件不存在/损坏：都按「什么都没配」起（= 默认关；损坏文件保留给人工修复，下次保存会覆盖）
    return normalizeTtsConfigFile(null);
  }
}

export function createTtsStore(file: string): TtsStore {
  let cache: TtsConfigFile | null = null;
  const load = (): TtsConfigFile => {
    if (!cache) cache = readJson(file);
    return cache;
  };
  const persist = (next: TtsConfigFile): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    cache = next;
  };

  return {
    read() {
      const cur = load();
      return {
        enabled: cur.enabled,
        dualVoice: cur.dualVoice,
        activeVoice: cur.activeVoice,
        defaultEngineId: cur.defaultEngineId,
        engines: cur.engines.map((e) => ({
          ...e,
          ...(e.secondary ? { secondary: { ...e.secondary } } : {}),
        })),
      };
    },
    findEngine(id) {
      const key = String(id ?? '').trim();
      if (!key) return null;
      const found = load().engines.find((e) => e.id === key);
      return found
        ? { ...found, ...(found.secondary ? { secondary: { ...found.secondary } } : {}) }
        : null;
    },
    upsertEngine(input) {
      const cur = load();
      // 允许「只给 name+url 更新已有条目」：先按 id 找，找不到再按稳定 id 找
      const idRaw = (input && typeof input === 'object' && !Array.isArray(input))
        ? String((input as TtsEngineConfig).id ?? '').trim()
        : '';
      const existing = idRaw ? cur.engines.find((e) => e.id === idRaw) ?? null : null;
      const r = normalizeTtsEngine(input, existing);
      if (!r.ok) return { ok: false, error: r.error, message: r.message };
      const engine: TtsEngineConfig = { ...r.engine, updatedAt: Date.now() };
      const rest = cur.engines.filter((e) => e.id !== engine.id);
      persist({ ...cur, engines: [...rest, engine] });
      return { ok: true, engine };
    },
    removeEngine(id) {
      const key = String(id ?? '').trim();
      if (!key) return false;
      const cur = load();
      const next = cur.engines.filter((e) => e.id !== key);
      if (next.length === cur.engines.length) return false;
      persist({
        ...cur,
        engines: next,
        defaultEngineId: cur.defaultEngineId === key ? '' : cur.defaultEngineId,
      });
      return true;
    },
    setSettings(patch) {
      const cur = load();
      const r = normalizeTtsSettings(patch, cur);
      if (!r.ok) return { ok: false, error: r.error };
      persist(r.config);
      return { ok: true, config: r.config };
    },
  };
}
