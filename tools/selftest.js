/**
 * 自检脚本（开发期用，不参与站点运行）
 * 在 Node 里加载 assets/markdown.js 与 assets/store.js，喂一批用例看输出。
 * 用法：node tools/selftest.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* 造一个最小可用的浏览器环境给这两个脚本用 */
const sandbox = {
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
  },
  location: { pathname: '/index.html' },   /* store.js 用它判断 API 前缀 */
  console,
};
/* 故意不给 fetch：store.js 应探测失败并退回静态模式，自检走的就是这条兜底路 */
sandbox.window = sandbox;
sandbox.matchMedia = () => ({ matches: false });
vm.createContext(sandbox);

['web/assets/markdown.js', 'web/assets/store.js', 'web/posts/manifest.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});

const KY = sandbox.KY;
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
}

console.log('\n[1] 行内解析');
const inline = KY.md.inline;
check('粗体', inline('**粗**') === '<strong>粗</strong>', inline('**粗**'));
check('斜体', inline('*斜*') === '<em>斜</em>', inline('*斜*'));
check('删除线', inline('~~没~~') === '<del>没</del>', inline('~~没~~'));
check('行内代码不被强调污染', inline('`a*b*c`') === '<code>a*b*c</code>', inline('`a*b*c`'));
check('链接', inline('[名](https://a.com)').includes('<a href="https://a.com"'), inline('[名](https://a.com)'));
check('外链带 target', inline('[名](https://a.com)').includes('target="_blank"'));
check('图片', inline('![图](i.png)') === '<img src="i.png" alt="图">', inline('![图](i.png)'));
check('裸 URL 自动成链', inline('见 https://a.com 处').includes('<a href="https://a.com"'));
check('链接文字里的粗体', inline('[**粗**](u)') === '<a href="u"><strong>粗</strong></a>', inline('[**粗**](u)'));
check('HTML 被转义', inline('<script>') === '&lt;script&gt;', inline('<script>'));
check('硬换行', inline('一行  \n二行') === '一行<br>\n二行', inline('一行  \n二行').replace(/\n/g, '\\n'));

console.log('\n[2] 块级解析');
const r1 = KY.md.render('# 大标题\n\n## 小节\n\n正文一段。\n\n### 三级\n\n> 引用内容\n\n- a\n- b\n  - b1\n  - b2\n- c\n\n```js\nconst a = 1;\n```\n\n| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |\n\n---\n\n1. 一\n2. 二');
console.log('  headings:', r1.headings.map(h => h.level + ':' + h.text).join(' | '));
check('H1 渲染', r1.html.includes('<h1 id="sec-1">'));
check('H2 自动编号（中文）', r1.html.includes('<span class="no">一</span>'), r1.html.match(/<h2[^>]*>.*?<\/h2>/)?.[0]);
check('H3 渲染', r1.html.includes('<h3 id="sec-'));
check('引用块', r1.html.includes('<blockquote><p>引用内容</p></blockquote>'));
check('无序列表', r1.html.includes('<ul><li>a</li><li>b'));
check('嵌套列表', r1.html.includes('<li>b<ul><li>b1</li><li>b2</li></ul></li>'), r1.html.match(/<li>b[\s\S]{0,90}/)?.[0]);
check('围栏代码块', r1.html.includes('<pre><code class="lang-js">const a = 1;</code></pre>'));
check('代码块内容被转义', KY.md.render('```\n<b>\n```').html.includes('&lt;b&gt;'));
check('表格', r1.html.includes('<table><thead><tr><th>列</th><th>值</th></tr></thead><tbody><tr><td>甲</td><td>1</td></tr></tbody></table>'));
check('分割线', r1.html.includes('<hr>'));
check('有序列表', r1.html.includes('<ol><li>一</li><li>二</li></ol>'));

