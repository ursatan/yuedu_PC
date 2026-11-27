/**
 * `#627` **远端字体失效 → 本地字体回落**（只作用于网页壳，不改全局字体）。
 *
 * ## 背景（用户实测）
 * 爱丽丝相关书源的「正确字体」由源规则生成：`ruleContent` 里的
 * `java.replaceFont(..., java.queryTTF("https://alanskycn.gitee.io/.../Source Han Sans CN Regular.ttf"))`
 * ⇒ 页面 CSS 里出现 `@font-face{src:url(http…)`。该远端地址如今返回 **HTML**（不是 ttf），
 * 浏览器解码失败 ⇒ 该 family 不可用 ⇒ 正文回落到浏览器默认衬线/方框。
 *
 * 本仓前端**不能**改源规则（`packages/**` / `data/**` 本轮禁写），也**不打包**来源不明的字体，
 * 所以只能做显示层兜底：
 *  ① 静态扫描正文里 `@font-face` 的**远程** `src`（`http(s)://` 或协议相对 `//`），
 *     命中才注入（普通正文 / 图集一个字都不加 ⇒ 其它页面视觉零变化）；
 *  ② 壳内等 `document.fonts.ready` 后用 **FontFace.status === 'error'** 判定哪些 family
 *     真的加载失败（不是「没声明」、不是「还在加载」）；
 *  ③ 对失败 family：追加一份**只含 `local()` 来源**的 `@font-face`（绝不引用远端 URL），
 *     并把**用到该 family 的元素**内联改成系统字体栈 —— 图标字体等自有一族的元素不受影响。
 *
 * ## 为什么不用「全局 body{font-family:…}」
 * 那会把 `<i class="fa">` 之类图标字体一起覆盖成豆腐块；判据必须落在**元素实际用到的
 * family** 上，所以逐个元素检查 computed `font-family` 再改。
 */

/** 本地/系统字体栈（**只在这里维护一份**；不引用任何网络地址） */
export const LOCAL_FONT_FALLBACK_STACK =
  '"Kaiti SC","STKaiti","KaiTi","楷体","Songti SC","SimSun","宋体","Source Han Sans CN","Source Han Sans SC","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei","PingFang SC","Hiragino Sans GB",serif';

/** 本地候选（`local()` 查找的是**本机已装字体**的全名/PostScript 名；找不到就顺延） */
const LOCAL_FONT_SRC = [
  'local("Kaiti SC")',
  'local("STKaiti")',
  'local("KaiTi")',
  'local("楷体")',
  'local("Songti SC")',
  'local("SimSun")',
  'local("宋体")',
  'local("Microsoft YaHei")',
  'local("微软雅黑")',
  'local("PingFang SC")',
  'local("Noto Sans CJK SC")',
  'local("Source Han Sans CN")',
  'local("Source Han Serif CN")',
  'local("Heiti SC")',
].join(',');

/**
 * 扫描正文（含内联 `<style>`）里声明了**远程**字体的 family 名。
 *
 * 只认 `@font-face{…src:url(http(s)://… 或 //…)}`：`data:` 内联字体、纯 `local()`
 * 都是可用的，不需要兜底；远程失败才是本条的缺陷面。
 */
