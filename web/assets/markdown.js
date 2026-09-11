/* ============================================================================
   Markdown 渲染器（零依赖，约 320 行）
   ----------------------------------------------------------------------------
   设计：块级负责结构，行内负责修饰。
     · 块级：逐行扫描，遇到能开头的语法就吃掉对应区间，其余按段落处理
     · 行内：先esc转义，再把每种语法抽成占位令牌，最后倒序还原
              （倒序是为了让"链接文字里的粗体"这种嵌套能正确还原）
   支持：ATX / setext 标题、围栏代码、引用、有序/无序列表（含嵌套）、表格、
        分割线、段落，行内 代码/粗体/斜体/删除线/链接/图片/自动链接/硬换行
   不追求 CommonMark 满分，追求"能替换、看得懂、不会过期"。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------
     工具
     --------------------------------------------------------------- */

  /** HTML 转义（含引号，用于文本节点与属性值） */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 中文数字：用于 h2 的"一、二、三"编号 */
  function cnNum(n) {
    var d = '零一二三四五六七八九';
    if (n <= 10) return n === 10 ? '十' : d[n];
    if (n < 20) return '十' + d[n - 10];
    var t = Math.floor(n / 10), r = n % 10;
    return d[t] + '十' + (r ? d[r] : '');
  }

  /** 行首缩进（空格算 1，Tab 算 4） */
  function indentOf(line) {
    var m = line.match(/^[ \t]*/)[0];
    return m.replace(/\t/g, '    ').length;
  }

  /* ---------------------------------------------------------------
     行内解析
     --------------------------------------------------------------- */

  /**
   * 解析一行/一段的行内语法
   * @param {string} text 原始 markdown 文本（未转义）
   * @returns {string} HTML
   */
  function inline(text) {
    var tokens = [];
    /** 把一段 HTML 存进令牌池，返回占位符（\u0000 在正文里几乎不可能出现） */
    function stash(html) {
      tokens.push(html);
      return '\u0000' + (tokens.length - 1) + '\u0000';
    }

    /**
     * 强调（粗体 / 删除线 / 斜体）——顺序不能反，
     * 否则 ** 会被当成两个 * 先匹配掉
     * @param {string} s 已转义的文本
     */
    function emph(s) {
      s = s.replace(/\*\*([^\n]+?)\*\*/g, function (_, t) { return stash('<strong>' + t + '</strong>'); });
      s = s.replace(/__([^\n]+?)__/g, function (_, t) { return stash('<strong>' + t + '</strong>'); });
      s = s.replace(/~~([^\n]+?)~~/g, function (_, t) { return stash('<del>' + t + '</del>'); });
      s = s.replace(/\*([^*\n]+?)\*/g, function (_, t) { return stash('<em>' + t + '</em>'); });
      s = s.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,，。)]|$)/g, function (_, pre, t) {
        return pre + stash('<em>' + t + '</em>');
      });
      return s;
    }

    /* 附件扩展名 → 下载卡片（区别于普通链接） */
    var ATTACH_EXT = /\.(zip|rar|7z|tar|gz|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|mp3|mp4|m4a|wav)(\?|#|$)/i;
    function isAttachment(href) {
      return ATTACH_EXT.test(href);
    }
    /** 下载卡片：文件名 + 类型徽标 + 可展开的直链（带复制按钮）
        注意：href 在 esc(text) 之后进入，& 已是 &amp;；卡片里两处 href
        要还原成真实 URL（&amp; → &），否则带查询串的直链会失效 */
    function downloadCard(label, href, title) {
      var rawHref = href.replace(/&amp;/g, '&');
      var name = label || decodeURIComponent((rawHref.split('/').pop() || '文件').split('?')[0]);
      var ext = (name.match(/\.([a-z0-9]+)(\?|#|$)/i) || [, 'file'])[1].toUpperCase();
      var dl = rawHref + (rawHref.indexOf('?') >= 0 ? '&' : '?') + 'dl=' + encodeURIComponent(name);
      var html =
        '<span class="dl-card">' +
          '<span class="dl-ext">' + esc(ext) + '</span>' +
          '<span class="dl-body">' +
            '<a class="dl-name" href="' + esc(rawHref) + '" target="_blank" rel="noopener"' + (title ? ' title="' + title + '"' : '') + '>' + esc(name) + '</a>' +
            '<span class="dl-actions">' +
              '<a class="dl-btn" href="' + esc(dl) + '" download>下载</a>' +
              '<button class="dl-btn dl-toggle" type="button" aria-expanded="false">直链</button>' +
            '</span>' +
          '</span>' +
          '<span class="dl-url"><code>' + esc(rawHref) + '</code>' +
            '<button class="dl-btn dl-copy" type="button">复制链接</button></span>' +
        '</span>';
      /* 卡片必须 stash：占位符能躲过后续强调/自动链接正则，
         否则 URL 里的 _ 会被当斜体、裸链会被二次包装 */
      return stash(html);
    }

    var s = esc(text);

    /* ① 行内代码优先抽出——否则 `a*b*c` 里的星号会被当成斜体 */
    s = s.replace(/`([^`]+)`/g, function (_, code) {
      return stash('<code>' + code + '</code>');
    });

    /* ② 图片 ![alt](src "title") */
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      function (_, alt, src, title) {
        return stash('<img src="' + src + '" alt="' + alt + '"' +
          (title ? ' title="' + title + '"' : '') + '>');
      });

    /* ③ 链接 [text](href "title")：链接文字内部先过一次强调，
         否则 [**粗**](u) 里的星号会漏在锚点里当字面量。
         若指向附件（/uploads/ 里的文档/压缩包/媒体），渲染成下载卡片 */
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      function (_, label, href, title) {
        if (isAttachment(href)) return downloadCard(label, href, title);
        return stash('<a href="' + href + '"' + (/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : '') + '>' + emph(label) + '</a>');
      });

    /* ④ 自动链接：尖括号式 <https://x> 与裸 URL */
    s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, function (_, url) {
      return stash('<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>');
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, pre, url) {
      return pre + stash('<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>');
    });

    /* ⑤ 强调：剩余正文统一处理 */
    s = emph(s);

    /* ⑥ 硬换行：行尾两个空格，或行尾反斜杠 */
    s = s.replace(/ {2,}\n/g, '<br>\n').replace(/\\\n/g, '<br>\n');

    /* ⑦ 倒序还原令牌：后进先出，保证嵌套结构正确 */
    for (var i = tokens.length - 1; i >= 0; i--) {
      s = s.split('\u0000' + i + '\u0000').join(tokens[i]);
    }
    return s;
  }

  /* ---------------------------------------------------------------
     块级解析
     --------------------------------------------------------------- */

  var RE_FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
  var RE_HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
  var RE_ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  var RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var RE_QUOTE = /^\s*>\s?/;
  var RE_TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/;
  var RE_SETEXT = /^\s*(=+|-+)\s*$/;

  /**
   * 判断某行是否"开启了一个新块"（用于决定段落在哪里收尾）
   */
  function startsBlock(line) {
    return RE_FENCE.test(line) || RE_ATX.test(line) || RE_ITEM.test(line) ||
      RE_QUOTE.test(line) || RE_HR.test(line);
  }

  /**
   * 列表 → HTML。用缩进栈实现嵌套：缩进更深就开一层新列表，
   * 更浅就收尾（递归返回）。
   */
  function renderList(items, start, baseIndent, counters) {
    var ordered = items[start].ordered;
    var tag = ordered ? 'ol' : 'ul';
    var html = '<' + tag + '>';
    var i = start;

    while (i < items.length) {
      var it = items[i];
      if (it.indent < baseIndent) break;

      /* 缩进更深：属于上一项的子弹，递归成子列表后插回上一个 </li> 内侧 */
      if (it.indent > baseIndent) {
        var sub = renderList(items, i, it.indent, counters);
        html = html.replace(/<\/li>$/, sub.html + '</li>');
        i = sub.next;
        continue;
      }
      /* 同级但标记类型变了（ul ↔ ol）：交给上层收尾 */
      if (it.ordered !== ordered) break;

      /* 续行（缩进对齐的后续内容）拼进同一项 */
      var body = it.text;
      if (it.more && it.more.length) body += '\n' + it.more.join('\n');

      /* 列表项内部若含空行，按段落处理；否则按行内处理 */
      var inner = /\n\s*\n/.test(body) ? parseBlocks(body, counters, true) : inline(body);
      html += '<li>' + inner + '</li>';
      i++;
    }
    html += '</' + tag + '>';
    return { html: html, next: i };
  }

  /**
   * 块级主循环
   * @param {string} src markdown 正文（已剥离 front matter）
   * @param {Array} headings 收集 h2/h3 用于目录
   * @param {boolean} [nested] 是否为嵌套解析（引用/列表内部）——
   *        嵌套层不加"首字下沉"，否则引用块里也会掉一个大字母
   * @returns {string} HTML
   */
  function parseBlocks(src, headings, nested) {
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var h2n = 0;
    var leadDone = false;   /* 首字下沉只给"第一个段落"，与它前面有几个标题无关 */
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      /* 空行：跳过 */
      if (!line.trim()) { i++; continue; }

      /* ① 围栏代码块：中间原样保留，只做转义 */
      var fence = line.match(RE_FENCE);
      if (fence) {
        var mark = fence[1].charAt(0);
        var len = fence[1].length;
        var lang = fence[2] || '';
        var buf = [];
        i++;
        while (i < lines.length) {
          var close = lines[i].match(/^\s*(```+|~~~+)\s*$/);
          if (close && close[1].charAt(0) === mark && close[1].length >= len) break;
          buf.push(lines[i]); i++;
        }
        i++; /* 跳过收尾围栏 */
        out.push('<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>' +
          esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      /* ② 分割线 */
      if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

      /* ③ ATX 标题 */
      var atx = line.match(RE_ATX);
      if (atx) {
        var lv = atx[1].length;
        var text = atx[2];
        var id = 'sec-' + (headings.length + 1);
        if (lv === 2) h2n++;
        headings.push({ level: lv, text: text.replace(/[*_`\[\]]/g, ''), id: id });
        out.push('<h' + lv + ' id="' + id + '">' +
          (lv === 2 ? '<span class="no">' + cnNum(h2n) + '</span>' : '') +
          inline(text) + '</h' + lv + '>');
        i++;
        continue;
      }

      /* ④ setext 标题（下划线式）：文本行 + ==== / ---- */
      if (i + 1 < lines.length && RE_SETEXT.test(lines[i + 1]) && line.trim() &&
          !startsBlock(line)) {
        var isH1 = /^\s*=+/.test(lines[i + 1]);
        var lvl = isH1 ? 1 : 2;
        var sid = 'sec-' + (headings.length + 1);
        if (lvl === 2) h2n++;
        headings.push({ level: lvl, text: line.replace(/[*_`\[\]]/g, ''), id: sid });
        out.push('<h' + lvl + ' id="' + sid + '">' +
          (lvl === 2 ? '<span class="no">' + cnNum(h2n) + '</span>' : '') +
          inline(line) + '</h' + lvl + '>');
        i += 2;
        continue;
      }

      /* ⑤ 引用：吃掉连续 > 行，剥一层前缀后递归解析 */
      if (RE_QUOTE.test(line)) {
        var qbuf = [];
        while (i < lines.length && (RE_QUOTE.test(lines[i]) || (qbuf.length && lines[i].trim()))) {
          qbuf.push(lines[i].replace(RE_QUOTE, ''));
          i++;
        }
        out.push('<blockquote>' + parseBlocks(qbuf.join('\n'), headings, true) + '</blockquote>');
        continue;
      }

      /* ⑥ 表格：当前行含 | 且下一行是分隔行 */
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          rows.push(lines[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '')
            .split('|').map(function (c) { return c.trim(); }));
          i++;
        }
        var head = rows.shift();   /* 表头 */
        rows.shift();              /* 分隔行（|---|---|）丢弃，它不是数据 */
        var html = '<table><thead><tr>' +
          head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>';
        rows.forEach(function (r) {
          html += '<tr>' + head.map(function (_, k) {
            return '<td>' + inline(r[k] || '') + '</td>';
          }).join('') + '</tr>';
        });
        out.push(html + '</tbody></table>');
        continue;
      }

      /* ⑦ 列表：收集"列表块"（含续行与内部空行），再交给缩进栈处理 */
      var item = line.match(RE_ITEM);
      if (item) {
        var items = [];
        while (i < lines.length) {
          var cur = lines[i];
          var m = cur.match(RE_ITEM);
          if (m) {
            items.push({
              indent: indentOf(cur),
              ordered: /\d/.test(m[2]),
              text: m[3],
              more: []
            });
            i++;
            continue;
          }
          /* 空行：后面若仍是列表内容则继续，否则列表结束 */
          if (!cur.trim()) {
            var nxt = lines[i + 1];
            if (nxt && (RE_ITEM.test(nxt) || (nxt.trim() && indentOf(nxt) > 0))) {
              items[items.length - 1].more.push('');
              i++;
              continue;
            }
            break;
          }
          /* 缩进续行：挂到当前项 */
          if (indentOf(cur) > 0 && items.length) {
            items[items.length - 1].more.push(cur.trim());
            i++;
            continue;
          }
          break;
        }
        /* 同一个"列表块"里可能混着 ul 和 ol（比如中间只隔一个空行），
           renderList 遇到标记类型变化会停下并交还 next —— 必须继续消费，
           否则后面的列表会被静默丢掉（丢内容比渲染错更严重） */
        var res = renderList(items, 0, items[0].indent, headings);
        while (res.next < items.length) {
          var rest = renderList(items, res.next, items[res.next].indent, headings);
          res = { html: res.html + rest.html, next: rest.next };
        }
        out.push(res.html);
        continue;
      }

      /* ⑧ 段落：一直吃到空行或下一个块的开头 */
      var pbuf = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) &&
             !(pbuf.length && i + 1 < lines.length && RE_SETEXT.test(lines[i + 1]))) {
        pbuf.push(lines[i]);
        i++;
      }
      if (pbuf.length) {
        var para = inline(pbuf.join('\n'));
        /* 顶层第一个段落 = 正文首段，加首字下沉（引用/列表内部不算） */
        var isLead = !nested && !leadDone;
        leadDone = true;
        out.push('<p' + (isLead ? ' class="lead"' : '') + '>' + para + '</p>');
        continue;
      }

      /* 兜底：无法识别的行按普通文本吐出，绝不吞掉内容 */
      out.push('<p>' + inline(line) + '</p>');
      i++;
    }
    return out.join('\n');
  }

  /* ---------------------------------------------------------------
     front matter
     --------------------------------------------------------------- */

  /**
   * 解析文章头部的 front matter
   * 支持 `key: value`、`key: a, b`、`key: [a, b]`
   * @param {string} raw 含 front matter 的完整 markdown
   * @returns {{data: Object, body: string}}
   */
  function frontMatter(raw) {
    var text = String(raw).replace(/\r\n?/g, '\n');
    var m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return { data: {}, body: text };

    var data = {};
    m[1].split('\n').forEach(function (line) {
      var kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!kv) return;
      var key = kv[1].toLowerCase();
      var val = kv[2].trim().replace(/^["']|["']$/g, '');
      if (/^\[.*\]$/.test(val)) {
        data[key] = val.slice(1, -1).split(',').map(trim).filter(Boolean);
      } else if (val.indexOf(',') >= 0) {
        data[key] = val.split(',').map(trim).filter(Boolean);
      } else {
        data[key] = val;
      }
    });
    function trim(s) { return s.trim().replace(/^["']|["']$/g, ''); }
    return { data: data, body: text.slice(m[0].length) };
  }

  /* ---------------------------------------------------------------
     对外接口
     --------------------------------------------------------------- */

  /**
   * 渲染 markdown
   * @param {string} md 不含 front matter 的正文
   * @returns {{html: string, headings: Array<{level:number,text:string,id:string}>}}
   */
  function render(md) {
    var headings = [];
    var html = parseBlocks(md || '', headings, false);   /* 顶层：首段允许首字下沉 */
    return { html: html, headings: headings.filter(function (h) { return h.level <= 3; }) };
  }

  /** 抽纯文本：用于摘要与字数统计 */
  function plain(md) {
    return String(md || '')
      .replace(/```[\s\S]*?```/g, '')       /* 代码块整段去掉 */
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') /* 图片 */
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[#>\-*+\d.\s]+/gm, '')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  global.KY = global.KY || {};
  global.KY.md = { render: render, inline: inline, plain: plain, frontMatter: frontMatter, esc: esc };
})(window);
