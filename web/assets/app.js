/* ============================================================================
   站点页面逻辑
   ----------------------------------------------------------------------------
   · 统一渲染顶栏 / 页脚（页面 HTML 里只留一个 <main>，避免三份导航各写一遍）
   · data-page="home" → 首页：Hero + 文章列表 + 标签筛选 + 搜索
   · data-page="post" → 文章页：Markdown 渲染 + 目录 + 上下篇 + 阅读进度
   ========================================================================== */
(function (global) {
  'use strict';

  var SITE = KY.site;
  var esc = KY.md.esc;

  /* ---------------------------------------------------------------
     主题：URL 参数 > 用户选择 > 系统偏好 > 亮色
     支持 index.html?theme=dark 强制指定，便于分享/验收预览
     --------------------------------------------------------------- */
  function initTheme() {
    if (initTheme._on) return;           /* 二次 boot（服务器模式重渲染）时防止监听器叠加 */
    initTheme._on = true;
    var root = document.documentElement;
    var saved = null;
    try { saved = global.localStorage.getItem('theme'); } catch (e) { /* 隐私模式 */ }

    var forced = '';
    try { forced = new URLSearchParams(location.search).get('theme') || ''; } catch (e) {}
    var initial = (forced === 'dark' || forced === 'light') ? forced
      : (saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    apply(initial);

    function apply(theme) {
      root.setAttribute('data-theme', theme);
      document.querySelectorAll('[data-theme-label]').forEach(function (el) {
        el.textContent = theme === 'dark' ? '☀ 日间' : '☾ 夜间';
      });
    }
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-theme-toggle]');
      if (!btn) return;
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { global.localStorage.setItem('theme', next); } catch (err) { /* 忽略 */ }
      apply(next);
    });
  }

  /* ---------------------------------------------------------------
     相对路径前缀
     后台在 /edit/、文章在 /p/<slug>（都深一层），顶栏和文章链接要按当前
     深度加前缀，否则在子目录页面里点 logo 会跳到 /edit/index.html 这类歧途。
     静态模式（file://）没有子目录，前缀为空串。
     --------------------------------------------------------------- */
  var DEEP = /\/(edit|p)(\/|$)/i.test(location.pathname);
  var BASE = DEEP ? '../' : '';
  function url(p) { return BASE + p; }

  /** 文章链接：服务器模式走干净 URL /p/<slug>；静态模式走 post.html?p= */
  function postUrl(slug) {
    return KY.store.isServerMode()
      ? url('p/' + encodeURIComponent(slug))
      : url('post.html?p=' + encodeURIComponent(slug));
  }

  /* ---------------------------------------------------------------
     顶栏 / 页脚
     --------------------------------------------------------------- */
  function mountChrome(active) {
    /* 服务器模式下数据到达后会重建页面：先拆掉旧的顶栏/页脚，否则会叠两层 */
    document.querySelectorAll('body > header, body > footer').forEach(function (n) { n.remove(); });
    /* 刻意不挂后台入口：/edit 不从前台任何地方链接出去 */
    var nav = [
      ['index.html', '首页'],
      ['index.html#posts', '文章'],
      ['index.html#about', '关于']
    ];
    var header = document.createElement('header');
    header.innerHTML =
      '<div class="logo"><a href="' + url('index.html') + '">' + esc(SITE.nameParts[0]) +
      '<em>' + esc(SITE.nameParts[1]) + '</em></a></div>' +
      '<nav>' +
      nav.map(function (n) {
        var on = (active === n[0].split('#')[0] && !n[0].includes('#')) ? ' class="is-active"' : '';
        return '<a href="' + url(n[0]) + '"' + on + '>' + n[1] + '</a>';
      }).join('') +
      '<button class="theme-toggle" data-theme-toggle><span data-theme-label>☾ 夜间</span></button>' +
      '</nav>';
    document.body.insertBefore(header, document.body.firstChild);
    mountFooter();
    initTheme();
  }

  /** 页脚单独成函数：站点设置变更（SSE site 事件）可热更新 */
  function mountFooter() {
    var old = document.querySelector('body > footer');
    if (old) old.remove();
    var footer = document.createElement('footer');
    /* 三件套：版权（年份区间自动）· 开源地址 · ICP 备案号。
       后两者来自 SITE（安装/站点设置填写），为空则整项不渲染 */
    var year = new Date().getFullYear();
    var since = SITE.since && String(SITE.since) !== String(year) ? SITE.since + '–' + year : String(year);
    var links = [];
    if (SITE.repoURL) {
      var repoText = String(SITE.repoURL).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      links.push('<a href="' + esc(SITE.repoURL) + '" target="_blank" rel="noopener">' + esc(repoText) + '</a>');
    }
    if (SITE.icp) {
      links.push('<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener nofollow">' + esc(SITE.icp) + '</a>');
    }
    if (SITE.police) {
      /* 公安备案：从"京公网安备xxxxxxxx号"里抽数字，链到公安部网络安全保卫局查询页 */
      var code = (String(SITE.police).match(/\d+/g) || ['']).join('');
      var mpsURL = code ? 'https://beian.mps.gov.cn/#/query/webSearch?code=' + code : 'https://beian.mps.gov.cn/';
      links.push('<a href="' + esc(mpsURL) + '" target="_blank" rel="noopener nofollow">' + esc(SITE.police) + '</a>');
    }
    footer.innerHTML =
      '<div class="foot-copy">© ' + esc(since) + ' ' + esc(SITE.name) +
        ' · 全部文字归作者所有' +
        (SITE.footerNote ? '<div class="foot-note">' + esc(SITE.footerNote) + '</div>' : '') +
      '</div>' +
      (links.length ? '<div class="foot-links">' + links.join('<span class="foot-sep">·</span>') + '</div>' : '');
    document.body.appendChild(footer);
  }

  /* ---------------------------------------------------------------
     通用片段
     --------------------------------------------------------------- */
  /**
   * 标签胶囊
   * @param {string} label 显示文字
   * @param {number} count 计数（0 不显示）
   * @param {boolean} active 是否选中
   * @param {string} [dataTag] data-tag 值，默认同 label；传空串表示"全部"
   */
  function chipHtml(label, count, active, dataTag) {
    var tag = dataTag === undefined ? label : dataTag;
    return '<button class="chip' + (active ? ' is-on' : '') + '" data-tag="' + esc(tag) + '">' +
      esc(label) + (count ? ' ' + count : '') + '</button>';
  }

  /** 首页列表条目 */
  function rowHtml(p) {
    return '<li class="post-row"><a href="' + postUrl(p.slug) + '">' +
      '<div class="date">' + esc(p.date || '') + '</div>' +
      '<div>' +
        '<h3>' + esc(p.title) + '</h3>' +
        '<p class="excerpt">' + esc(p.summary) + '</p>' +
        '<div class="chips">' +
          (p.tags || []).map(function (t) {
            return '<span class="chip" data-tag="' + esc(t) + '">' + esc(t) + '</span>';
          }).join('') +
          '<span class="small">约 ' + KY.store.readingTime(p.markdown) + ' 分钟</span>' +
        '</div>' +
      '</div></a></li>';
  }

  /* ---------------------------------------------------------------
     首页
     --------------------------------------------------------------- */
  function initHome() {
    var posts = KY.store.all();
    var tags = KY.store.tags();
    var state = { q: '', tag: '' };

    var main = document.getElementById('app');
    main.innerHTML =
      '<section class="hero">' +
        '<div>' +
          '<div class="kicker">个人博客 · 随笔 / 生活 / 杂想</div>' +
          '<h1>' + esc(SITE.nameParts[0]) + '<br>' + esc(SITE.nameParts[1]) + '</h1>' +
          '<p class="standfirst">' + esc(SITE.description) + '</p>' +
        '</div>' +
        '<div class="hero-meta">' +
          '<p><strong>作者</strong> —— ' + esc(SITE.author) + '</p>' +
          '<p><strong>已写</strong> —— ' + posts.length + ' 篇</p>' +
          '<p><strong>最近更新</strong> —— ' + esc(posts[0] ? posts[0].date : '—') + '</p>' +
          '<p><strong>标签</strong> —— ' + tags.slice(0, 5).map(function (t) { return esc(t.name); }).join('、') +
            (tags.length > 5 ? ' 等 ' + tags.length + ' 个' : '') + '</p>' +
        '</div>' +
      '</section>' +

      '<div class="wrap">' +
        '<div class="list-head" id="posts">' +
          '<h2>全部文章</h2>' +
          '<div class="filters">' +
            '<input class="search" type="search" placeholder="搜索标题或正文…" aria-label="搜索文章">' +
          '</div>' +
        '</div>' +
        '<div class="chips" id="tagBar" style="margin:14px 0 6px"></div>' +
        '<ul class="post-list" id="postList"></ul>' +
        '<div class="empty" id="emptyTip" hidden>没有匹配的文章。要么换个词，要么自己写一篇。</div>' +
      '</div>' +

      '<section class="wrap" id="about" style="padding-top:56px;padding-bottom:40px">' +
        '<div class="list-head"><h2>关于</h2></div>' +
        '<div class="prose" style="max-width:var(--measure);margin-top:22px">' +
          '<p>' + esc(SITE.name) + '，一个人的写字的地方。没有评论区，没有算法推荐，也没有"关注我"。' +
          '每篇写完就放在这，能看懂的人自然会看懂。</p>' +
          '<p>站名来自一个不太好笑的笑话：<em>' + esc(SITE.tagline) + '</em>。</p>' +
        '</div>' +
      '</section>';

    /* --- 标签栏：第一枚是"全部"（data-tag 为空串） --- */
    var tagBar = document.getElementById('tagBar');
    tagBar.innerHTML = chipHtml('全部', 0, true, '') +
      tags.map(function (t) { return chipHtml(t.name, t.count, false); }).join('');

    /* --- 列表渲染 --- */
    function renderList() {
      var q = state.q.trim().toLowerCase();
      var list = posts.filter(function (p) {
        if (state.tag && (p.tags || []).indexOf(state.tag) < 0) return false;
        if (!q) return true;
        return (p.title + ' ' + p.summary + ' ' + (p.markdown || '')).toLowerCase().indexOf(q) >= 0;
      });
      document.getElementById('postList').innerHTML = list.map(rowHtml).join('');
      document.getElementById('emptyTip').hidden = list.length > 0;
    }

    /* --- 筛选事件（事件委托，一处监听） --- */
    tagBar.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      var name = chip.getAttribute('data-tag');
      state.tag = (state.tag === name) ? '' : name;
      tagBar.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('is-on', c.getAttribute('data-tag') === state.tag);
      });
      renderList();
    });
    document.querySelector('.search').addEventListener('input', function (e) {
      state.q = e.target.value;
      renderList();
    });

    /* 点击列表里的标签 → 直接筛选（注意取 data-tag，不能取文字，文字里带计数） */
    document.getElementById('postList').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      e.preventDefault();               /* 不要跳转文章 */
      var name = chip.getAttribute('data-tag') || '';
      state.tag = name;
      tagBar.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('is-on', c.getAttribute('data-tag') === name);
      });
      renderList();
      document.getElementById('posts').scrollIntoView({ behavior: 'smooth' });
    });

    renderList();
    document.title = SITE.name + ' —— ' + SITE.tagline;

    /* 服务器模式：SSE 推来文章变更（别人发布了新文章）→ 重拉数据重渲染 */
    KY.store.onChange(function (kind) {
      if (kind && kind !== 'change') return;   /* site 事件由全局页脚回调处理 */
      posts = KY.store.all();
      tags = KY.store.tags();
      renderList();
      tagBar.innerHTML = chipHtml('全部', 0, true, '') +
        tags.map(function (t) { return chipHtml(t.name, t.count, false); }).join('');
    });
  }

  /* ---------------------------------------------------------------
     文章页
     --------------------------------------------------------------- */
  function initPost() {
    /* 三种取 slug 的方式（优先级从高到低）：
       ① 干净 URL：/p/<slug>（服务器模式，canonical 地址）
       ② 旧链接：post.html?p=<slug>（已 301，但 file:// 静态模式仍用）
       ③ hash 兜底：#<slug> */
    var slug = '';
    var m = location.pathname.match(/\/p\/([^\/?#]+)/);
    if (m) slug = decodeURIComponent(m[1]);
    if (!slug) slug = new URLSearchParams(location.search).get('p') ||
               decodeURIComponent((location.hash.match(/^#(.+)$/) || [])[1] || '');
    var post = slug ? KY.store.bySlug(slug) : null;
    var main = document.getElementById('app');

    if (!post) {
      main.innerHTML = '<div class="wrap" style="padding:120px 0 160px;text-align:center">' +
        '<div class="kicker">404</div>' +
        '<h1 style="font-size:38px;font-weight:500;margin-bottom:18px">这篇没有找到</h1>' +
        '<p class="muted" style="font-style:italic">可能是链接变了，也可能是我改了主意把它删了。</p>' +
        '<p style="margin-top:30px"><a href="' + url('index.html') + '">← 回到首页</a></p></div>';
      document.title = '没有找到 · ' + SITE.name;
      return;
    }

    var rendered = KY.md.render(post.markdown);
    var minutes = KY.store.readingTime(post.markdown);
    var count = KY.store.wordCount(post.markdown);
    var idx = KY.store.all().findIndex(function (p) { return p.slug === post.slug; });
    var newer = KY.store.all()[idx - 1];   /* 列表是倒序，前一篇更新 */
    var older = KY.store.all()[idx + 1];

    /* 目录：h2/h3 至少 3 条才值得占位置 */
    var toc = '';
    if (rendered.headings.length >= 3) {
      toc = '<nav class="toc"><h4>目录</h4><ol>' +
        rendered.headings.map(function (h) {
          return '<li class="lv-' + h.level + '"><a href="#' + h.id + '">' + esc(h.text) + '</a></li>';
        }).join('') + '</ol></nav>';
    }

    main.innerHTML =
      '<div class="progress" id="progress"></div>' +
      '<header class="post-head">' +
        '<div class="kicker">' + (post.tags || []).map(function (t) { return esc(t); }).join(' · ') + '</div>' +
        '<h1>' + esc(post.title) + '</h1>' +
        '<p class="standfirst">' + esc(post.summary) + '</p>' +
        '<div class="meta-row">' +
          '<span><strong>作者</strong> ' + esc(post.author || SITE.author) + '</span>' +
          '<span><strong>发布于</strong> ' + KY.store.formatDate(post.date) + '</span>' +
          '<span><strong>阅读时长</strong> 约 ' + minutes + ' 分钟</span>' +
          '<span><strong>字数</strong> ' + count + '</span>' +
        '</div>' +
      '</header>' +
      '<div class="post-body">' + toc +
        '<div class="prose" id="prose">' + rendered.html + '</div>' +
      '</div>' +
      '<nav class="post-nav">' +
        (newer ? '<a href="' + postUrl(newer.slug) + '">' +
          '<div class="dir">← 更新的一篇</div><div class="ttl">' + esc(newer.title) + '</div></a>' : '<span></span>') +
        (older ? '<a class="next" href="' + postUrl(older.slug) + '">' +
          '<div class="dir">更早的一篇 →</div><div class="ttl">' + esc(older.title) + '</div></a>' : '<span></span>') +
      '</nav>' +
      '<button class="back-top" id="backTop" aria-label="回到顶部">↑</button>';

    document.title = post.title + ' · ' + SITE.name;

    /* 首段首字下沉：只作用于正文第一个普通段落 */
    var firstP = document.querySelector('#prose > p');
    if (firstP && !firstP.classList.contains('lead')) firstP.classList.add('lead');

    /* 阅读进度 + 回到顶部 */
    var bar = document.getElementById('progress');
    var top = document.getElementById('backTop');
    function onScroll() {
      var h = document.documentElement.scrollHeight - innerHeight;
      bar.style.width = (h > 0 ? Math.min(100, (scrollY / h) * 100) : 0) + '%';
      top.classList.toggle('is-on', scrollY > 600);
    }
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    top.addEventListener('click', function () { scrollTo({ top: 0, behavior: 'smooth' }); });
  }

  /* ---------------------------------------------------------------
     下载卡片交互：全局事件委托，注册一次（正文/预览/后台通用）
       · 点"直链"→ 展开该卡片的 URL 行
       · 点"复制链接"→ 复制 URL 文本（clipboard API，http 下退 execCommand）
     --------------------------------------------------------------- */
  function mountDownloadCards() {
    if (mountDownloadCards._on) return;
    mountDownloadCards._on = true;
    document.addEventListener('click', function (e) {
      var toggle = e.target.closest('.dl-toggle');
      if (toggle) {
        var card = toggle.closest('.dl-card');
        var open = card.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? '收起' : '直链';
        return;
      }
      var copy = e.target.closest('.dl-copy');
      if (copy) {
        var code = copy.closest('.dl-url').querySelector('code');
        var text = code ? code.textContent : '';
        var done = function (ok) {
          var old = copy.textContent;
          copy.textContent = ok ? '已复制' : '复制失败';
          setTimeout(function () { copy.textContent = old; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
        } else {
          done(fallbackCopy(text));
        }
      }
    });
  }
  /* http/无 clipboard API 的兜底复制 */
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------
     启动
     ---------------------------------------------------------------
     数据层是异步探测的（服务器模式 or 静态模式，见 store.js）。
     策略：先按静态兜底立刻渲染（保证 file:// 打开也秒出内容），
     探测完成后若发现是服务器模式，再用服务器数据重渲染一次。
     个人博客数据量小，闪一次重渲染的代价 < 白屏等待的代价。 */
  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.getAttribute('data-page');
    mountDownloadCards();               /* 卡片交互全局一次，与页面无关 */
    function boot() {
      KY.store.clearChangeHandlers();   /* 重建前清掉旧订阅，防重复渲染 */
      mountChrome(page === 'home' ? 'index.html' : page === 'post' ? 'post.html' : '');
      if (page === 'home') initHome();
      if (page === 'post') initPost();
      /* 站点设置变更（后台保存）→ 任何页面页脚热更新 */
      KY.store.onChange(function (kind) {
        if (kind === 'site') mountFooter();
      });
    }
    boot();

    KY.store.ready.then(function (isServer) {
      if (isServer && (page === 'home' || page === 'post')) {
        KY.store.reload().then(boot);   // 用服务器数据重建页面
      }
    });
  });
})(window);