export function extractRemoteFontFamilies(html: string): string[] {
  const out: string[] = [];
  const src = String(html ?? '');
  if (!src) return out;
  // 去掉 HTML/CSS 注释，避免注释里的示例 @font-face 被当成真规则
  const cleaned = src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const faceRe = /@font-face\s*\{([\s\S]*?)\}/gi;
  let m: RegExpExecArray | null;
  while ((m = faceRe.exec(cleaned)) !== null) {
    const body = m[1] ?? '';
    // src 里有远程 URL 才算「可能失效」；多来源任一命中即可
    if (!/src\s*:[^;}]*url\(\s*["']?\s*(?:https?:)?\/\//i.test(body)) continue;
    const fm = /font-family\s*:\s*([^;}]+)/i.exec(body);
    if (!fm) continue;
    const raw = (fm[1] ?? '').split(',')[0] ?? '';
    const name = raw.trim().replace(/^["']|["']$/g, '').trim();
    if (!name || name.length > 80 || /\s*var\(/i.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** 失败 family → 「只用本地字体」的 `@font-face`（可测；不含任何 http 地址） */
export function fontFallbackCss(families: ReadonlyArray<string>): string {
  return families
    .filter((f) => typeof f === 'string' && f.trim())
    .map((f) => `@font-face{font-family:${JSON.stringify(f)};src:${LOCAL_FONT_SRC}}`)
    .join('');
}

/**
 * 壳内回落脚本。
 *
 * ⚠️ 与其它壳层桥同一条纪律：生成文本里**不能出现反引号与字面 `</script>`**
 * （srcdoc 直接拼接）。
 */
export function fontFallbackScript(families: ReadonlyArray<string>): string {
  const names = families.filter((f) => typeof f === 'string' && f.trim());
  const ALIAS: Record<string, string> = {};
  for (const f of names) ALIAS[f] = `@font-face{font-family:${JSON.stringify(f)};src:${LOCAL_FONT_SRC}}`;
  return [
    '(function(){',
    'var FAM=' + JSON.stringify(names) + ';',
    'var STACK=' + JSON.stringify(LOCAL_FONT_FALLBACK_STACK) + ';',
    'var ALIAS=' + JSON.stringify(ALIAS) + ';',
    'var BAD=[];',
    'function mark(){ try{ document.documentElement.setAttribute("data-yuedu-font-fallback", BAD.join(",")); }catch(e){} }',
    'function addCss(){',
    '  if(!BAD.length) return;',
    '  try{',
    '    var st=document.getElementById("yuedu-font-fallback");',
    '    if(!st){ st=document.createElement("style"); st.id="yuedu-font-fallback"; (document.head||document.documentElement).appendChild(st); }',
    '    var css=""; for(var i=0;i<BAD.length;i++){ css+=(ALIAS[BAD[i]]||""); }',
    '    st.textContent=css;',
    '  }catch(e){}',
    '}',
    'function rewrite(){',
    '  if(!BAD.length) return;',
    '  try{',
    '    var els=[document.body];',
    '    var all=document.body?document.body.querySelectorAll("*"):[];',
    '    for(var i=0;i<all.length;i++) els.push(all[i]);',
    '    for(var j=0;j<els.length;j++){',
    '      var el=els[j]; if(!el||!el.style) continue;',
    '      var ff="";',
    '      try{ ff=window.getComputedStyle(el).fontFamily||""; }catch(e){ continue; }',
    '      for(var k=0;k<BAD.length;k++){',
    '        if(ff.indexOf(BAD[k])>=0){ el.style.setProperty("font-family",STACK,"important"); break; }',
    '      }',
    '    }',
    '  }catch(e){}',
    '}',
    'function detect(){',
    '  var bad=[];',
    '  try{',
    '    if(document.fonts && document.fonts.forEach){',
    '      document.fonts.forEach(function(f){',
    '        try{',
    '          if(f && f.status==="error"){',
    '            var n=String(f.family||"").replace(/["\']/g,"").trim();',
    '            if(n && FAM.indexOf(n)>=0 && bad.indexOf(n)<0) bad.push(n);',
    '          }',
    '        }catch(e){}',
    '      });',
    '    }',
    '  }catch(e){}',
    '  if(!bad.length) return;',
    '  BAD=bad; mark(); addCss(); rewrite();',
    '  try{',
    '    var mo=new MutationObserver(function(){ rewrite(); });',
    '    mo.observe(document.body||document.documentElement,{childList:true,subtree:true});',
    '    setTimeout(function(){ try{ mo.disconnect(); }catch(e){} },5000);',
    '  }catch(e){}',
    '}',
    'function boot(){',
    '  try{ if(document.fonts && document.fonts.ready && document.fonts.ready.then){ document.fonts.ready.then(detect,detect); } }catch(e){}',
    '  setTimeout(detect,4000);',
    '  window.addEventListener("load",detect);',
    '}',
    'if(document.readyState==="loading"){ document.addEventListener("DOMContentLoaded",boot); } else { boot(); }',
    '})();',
  ].join('\n');
}

export interface FontFallbackPlan {
  families: string[];
  css: string;
  script: string;
}

/**
 * 纯函数入口：正文里没有远程 `@font-face` ⇒ `null`（**零注入**）。
 * 命中时给出「别名 CSS + 运行时检测脚本」，由 `buildHtmlDoc` 追加到 `</head>` 前
 * （放在页面自带样式之后 ⇒ 本地别名能覆盖失效的远端声明）。
 */
export function planFontFallback(html: string): FontFallbackPlan | null {
  const families = extractRemoteFontFamilies(html);
  if (!families.length) return null;
  return { families, css: fontFallbackCss(families), script: fontFallbackScript(families) };
}
