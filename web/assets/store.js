/* ============================================================================
   站点数据层（双模式）
   ----------------------------------------------------------------------------
   页面代码只认一套接口（all/bySlug/save/remove），不关心底下是谁：
     ① 服务器模式：探测到 Go 后端（GET api/posts 可达）→ 文章存 MariaDB；
        写操作凭登录会话 Cookie；发布/删除后服务端经 SSE 推 "change"，
        所有在线页面自动重拉列表（前台不刷新即可看到新文章）。
     ② 静态模式：探测失败（file:// 双击、后端没开）→ 退回纯静态：
        内置文章（posts/manifest.js）+ 本地文章（localStorage）。
   ready：探测完成的 Promise；onChange：注册 SSE 变更回调。
   ========================================================================== */
(function (global) {
  'use strict';

  var KEY_LOCAL = 'ky.posts.local';    /* 静态模式的本地文章 */
  var KEY_DRAFT = 'ky.drafts';         /* 草稿箱（未发布，两种模式都留在本机） */

  /* API 根路径：后台在 /edit/、文章在 /p/<slug>（都深一层），前台在根目录，前缀不同 */
  var BASE = /\/(edit|p)(\/|$)/i.test(global.location.pathname) ? '../' : '';
  var API_URL = BASE + 'api/posts';

  /* 服务器模式状态：探测完成前一律按静态走 */
  var serverMode = false;
  var serverPosts = [];                /* 服务器文章快照（list 接口缓存） */
  var changeHandlers = [];             /* SSE 变更订阅者 */

  /* ---------------------------------------------------------------
     站点配置：改这里就能换站名、副标题、页脚
     服务器模式下会被 /api/site（安装向导/后台站点设置）覆盖
     --------------------------------------------------------------- */
  var SITE = {
    name: '空雨不流泪',
    nameParts: ['空雨', '不流泪'],       /* 用于 logo 的双色拆分 */
    tagline: '雨没下，就别撑伞',
    description: '一个写字的地方。关于雨、关于告别、关于那些没发生的事。',
    author: '空雨',
    since: '2021',
    footerNote: '本页排版为书卷派 Editorial / Warm Minimalism',
    repoURL: 'https://github.com/kybll-cn/blog-paper-go',  /* 开源地址（页脚） */
    icp: '',                                                /* ICP 备案号（页脚，留空不显示） */
    police: '',                                             /* 公安备案号（页脚，留空不显示） */
  };

  /* ---------------------------------------------------------------
     小工具
     --------------------------------------------------------------- */

  /** 西文转 kebab、中文保留；生成 URL 用的 slug */
  function slugify(title) {
    var s = String(title || '').trim().toLowerCase()
      .replace(/[\s_/\\]+/g, '-')
      .replace(/[^\w\u4e00-\u9fa5-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return s || ('post-' + Date.now());
  }

  /** 阅读时长：中文按 350 字/分钟（含代码，代码按行计 1 字） */
  function readingTime(md) {
    var text = String(md || '');
    var chars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;   /* 汉字 */
    var words = (text.match(/[A-Za-z0-9]+/g) || []).length;      /* 西文词 */
    var minutes = Math.max(1, Math.round((chars + words * 1.5) / 350));
    return minutes;
  }

  /** 汉字+西文词的总量，用于后台显示字数 */
  function wordCount(md) {
    var text = String(md || '');
    return (text.match(/[\u4e00-\u9fa5]/g) || []).length +
           (text.match(/[A-Za-z0-9]+/g) || []).length;
  }

  /** '2026-08-28' → '2026 年 8 月 28 日' */
  function formatDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return iso || '';
    return m[1] + ' 年 ' + parseInt(m[2], 10) + ' 月 ' + parseInt(m[3], 10) + ' 日';
  }

  /** 今天，YYYY-MM-DD */
  function today() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 摘要兜底：正文第一段前 80 字 */
  function autoSummary(md) {
    var text = global.KY.md.plain(md);
    return text.slice(0, 80) + (text.length > 80 ? '…' : '');
  }

  /* ---------------------------------------------------------------
     本地存储读写
     --------------------------------------------------------------- */
  function read(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('[store] 读取失败：' + key, e);
      return fallback;
    }
  }
  function write(key, val) {
    try {
      global.localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      console.warn('[store] 写入失败：' + key, e);
      return false;
    }
  }

  /* ---------------------------------------------------------------
     服务器模式：API 客户端
     ----------------------------------------------------------------------------
     与 Go 后端的约定（见 main.go / auth.go）：
       GET    /api/posts          → [Post]            公开
       GET    /api/posts/{slug}   → Post | 404        公开
       PUT    /api/posts/{slug}   → {ok}              需登录（Cookie 会话）
       DELETE /api/posts/{slug}   → {ok}              需登录
       GET    /api/events         → SSE  "change" 事件
     写操作 401 → 自动跳 /login?next=当前页，登录后回来接着用。
     --------------------------------------------------------------- */

  /** 极简 fetch 封装：统一 JSON、统一错误形状（.status 保留 HTTP 码）
   *  timeoutMs：探测必须限时——后端半死时 fetch 会一直 pending，
   *  2 秒不响应就判"后端不存在"，直接降级静态模式，别吊着页面加载 */
  function apiFetch(method, slug, body, timeoutMs) {
    var opt = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    var timer = null;
    if (timeoutMs && global.AbortController) {
      var ctrl = new global.AbortController();
      opt.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    }
    var url = API_URL + (slug ? '/' + encodeURIComponent(slug) : '');
    return global.fetch(url, opt).then(function (res) {
      if (timer) clearTimeout(timer);
      if (res.status === 404 && method === 'GET' && !slug) {
        var off = new Error('后端不可达'); off.status = 404; throw off;
      }
      var e401 = new Error('未登录');
      if (res.status === 401) { e401.status = 401; throw e401; }
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          var err = new Error(j.error || ('HTTP ' + res.status)); err.status = res.status; throw err;
        });
      }
      return res.status === 204 ? null : res.json();
    }, function (netErr) {
      /* 网络层失败（断网 / file:// / 超时 abort）：统一成"后端不可达" */
      if (timer) clearTimeout(timer);
      var err = new Error(netErr && netErr.name === 'AbortError' ? '后端响应超时' : '后端不可达');
      err.status = 0;
      throw err;
    });
  }

  /** 401 → 跳登录页（带 next 回跳参数），并挂起本次 Promise */
  function toLogin() {
    var next = encodeURIComponent(global.location.pathname.replace(BASE, '') || '/');
    global.location.href = BASE + 'login?next=' + next;
  }
  function withLoginRetry(fn) {
    return fn().catch(function (err) {
      if (err && err.status === 401) { toLogin(); return new Promise(function () {}); } // 不 resolve：页面马上跳走
      throw err;
    });
  }

  /** 补全一篇服务器的文章（后端可能给出空 summary/tags） */
  function normalizePost(p) {
    return Object.assign({}, p, {
      tags: Array.isArray(p.tags) ? p.tags : [],
      summary: p.summary || autoSummary(p.markdown)
    });
  }

  /** 安装向导/站点设置填写的信息覆盖内置默认（服务器模式专属） */
  function applySite(info) {
    if (!info) return;
    SITE.name = info.name || SITE.name;
    SITE.tagline = info.tagline || SITE.tagline;
    SITE.description = info.description || SITE.description;
    SITE.author = info.author || SITE.author;
    SITE.since = info.copyright_since || SITE.since;
    SITE.repoURL = info.repo_url || SITE.repoURL;
    SITE.icp = info.icp || '';     /* 备案号清空是合法操作，不给兜底 */
    SITE.police = info.police || '';
    /* logo 双色拆分：前两字 + 其余（站名太短就整体一档） */
    var n = SITE.name;
    SITE.nameParts = n.length > 2 ? [n.slice(0, 2), n.slice(2)] : [n, ''];
  }
  function fetchSite() {
    return global.fetch(BASE + 'api/site', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(applySite)
      .catch(function () { /* 拿不到就用内置默认 */ });
  }
  /** 后台"站点设置"保存：PUT /api/site（需登录，401 自动跳登录） */
  function saveSite(info) {
    return withLoginRetry(function () {
      return global.fetch(BASE + 'api/site', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(info)
      }).then(function (r) {
        if (r.status === 401) { var e = new Error('未登录'); e.status = 401; throw e; }
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'HTTP ' + r.status); });
        return r.json();
      });
    }).then(function () { applySite(info); return true; });
  }

  /** ready：探测完成的 Promise(true=服务器模式)。页面等它再刷新渲染。 */
  var _readyResolve;
  var ready = new Promise(function (r) { _readyResolve = r; });
  (function probe() {
    if (!global.fetch) { _readyResolve(false); return; }   // 古董浏览器 → 静态模式
    apiFetch('GET', '', undefined, 2000).then(function (data) {
      if (Array.isArray(data)) {
        serverMode = true;
        serverPosts = data.map(normalizePost);
        subscribeEvents();                                 // 服务器模式才挂 SSE
        return fetchSite().then(function () { _readyResolve(true); });
      }
      _readyResolve(false);
    }).catch(function () { _readyResolve(false); });       // 404/断网/超时/file:// → 静态模式
  })();

  /* ---------------------------------------------------------------
     SSE：发布/删除后服务端推 "change"，本页重拉列表并通知订阅者
     --------------------------------------------------------------- */
  var es = null;
  function subscribeEvents() {
    if (!global.EventSource || es) return;
    try {
      es = new global.EventSource(BASE + 'api/events');
      es.addEventListener('change', function () {
        reload().then(function () {
          changeHandlers.forEach(function (h) { try { h('change'); } catch (e) { /* 单个订阅者炸了不带崩 */ } });
        });
      });
      /* 站点设置变更：重拉 /api/site 后通知订阅者（页脚热更新） */
      es.addEventListener('site', function () {
        fetchSite().then(function () {
          changeHandlers.forEach(function (h) { try { h('site'); } catch (e) {} });
        });
      });
      /* 连接错误不处理：EventSource 自带 retry 重连（服务端配了 3s） */
    } catch (e) { es = null; }
  }

  /** 注册数据变更回调（页面用来重渲染列表/徽标） */
  function onChange(fn) { if (typeof fn === 'function') changeHandlers.push(fn); }
  /** 清空订阅者：boot 重建页面前调用，防止回调叠加导致重复渲染 */
  function clearChangeHandlers() { changeHandlers = []; }

  /** 快照更新：写操作成功后同步内存，省一次 GET */
  function snapshotUpsert(post) {
    var idx = -1;
    serverPosts.forEach(function (p, i) { if (p.slug === post.slug) idx = i; });
    if (idx >= 0) serverPosts[idx] = post; else serverPosts.unshift(post);
    serverPosts.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
  }
  function snapshotRemove(slug) {
    serverPosts = serverPosts.filter(function (p) { return p.slug !== slug; });
  }

  /* ---------------------------------------------------------------
     登录态（服务器模式）
     --------------------------------------------------------------- */
  function me() {
    if (!serverMode) return Promise.resolve({ logged: false, user: '' });
    return global.fetch(BASE + 'api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { logged: false, user: '' }; });
  }
  function logout() {
    return global.fetch(BASE + 'api/logout', { method: 'POST', credentials: 'same-origin' })
      .then(function () { global.location.href = BASE + 'index.html'; })
      .catch(function () { global.location.href = BASE + 'index.html'; });
  }

  /* ---------------------------------------------------------------
     对外接口
     --------------------------------------------------------------- */

  /** 当前是否处于服务器模式（探测完成后才可信） */
  function isServerMode() { return serverMode; }

  /** 内置文章（posts/manifest.js 注入的全局变量，静态模式兜底用） */
  function builtin() {
    return Array.isArray(global.KY_BUILTIN_POSTS) ? global.KY_BUILTIN_POSTS : [];
  }

  /** 后台发布的本地文章 */
  function locals() { return read(KEY_LOCAL, []); }

  /** 全部文章：服务器模式取快照；静态模式为内置+本地，日期倒序，同 slug 本地覆盖内置 */
  function all() {
    if (serverMode) return serverPosts.slice();
    var map = {};
    builtin().concat(locals()).forEach(function (p) {
      map[p.slug] = Object.assign({}, p, {
        tags: p.tags || [],
        summary: p.summary || autoSummary(p.markdown)
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
  }

  /** 按 slug 取单篇 */
  function bySlug(slug) {
    return all().filter(function (p) { return p.slug === slug; })[0] || null;
  }

  /** 全部标签及计数，按出现次数倒序 */
  function tags() {
    var count = {};
    all().forEach(function (p) {
      (p.tags || []).forEach(function (t) { count[t] = (count[t] || 0) + 1; });
    });
    return Object.keys(count)
      .map(function (t) { return { name: t, count: count[t] }; })
      .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
  }

  /** 判断某篇是否只存在于本机（服务器模式下所有文章都是全站的，恒为 false） */
  function isLocal(slug) {
    if (serverMode) return false;
    return locals().some(function (p) { return p.slug === slug; });
  }

  /**
   * 发布/覆盖一篇文章。
   * 服务器模式 → PUT API（返回 Promise，全站生效，未登录自动跳 /login）；
   * 静态模式   → 写 localStorage（返回已 resolve 的 Promise，仅本机）。
   */
  function save(post) {
    post = normalizePost(post);
    if (serverMode) {
      return withLoginRetry(function () { return apiFetch('PUT', post.slug, post); })
        .then(function () { snapshotUpsert(post); return true; });
    }
    var list = locals();
    var idx = -1;
    list.forEach(function (p, i) { if (p.slug === post.slug) idx = i; });
    if (idx >= 0) list[idx] = post; else list.unshift(post);
    var ok = write(KEY_LOCAL, list);
    return Promise.resolve(ok);
  }

  /** 删除文章：服务器模式走 DELETE；静态模式只删得掉本地的（内置要改源文件） */
  function remove(slug) {
    if (serverMode) {
      return withLoginRetry(function () { return apiFetch('DELETE', slug); })
        .then(function () { snapshotRemove(slug); });
    }
    write(KEY_LOCAL, locals().filter(function (p) { return p.slug !== slug; }));
    return Promise.resolve();
  }

  /**
   * 重新拉取服务器文章列表（SSE 通知或手动刷新用）。
   * 静态模式返回空 Promise，调用方无感。
   */
  function reload() {
    if (!serverMode) return Promise.resolve();
    return apiFetch('GET').then(function (data) {
      if (Array.isArray(data)) serverPosts = data.map(normalizePost);
    }).catch(function () { /* 拉取失败保留旧快照，别把列表清空 */ });
  }

  /* ---- 草稿箱 ---- */
  function drafts() { return read(KEY_DRAFT, {}); }
  function saveDraft(d) {
    var map = drafts();
    map[d.id] = Object.assign({}, d, { savedAt: new Date().toISOString() });
    return write(KEY_DRAFT, map);
  }
  function dropDraft(id) {
    var map = drafts();
    delete map[id];
    write(KEY_DRAFT, map);
  }

  /* ---------------------------------------------------------------
     导入 / 导出（两种模式通用；服务器模式下退化为"本地备份工具"）
     --------------------------------------------------------------- */

  /** 文章对象 → 带 front matter 的 markdown 文本 */
  function toMarkdown(post) {
    var fm = [
      '---',
      'title: ' + (post.title || ''),
      'date: ' + (post.date || today()),
      'tags: ' + (post.tags || []).join(', '),
      'summary: ' + (post.summary || '')
    ];
    var extra = ['slug', 'cover', 'author'];
    extra.forEach(function (k) { if (post[k]) fm.push(k + ': ' + post[k]); });
    fm.push('---');
    return fm.join('\n') + '\n\n' + (post.markdown || '').replace(/^\n+/, '') + '\n';
  }

  /** markdown 文本 → 文章对象（无 front matter 时用正文首行兜底当标题） */
  function fromMarkdown(text, fallbackName) {
    var parsed = global.KY.md.frontMatter(text);
    var d = parsed.data;
    var body = parsed.body.replace(/^\n+/, '');
    var firstLine = (body.match(/^#\s+(.+)$/m) || [])[1];
    var title = d.title || firstLine || (fallbackName || '未命名').replace(/\.md$/i, '');

    return {
      slug: d.slug || slugify(title),
      title: title,
      date: d.date || today(),
      tags: d.tags || [],
      summary: d.summary || autoSummary(body),
      author: d.author || SITE.author,
      markdown: body.replace(/^#\s+.+\n+/, firstLine ? '' : '') /* 标题已在页头展示，正文里去掉重复的 H1 */
    };
  }

  /** 生成 manifest.js 内容（含全部文章，可直接覆盖 posts/manifest.js） */
  function exportManifest() {
    return '/* 由写作后台导出，可直接覆盖 posts/manifest.js */\n' +
      'window.KY_BUILTIN_POSTS = ' + JSON.stringify(all(), null, 2) + ';\n';
  }

  /** 触发浏览器下载 */
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  global.KY = global.KY || {};
  global.KY.site = SITE;
  global.KY.store = {
    SITE: SITE,
    all: all, bySlug: bySlug, tags: tags, isLocal: isLocal,
    save: save, remove: remove, reload: reload,
    ready: ready, isServerMode: isServerMode, onChange: onChange,
    clearChangeHandlers: clearChangeHandlers,
    me: me, logout: logout, saveSite: saveSite,
    drafts: drafts, saveDraft: saveDraft, dropDraft: dropDraft,
    toMarkdown: toMarkdown, fromMarkdown: fromMarkdown,
    exportManifest: exportManifest, download: download,
    slugify: slugify, readingTime: readingTime, wordCount: wordCount,
    formatDate: formatDate, today: today, autoSummary: autoSummary
  };
})(window);