console.log('\n[3] 不丢内容（回归用例）');
const mixed = KY.md.render('- 甲\n- 乙\n\n1. 丙\n2. 丁\n\n---\n\n尾段').html;
console.log('  ' + mixed.replace(/\n/g, ' '));
check('无序 → 有序 混排：ul 在', mixed.includes('<li>甲</li>'));
check('无序 → 有序 混排：ol 仍被渲染（曾整段丢失）', mixed.includes('<ol><li>丙</li><li>丁</li></ol>'));
check('混排后 hr 仍在', mixed.includes('<hr>'));
check('混排后尾段仍在', mixed.includes('尾段'));
check('列表内空行不吞后续内容', KY.md.render('- 甲\n\n续写一段').html.includes('续写一段'));
check('首段加首字下沉类', r1.html.includes('<p class="lead">') || /<p[^>]*class="lead"/.test(r1.html));
check('段落正常', KY.md.render('就一行字').html === '<p class="lead">就一行字</p>', KY.md.render('就一行字').html);

console.log('\n[3] setext 与边界');
check('setext H2', KY.md.render('标题\n---\n\n正文').html.includes('<h2 id="sec-1"><span class="no">一</span>标题</h2>'));
check('setext H1', KY.md.render('标题\n===\n\n正文').html.includes('<h1 id="sec-1">标题</h1>'));
check('空输入不炸', KY.md.render('').html === '');
check('只有空行不炸', KY.md.render('\n\n\n').html === '');
check('未闭合代码块不吞全文', KY.md.render('```\nabc').html.includes('<pre>'));

console.log('\n[4] front matter');
const fm = KY.md.frontMatter('---\ntitle: 测试\ndate: 2026-01-02\ntags: [甲, 乙]\nsummary: 一句话\n---\n\n## 正文\n\n内容');
check('title', fm.data.title === '测试');
check('tags 数组', JSON.stringify(fm.data.tags) === '["甲","乙"]', JSON.stringify(fm.data.tags));
check('body 剥离干净', fm.body.trim().startsWith('## 正文'), JSON.stringify(fm.body.slice(0, 10)));
check('无 front matter 时原样返回', KY.md.frontMatter('## 直接开始').data.title === undefined);

console.log('\n[5] 数据层');
const all = KY.store.all();
check('内置文章读取', all.length >= 5, '实际 ' + all.length);
check('按日期倒序', all[0].date >= all[all.length - 1].date, all.map(p => p.date).join(','));
check('readingTime 合理', KY.store.readingTime(all[0].markdown) >= 1);
check('wordCount > 0', KY.store.wordCount(all[0].markdown) > 0);
check('slugify 中文可用', !!KY.store.slugify('下雨天，我为什么还留着这把坏伞'));
check('formatDate', KY.store.formatDate('2026-08-28') === '2026 年 8 月 28 日');
check('tags 汇总', KY.store.tags().length > 0, JSON.stringify(KY.store.tags()));
check('fromMarkdown 往返', (() => {
  const md = KY.store.toMarkdown(all[0]);
  const back = KY.store.fromMarkdown(md, 'x.md');
  return back.title === all[0].title && back.slug === all[0].slug && back.tags.length === all[0].tags.length;
})());
check('publish / remove 往返', (() => {
  KY.store.save({ slug: 'tmp-x', title: '临时', date: '2026-01-01', tags: [], summary: 's', markdown: 'x' });
  const ok1 = !!KY.store.bySlug('tmp-x');
  KY.store.remove('tmp-x');
  return ok1 && !KY.store.bySlug('tmp-x');
})());

console.log('\n[6] 每篇内置文章都能渲染');
all.forEach(p => {
  const res = KY.md.render(p.markdown);
  check(`《${p.title}》 ${res.html.length} 字节 / ${res.headings.length} 个目录项`, res.html.length > 200);
});

/* [7] 双模式数据层：沙箱没有 fetch，store.js 应探测失败并停在静态模式 */
console.log('\n[7] 数据层双模式');
function done() {
  console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}
KY.store.ready.then(function (isServer) {
  check('无 fetch → 静态模式（ready=false）', isServer === false);
  check('isServerMode() 同步一致', KY.store.isServerMode() === false);
  const p = KY.store.save({ slug: 'tmp-y', title: '临时Y', date: '2026-01-01', tags: ['测'], summary: '', markdown: 'y' });
  check('save 返回 Promise', p && typeof p.then === 'function');
  return p.then(() => KY.store.remove('tmp-y')).then(() => {
    check('静态模式下删除后 bySlug 为空', !KY.store.bySlug('tmp-y'));
    done();
  });
}).catch(e => { check('异步链路不炸', false, String(e)); done(); });
