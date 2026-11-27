/**
 * **`#639`（2026-10-26）**：`,{options}` 尾巴解析**不能**对整条选项串做 `decodeURIComponent`。
 *
 * ## 真站取证（书旗听书本地源（同人），用户实测第 4 条）
 * jsLib 的 `SQ_LISTEN_LIVE_REQUESTS` 里预置了**已经 percent-encoded 的 base64 密文**：
 * ```js
 * body = "data=Oy5Sv6oXIdjwjTsAt2H73m7%2BN9fEVyuETUa8ThZy%2BEYKmnXNt8oQLkV…%2FAT…"
 * url  = "https://ocean.shuqireader.com/api/bcscategory/categoryPrefer/update,{"method":"POST","body":…}"
 * ```
 * 旧实现「只要尾巴里出现 `%XX` 就整体 `decodeURIComponent`」⇒ 密文里的 `%2B`/`%2F` 被还原成
 * `+`/`/` ⇒ **form-urlencoded 语义下 `+` 就是空格** ⇒ 站点解出的密文全坏：
 *   · 引擎发出 `…m7+N9f…` → `500 {"message":"syntax error, po…"}`
 *   · curl 原样 `…m7%2BN9f…`   → `200` + 31KB 真书单
 *
 * 正确判据：尾巴**本身是合法 JSON** 时，里面的 `%XX` 属于**字符串值内部**（作者的数据），必须原样保留；
 * 只有整条尾巴被编码过（`%7B%22…`）时原样解析会失败 —— 那时才 decode。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareUrl } from '../net/url-prep';

const BODY = 'data=Oy5Sv6oXIdjwjTsAt2H73m7%2BN9fEVyuETUa8ThZy%2BEYKmnXNt8oQLkVblmmJ5%2FoW648vOQETKTy';

test('字典型尾巴：body 里的 %2B / %2F 必须原样保留', () => {
  const raw = `https://ocean.shuqireader.com/api/x?_reqid=1,${JSON.stringify({ method: 'POST', body: BODY })}`;
  const out = prepareUrl(raw);
  assert.equal(out.option?.['body'], BODY);
  assert.equal(out.option?.['method'], 'POST');
  assert.equal(out.url, 'https://ocean.shuqireader.com/api/x?_reqid=1');
});

test('整条尾巴被百分号编码时仍能解析（decode 作为兜底保留）', () => {
  const opt = JSON.stringify({ method: 'POST', body: 'a=1&b=2' });
  const encoded = encodeURIComponent(opt);
  const raw = `https://e.test/api,${encoded}`;
  const out = prepareUrl(raw);
  assert.equal(out.option?.['method'], 'POST');
  assert.equal(out.option?.['body'], 'a=1&b=2');
});

test('无 %XX 的普通尾巴照旧（零影响）', () => {
  const raw = 'https://e.test/api,{"method":"POST","body":"k=v"}';
  const out = prepareUrl(raw);
  assert.equal(out.option?.['body'], 'k=v');
});
