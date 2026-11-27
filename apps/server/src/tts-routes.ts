/**
 * `#820` **TTS HTTP 路由**（B2 第一批；UI 留给后续会话）。
 *
 * 接口面（6 条，全部服务端）：
 * ```
 * GET    /api/tts/config      全局开关 + 默认引擎 + 引擎表（带 jsRule 标记，供 UI 默认折叠）
 * PUT    /api/tts/config      改全局开关 / 默认引擎
 * PUT    /api/tts/engines     新增或覆盖一条引擎（校验在 store → core，路由不重复判）
 * DELETE /api/tts/engines     删一条（默认引擎一并清空）
 * POST   /api/tts/segment     正文 → 朗读分段（纯逻辑，不出站）
 * POST   /api/tts/speak       一段文字 → 音频字节（失败带稳定 code）
 * ```
 * 「默认关」在这里的落点：`GET /api/tts/config` 首次就是 `{enabled:false, engines:[]}`；
 * `speak` 在全局关/引擎关/没选引擎时分别回 `TTS_DISABLED` / `TTS_ENGINE_DISABLED` / `TTS_ENGINE_NOT_FOUND`。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import { hasTtsSecondaryVoice, isTtsJsRule, segmentTtsText } from '@yuedu/core';

import type { TtsService } from './tts-service';
import type { TtsStore } from './tts-store';
import { EdgeTtsError, listEdgeVoices, synthesizeEdge } from './edge-tts';

export interface TtsRouteDeps {
  store: TtsStore;
  service: TtsService;
}

/** 失败包（与 `/api/run` 的 `{error:{code,message,detail}}` 同形） */
function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  detail?: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message, ...(detail ? { detail } : {}) } });
}

export function registerTtsRoutes(app: FastifyInstance, deps: TtsRouteDeps): void {
  app.get('/api/tts/config', async () => {
    const cfg = deps.store.read();
    return {
      enabled: cfg.enabled,
      // `#821` 双音色（默认关）：前端据此显示开关与主/副槽选择
      dualVoice: cfg.dualVoice,
      activeVoice: cfg.activeVoice,
      defaultEngineId: cfg.defaultEngineId,
      engines: cfg.engines.map((e) => ({
        ...e,
        jsRule: isTtsJsRule(e.url),
        hasSecondary: hasTtsSecondaryVoice(e),
      })),
    };
  });

  app.put<{ Body: { enabled?: unknown; defaultEngineId?: unknown; dualVoice?: unknown; activeVoice?: unknown } }>(
    '/api/tts/config',
    async (req, reply) => {
      const r = deps.store.setSettings(req.body ?? {});
      if (!r.ok) {
        const message = r.error === 'DEFAULT_ENGINE_NOT_FOUND'
          ? '默认引擎不存在（先保存引擎再选）'
          : r.error === 'VOICE_SLOT_INVALID'
            ? '音色槽只能是 primary 或 secondary'
            : '配置不合法';
        return sendError(reply, 400, r.error, message);
      }
      return {
        ok: true,
        config: {
          ...r.config,
          engines: r.config.engines.map((e) => ({
            ...e,
            jsRule: isTtsJsRule(e.url),
            hasSecondary: hasTtsSecondaryVoice(e),
          })),
        },
      };
    },
  );

  app.put<{ Body: Record<string, unknown> }>('/api/tts/engines', async (req, reply) => {
    const r = deps.store.upsertEngine(req.body ?? {});
    if (!r.ok) {
      // 校验码（NAME_REQUIRED / URL_INVALID / HEADER_INVALID…）原样回给界面
      return sendError(reply, 400, r.error, r.message);
    }
    console.log(`[yuedu] TTS 引擎已保存：${r.engine.name}（enabled=${r.engine.enabled}）`);
    return {
      ok: true,
      engine: r.engine,
      jsRule: isTtsJsRule(r.engine.url),
      hasSecondary: hasTtsSecondaryVoice(r.engine),
    };
  });

  app.delete<{ Querystring: { id?: string } }>('/api/tts/engines', async (req, reply) => {
    const id = String(req.query?.id ?? '').trim();
    if (!id) return sendError(reply, 400, 'TTS_ENGINE_NOT_FOUND', '缺少 id');
    const ok = deps.store.removeEngine(id);
    if (!ok) return sendError(reply, 404, 'TTS_ENGINE_NOT_FOUND', `引擎不存在：${id}`);
    // `#873` 连带清掉该引擎的 Cookie 罐/节奏状态（本地删除不依赖引擎在线）
    deps.service.forgetEngine(id);
    return { ok: true };
  });

  app.post<{ Body: { text?: unknown; maxChars?: unknown } }>('/api/tts/segment', async (req, reply) => {
    const r = segmentTtsText(String(req.body?.text ?? ''), { maxChars: Number(req.body?.maxChars) });
    if (!r.ok) {
      return sendError(reply, r.code === 'TTS_TEXT_TOO_LONG' ? 413 : 400, r.code, r.message);
    }
    return { ok: true, count: r.segments.length, segments: r.segments };
  });

  app.post<{
    Body: { engineId?: unknown; text?: unknown; speed?: unknown };
  }>('/api/tts/speak', async (req, reply) => {
    const out = await deps.service.speak({
      engineId: req.body?.engineId,
      text: req.body?.text,
      speed: req.body?.speed,
    });
    if (!out.ok) return sendError(reply, out.status, out.code, out.message, out.detail);
    return reply
      .header('content-type', out.contentType)
      // `#821` 实际用的槽位（副槽缺失回退时 x-tts-fellback=1），便于实测/排查
      .header('x-tts-voice-slot', out.voiceSlot)
      .header('x-tts-fellback', out.fellBack ? '1' : '0')
      // 合成结果不缓存（同一段文字每次音色/签名都可能不同）
      .header('cache-control', 'no-store')
      .send(out.audio);
  });

  // -------------------------------------------------------------------------
  // 内置 Edge 在线音色（免 Key、需联网；不依赖上面的 TTS 引擎开关）
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { refresh?: string } }>('/api/tts/edge/voices', async (req, reply) => {
    try {
      const result = await listEdgeVoices(req.query?.refresh === '1');
      return { ok: true, cachedAt: result.cachedAt, voices: result.voices };
    } catch (error) {
      if (error instanceof EdgeTtsError) return sendError(reply, error.status, error.code, error.message);
      return sendError(reply, 502, 'TTS_EDGE_OFFLINE', 'Edge 音色列表获取失败');
    }
  });

  app.post<{ Body: { text?: unknown; voice?: unknown; speed?: unknown } }>(
    '/api/tts/edge/speak',
    async (req, reply) => {
      const speed = Number(req.body?.speed);
      try {
        const audio = await synthesizeEdge({
          text: String(req.body?.text ?? ''),
          voice: String(req.body?.voice ?? ''),
          speed: Number.isFinite(speed) ? speed : 1,
        });
        return reply
          .header('content-type', 'audio/mpeg')
          .header('x-tts-engine', 'edge')
          .header('cache-control', 'no-store')
          .send(audio);
      } catch (error) {
        if (error instanceof EdgeTtsError) return sendError(reply, error.status, error.code, error.message);
        return sendError(reply, 502, 'TTS_EDGE_NETWORK', 'Edge 在线音色合成失败');
      }
    },
  );
}
