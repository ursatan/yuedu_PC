/**
 * 宽松 JSON 解析（对齐 Legado 的两级回落：`GSONStrict` 失败 → 宽松 `GSON`）。
 *
 * 用途：源规则里的 `,{...}` 请求选项、`header` 规则、`@put:{...}` 这类**手写 JSON**，
 * 普遍存在「无引号键/值、单引号、尾逗号」。
 *
 * ⚠️ **不能拿 `eval('(' + s + ')')` 当兜底**（2026-09-16 修，实测源：悦读小说）：
 * JS 字符串字面量会**吃掉未知转义的反斜杠** —— 选项体
 * `"body":"bookId={{baseUrl.match(/(\d+)/)[1]}}"` 里的 `\d` 变成 `d`，
 * 正则从 `/(\d+)/` 静默退化成 `/(d+)/`，`baseUrl.match(...)[1]` 于是取到 `'d'`
 * （匹配到 `hareading` 里的那个 d），POST body 变成 `bookId=d`
 * → 站点返回 `[]` → **目录 0 章**。
 * 正确语义是「未知转义原样保留」——JSON 里 `\d` 是非法转义，但宽松解析必须把它当两个字符。
 */

/** JSON 合法转义字符；其余 `\X` 一律补成 `\\X`（保留反斜杠，而不是让 JS 吃掉它） */
function fixJsonEscapes(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) {
      out += '\\\\';
      continue;
    }
    if ('"\\/bfnrtu'.includes(next)) {
      out += c + next;
      i++;
      continue;
    }
    out += '\\\\' + next; // 非法转义 → 原样保留反斜杠
    i++;
  }
  return out;
}

const WS = /\s/;

/** 宽松 tokenizer：解析对象/数组/字符串/裸值（无引号键与值、单引号、尾逗号、注释） */
function looseParse(text: string): unknown {
  let i = 0;
  const n = text.length;

  const skipWs = (): void => {
    while (i < n) {
      const c = text[i]!;
      if (WS.test(c)) {
        i++;
        continue;
      }
      if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      break;
    }
  };

  const parseString = (q: string): string => {
    i++; // 开引号
    let out = '';
    while (i < n) {
      const c = text[i]!;
      if (c === '\\') {
        const next = text[i + 1];
        if (next === undefined) break;
        if (next === 'u') {
          const hex = text.slice(i + 2, i + 6);
          out += String.fromCharCode(parseInt(hex, 16) || 0);
          i += 6;
          continue;
        }
        const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
        out += map[next] ?? next; // 未知转义：保留字符本身
        i += 2;
        continue;
      }
      if (c === q) {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    return out;
  };

  const parseBare = (): unknown => {
    let raw = '';
    while (i < n) {
      const c = text[i]!;
      if (c === ',' || c === '}' || c === ']') break;
      raw += c;
      i++;
    }
    const t = raw.trim();
    if (t === '') return '';
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || t === 'undefined') return null;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
    return t;
  };

  const parseKey = (): string => {
    skipWs();
    const c = text[i];
    if (c === '"' || c === "'") return parseString(c);
    let raw = '';
    while (i < n && text[i] !== ':' && text[i] !== '}' && text[i] !== ',') {
      raw += text[i]!;
      i++;
    }
    return raw.trim();
  };

  const parseValue = (): unknown => {
    skipWs();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"' || c === "'") return parseString(c);
    return parseBare();
  };

  const parseObject = (): unknown => {
    i++; // {
    const out: Record<string, unknown> = {};
    for (;;) {
      skipWs();
      if (i >= n) break;
      if (text[i] === '}') {
        i++;
        break;
      }
      if (text[i] === ',') {
        i++;
        continue;
      }
      const k = parseKey();
      skipWs();
      if (text[i] === ':') i++;
      const v = parseValue();
      if (k !== '') out[k] = v;
      skipWs();
      if (text[i] === ',') i++;
      else if (text[i] === '}') {
        i++;
        break;
      }
    }
    return out;
  };

  const parseArray = (): unknown => {
    i++; // [
    const out: unknown[] = [];
    for (;;) {
      skipWs();
      if (i >= n) break;
      if (text[i] === ']') {
        i++;
        break;
      }
      if (text[i] === ',') {
        i++;
        continue;
      }
      out.push(parseValue());
      skipWs();
      if (text[i] === ',') i++;
      else if (text[i] === ']') {
        i++;
        break;
      }
    }
    return out;
  };

  skipWs();
  return parseValue();
}

/**
 * 宽松解析 JSON 文本。三级回落：
 *  ① `JSON.parse`（标准）；
 *  ② `JSON.parse` + 非法转义修复（处理 `\d` 这类**只差转义**的文本）；
 *  ③ 自研 tokenizer（无引号键/值、单引号、尾逗号、注释）。
 * 全部失败返回 `undefined`（调用方自行决定兜底）。
 */
export function parseJsonLoose(text: string): unknown {
  const s = text.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* 继续 */
  }
  try {
    return JSON.parse(fixJsonEscapes(s));
  } catch {
    /* 继续 */
  }
  try {
    return looseParse(s);
  } catch {
    return undefined;
  }
}

/** 同 `parseJsonLoose`，但要求结果是普通对象（否则 undefined） */
export function parseJsonLooseObject(text: string): Record<string, unknown> | undefined {
  const v = parseJsonLoose(text);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
