/**
 * `#559` 源实测三例（七猫官方 / 速读谷）—— 全部锁在探针这一侧。
 *
 *  ① **`java.getString(rule)` 在项内必须能求值**（七猫 `kind` 用
 *     `["$.score",…].map(function(k){return java.getString(k)})`）：探针的求值器此前**没接
 *     `evalRule`**，`java.getString` 恒走 else 分支返回空串 ⇒ 每项都空；
 *     而同一个 `$.score` 直接当规则写却能解出 `8.4`。这正是「探针少了引擎一半接线」。
 *  ② **JSON 项的 0 命中要说「键」不是「选择器」**：`original_alias_title` 这个键不存在
 *     （真键 `original_title`），老提示让人去翻 CSS 标签。
 *  ③ **4xx 的错误页不能当物料**：七猫发现分类返回 `404 page not found`，拿它当页面 ⇒ 后面全 0 命中。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeField } from '../diag/probe';
import { resolveMaterial } from '../diag/material-chain';
import { isSelfFetchingRule } from '../diag/explore-probe';

/** 七猫搜索结果的最小真实形状（键按实抓 2026-10-21 保留，取值截断） */
const QM_JSON = JSON.stringify({
  data: {
    meta: { page: '1', next_page: '2' },
    books: [
      {
        id: 1,
        title: '我在末世变废为宝',
        original_title: '末世变废为宝',
        original_author: '为轻尘',
        score: '8.4',
        ptags: '科幻,未来世界',
        sub_title: '・科幻・完结・365万字',
        words_num: '3647510',
        image_link: 'https://cdn.test/c1.jpg',
      },
      {
        id: 2,
        title: '我在末世开农场',
        original_author: '某某',
        score: '9.6',
        ptags: '末世,丧尸',
        sub_title: '・末世・连载',
        words_num: '1000000',
        image_link: 'https://cdn.test/c2.jpg',
      },
    ],
  },
});

const item = (rule: string) =>
  probeField({ rule, content: QM_JSON, field: 'ruleSearch.kind', mode: 'list', scopeRule: 'data.books' });

/** 七猫官方源的 `kind` 规则原文（截取到 filter 前，语义一致） */
const KIND_RULE =
  '@js:["$.score","$.characters","$.ptags","$.sub_title","$.heat_number"]' +
  '.map(function(k){return String(java.getString(k)||"").replace(/<[^>]*>/g,"")})' +
  '.filter(function(v){return v}).join(",")';

test('Q-① `java.getString(rule)` 在项内能取值（探针要接 evalRule）', async () => {
  const r = await item(KIND_RULE);
  assert.equal(r.ok, true, '七猫 kind 规则应能解出值');
  assert.equal(r.values?.[0], '8.4,科幻,未来世界,・科幻・完结・365万字');
  assert.equal(r.values?.[1], '9.6,末世,丧尸,・末世・连载');
});

test('Q-①b `java.getString` 与直接写规则必须同源（同一个 $.score）', async () => {
  const direct = await item('$.score');
  const viaJava = await item("@js:String(java.getString('$.score'))");
  assert.equal(direct.values?.[0], '8.4');
  assert.equal(viaJava.values?.[0], '8.4', '经 java 取与直接取必须一致');
});

test('Q-② JSON 项缺键：报 JSON_KEY_MISS 并给近似键（不要提「选择器/节点」）', async () => {
  const r = await item('original_alias_title');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'JSON_KEY_MISS');
  assert.match(r.error ?? '', /没有键 `original_alias_title`/);
  const h = (r.hints ?? []).join('\n');
  assert.match(h, /JSON 对象/, '要点明这是 JSON 项');
  assert.match(h, /original_title/, '要给出最接近的真实键');
  assert.doesNotMatch(h, /选择器在项内 0 命中/, 'JSON 项不能再用 CSS 措辞');
});

test('Q-②b 键存在时正常解出（original_title），证明上一条不是「全都报错」', async () => {
  const r = await item('original_title');
  assert.equal(r.ok, true);
  assert.equal(r.values?.[0], '末世变废为宝');
});

test('Q-③ 4xx 错误页不能当物料：material 链要报错而不是返回错误正文', async () => {
  const r = await resolveMaterial({
    target: 'detail',
    url: 'https://api.test/hall-of-fame?page=1',
    source: { bookSourceUrl: 'https://api.test' },
    // 模拟七猫：路由不存在时正文就是一行 `404 page not found`
    fetch: async (u: string) => ({ content: '404 page not found', status: 404, baseUrl: u }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.content, '');
  assert.match(r.errors.join('\n'), /HTTP 404/);
  assert.doesNotMatch(r.content, /404 page not found/);
});

/* ------------------- 自取数列表：页面 404 不等于源坏了 ------------------- */

test('Q-④ 自取数列表判定：`<js>` + java.ajax / fetch 才算，纯 JS 拼接不算', () => {
  // 七猫真实形态（v3.9.61 与 v3.1 都是这样：拼真实接口再 java.ajax）
  assert.equal(isSelfFetchingRule(`<js>\nvar u='https://api.test/api/v1/h5/x';\nresult = java.ajax(u + ',' + java.get('headers'));\n</js>`), true);
  assert.equal(isSelfFetchingRule(`@js: java.post('https://api.test/x', 'a=1')`), true);
  assert.equal(isSelfFetchingRule(`<js> var r = fetch('https://api.test/x'); </js>`), true);
  // 只做字符串拼装、不发请求 ⇒ 不是自取数（页面 404 就是真 404）
  assert.equal(isSelfFetchingRule(`<js> result = baseUrl + '&page=' + page; </js>`), false);
  // CSS 选择器规则
  assert.equal(isSelfFetchingRule('@css:.item'), false);
  assert.equal(isSelfFetchingRule(''), false);
});
