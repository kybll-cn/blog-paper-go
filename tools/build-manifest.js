/**
 * 站点数据生成器
 * ---------------------------------------------------------------
 * 作用：把 posts/src/*.md 编译成两个数据文件
 *   - posts/manifest.js  → window.KY_BUILTIN_POSTS = [...]（file:// 直接双击也能读）
 *   - posts/posts.json   → 纯 JSON，将来若接后端 API 可直接复用
 *
 * 用法：node tools/build-manifest.js
 * 说明：这是"可选的"开发期工具，不是运行依赖——站点本身是纯静态的。
 *      你也可以完全不用它，直接在后台页面写文章然后导出。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'web', 'posts', 'src');

/* 极简 front matter 解析：只处理 key: value 与 key: [a, b] 两种形式 */
function parseFrontMatter(raw) {
  const text = raw.replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: text };

  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();

    if (/^\[.*\]$/.test(val)) {
      // 数组写法：tags: [随笔, 生活]
      val = val.slice(1, -1).split(',').map(s => strip(s.trim())).filter(Boolean);
    } else if (val.includes(',')) {
      // 逗号分隔写法：tags: 随笔, 生活
      val = val.split(',').map(s => strip(s.trim())).filter(Boolean);
    } else {
      val = strip(val);
      if (key === 'tags') val = val ? [val] : [];
    }
    data[key] = val;
  }
  return { data, body: m[1] !== undefined ? text.slice(m[0].length) : text };
}

/* 去掉包裹的引号 */
function strip(s) {
  return s.replace(/^["']|["']$/g, '').trim();
}

/* 摘要兜底：正文首个非标题、非空行的段落，截 80 字 */
function guessSummary(body) {
  const line = body.split('\n')
    .map(s => s.trim())
    .find(s => s && !s.startsWith('#') && !s.startsWith('>') && !s.startsWith('```'));
  if (!line) return '';
  return line.replace(/[*_`#\[\]]/g, '').slice(0, 80);
}

const files = fs.existsSync(SRC_DIR)
  ? fs.readdirSync(SRC_DIR).filter(f => f.toLowerCase().endsWith('.md'))
  : [];

const posts = files.map(file => {
  const raw = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  const { data, body } = parseFrontMatter(raw);
  const slug = data.slug || file.replace(/\.md$/i, '');

  return {
    slug,
    title: data.title || slug,
    date: data.date || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    summary: data.summary || guessSummary(body),
    markdown: body.replace(/^\n+/, ''),
  };
});

// 按日期倒序（无日期排最后）
posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));

const banner = '/* 由 tools/build-manifest.js 自动生成，请勿手改；改文章请编辑 posts/src/*.md 后重新生成 */';

fs.writeFileSync(
  path.join(ROOT, 'web', 'posts', 'manifest.js'),
  `${banner}\nwindow.KY_BUILTIN_POSTS = ${JSON.stringify(posts, null, 2)};\n`,
  'utf8'
);

fs.writeFileSync(
  path.join(ROOT, 'web', 'posts', 'posts.json'),
  JSON.stringify(posts, null, 2),
  'utf8'
);

console.log(`✓ 已生成 ${posts.length} 篇文章 → posts/manifest.js, posts/posts.json`);
posts.forEach(p => console.log(`  · ${p.date || '----------'}  ${p.title}`));
