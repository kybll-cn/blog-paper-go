# 空雨不流泪 · 个人博客

[![CI](https://github.com/kybll-cn/blog-paper-go/actions/workflows/ci.yml/badge.svg)](https://github.com/kybll-cn/blog-paper-go/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kybll-cn/blog-paper-go)](https://github.com/kybll-cn/blog-paper-go/releases)
[![Go Version](https://img.shields.io/badge/Go-1.27-00ADD8?logo=go)](https://go.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Zero Dependency](https://img.shields.io/badge/前端依赖-0-brightgreen)](#六改成你自己的)

一个**单二进制**个人博客：`kongyu` 里装着前台、写作后台、REST API、SSE 实时推送、安装向导。数据库用 MariaDB。不跑后端时，`web/` 下的页面双击也能以纯静态模式工作。

- 风格：书卷派 Editorial / Warm Minimalism（奶油纸色 + 衬线 + SVG 旧纸纹理，亮暗双主题）
- 写作格式：Markdown（自带渲染器，零依赖）
- 登录：安装向导创建唯一管理员账号；会话 Cookie（HMAC 签名，7 天）
- 实时更新：发布/删除后服务端经 SSE 推 `change` 事件，所有在线页面自动刷新列表
- 写作后台：`/edit`（前台无任何入口），左边写 Markdown，右边实时预览，发布一键进库
- 上传系统：后台一键传图/传件（`POST /api/upload`），附件链接自动渲染成下载卡片（可展开直链、一键复制）
- 站点设置：后台面板改站名/标语/简介/版权年/开源地址/ICP 备案号/公安备案号，保存即时热更新所有在线页面页脚

---

## 一、怎么跑起来

### 服务器模式（推荐）

```bash
# 1. 编译（或直接拿仓库里的 kongyu.exe）
go build -o kongyu.exe .

# 2. 运行。首次访问任意页面会自动跳 /install 安装向导：
#    填 MariaDB 地址/端口/账号/库名 + 管理员用户名密码 + 站点信息（站名/标语/简介/作者）
#    → 自动 CREATE DATABASE、建表、生成 config.json（0600）
./kongyu.exe

# 3.（可选）把 web/posts/manifest.js 里的旧文章导入数据库
./kongyu.exe -import
```

打开 `http://localhost:8080`：前台免登录阅读；`/login` 登录写作；`/edit` 进后台。
改过前端文件后重新 `go build` 即可把新 `web/` 打进二进制（部署只需拷走 exe 一个文件）。

重装：删 `config.json` 重启，回到安装向导。

### 纯静态模式（零依赖兜底）

用任意静态服务器指向 `web/`（或双击 `web/index.html`）。前端探测不到 `/api/posts` 会自动降级：发布 = 存本机浏览器，上线靠导出 `manifest.js`。

**API 一览**（写操作需登录会话 Cookie，未登录返回 401 并触发前端跳 `/login`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/posts` | 全部文章（日期倒序，公开） |
| GET | `/api/posts/{slug}` | 单篇（公开） |
| PUT | `/api/posts/{slug}` | 发布/更新（需登录，按 slug upsert） |
| DELETE | `/api/posts/{slug}` | 删除（需登录） |
| GET | `/api/events` | SSE 变更推送（公开，只推事件不推数据） |
| POST | `/api/login` `/api/logout` | 会话管理 |
| GET | `/api/me` | 当前登录态 |
| GET | `/api/site` | 站点信息（站名/标语/简介/作者/开源地址/ICP/公安备案，公开） |
| PUT | `/api/site` | 站点设置保存（需登录，SSE 广播 site 热更新页脚） |
| POST | `/api/upload` | 上传图片/附件（需登录，multipart 字段 `file`） |
| GET | `/uploads/*` | 上传文件只读访问（`?dl=文件名` 触发下载头） |
| POST | `/api/install` | 安装向导提交（仅未安装时开放） |

### SEO（服务器模式专属）

- **服务端直出**：`/` 与 `/p/<slug>` 的 `<title>`、`description`、`canonical`、Open Graph、Twitter Card、JSON-LD（`WebSite` / `BlogPosting`）全部由 Go 按数据库与安装配置实时生成——爬虫不执行 JS 也能拿到首屏信息。纯静态模式（`file://`）保留模板兜底 meta。
- **干净 URL**：文章规范地址是 `/p/<slug>`（中文 slug 自动 percent-encode）。旧的 `post.html?p=<slug>` 与 `/index.html` 均 301 跳转，权重不丢、不留重复内容。
- **动态 sitemap**：`/sitemap.xml` 实时列出库中全部文章（含 lastmod）。
- **动态 robots**：`/robots.txt` 屏蔽 `/edit` `/login` `/install` `/api/`，并自动带上当前域名的 `Sitemap:` 行——换域名零配置。
- **canonical 自适应**：从 `Host` / `X-Forwarded-Proto` / `X-Forwarded-Host` 推断站点绝对地址，Nginx 反代 + HTTPS 终结下无需改代码。

环境变量：`KY_ADDR`（监听地址，默认 `:8080`）。其余配置（数据库参数、管理员哈希、会话密钥）都在 `config.json`。

## 二、目录结构

```
www/
├── main.go               路由装配：页面/API/SSE/安装向导 + go:embed
├── seo.go                服务端直出：title/meta/OG/JSON-LD、/p/<slug>、sitemap、robots
├── store.go              MariaDB 四句 SQL + SSE 广播器 + 建库建表
├── auth.go               登录与会话（HMAC 签名 Cookie，无状态）
├── config.go             config.json 读写 + 迭代 SHA-256 口令哈希
├── kongyu.exe            编译产物（前端全部 embed 在内，单文件部署）
├── config.json           安装向导生成（0600，含密码哈希，勿提交仓库）
├── web/                  前端（go:embed 进二进制；磁盘存在时优先读磁盘，改样式刷新即见）
│   ├── index.html        首页：Hero + 文章列表（标签筛选 / 搜索）+ 关于
│   ├── post.html         文章页：post.html?p=<slug>
│   ├── edit.html         写作后台（路由 /edit/，前台无入口，robots noindex）
│   ├── login.html        登录页
│   ├── install.html      安装向导
│   ├── assets/           style.css / markdown.js / store.js / app.js
│   └── posts/            src/*.md 源文件 + manifest.js（静态模式内置数据）
├── tools/
│   ├── build-manifest.js 把 web/posts/src/*.md 编译成 manifest.js
│   ├── selftest.js       渲染器 + 数据层自检（56 项断言）
│   ├── perf-probe.js     CDP 加载性能探针
│   └── browser-verify.js 登录/门禁/发布链路浏览器验收
└── preview/              验收截图
```

## 三、上传与附件

后台工具栏两个按钮：**传图**（`![名字](/uploads/…)`）、**传件**（`[名字](/uploads/…)`）。文件落盘 `uploads/YYYYMM/随机名.ext`（按月归档，随机名防覆盖防枚举），扩展名白名单（图片 + 文档 + 压缩包 + 音视频），上限 20MB。

附件链接（pdf/zip/docx/mp4…）在正文里自动渲染成**下载卡片**：类型徽标 + 文件名 + 下载按钮 + "直链"展开（显示完整 URL，一键复制）。普通链接不受影响。

> `uploads/` 是运行期产物，不在 embed 里——部署换机器记得把它一起拷走（或挂对象存储）。Nginx 反代记得 `client_max_body_size 20m`。

## 四、写文章的三种姿势

### 方式 A：后台 + 服务器模式（真发布，推荐）

后端跑起来后打开 `/edit`（未登录会跳 `/login`），徽标显示「已连后端 · 已登录」：

1. 填标题 / 日期 / 标签 / 导语，正文用 Markdown 写（工具栏有快捷插入，`Ctrl+S` 存草稿）
2. 点 **发布到本站** —— 写入 MariaDB，**所有在线前台经 SSE 推送自动更新，无需刷新**
3. 删除同理，真删

### 方式 B：后台 + 纯静态模式（后端没跑时自动降级）

「发布到本站」= 存本机浏览器（只有你看得到）。要上线：点「导出 manifest.js」覆盖 `web/posts/manifest.js`。

### 方式 C：直接用编辑器写 `.md`

```bash
# 1. 把文章丢进 web/posts/src/，文件名随意，建议用 slug
# 2. front matter 写元信息
cat > web/posts/src/wo-de-xin-wen.md <<'EOF'
---
title: 我的新文章
date: 2026-09-10
tags: 随笔, 生活
summary: 一句话导语（留空会自动取正文首段）
---

## 小标题

正文……
EOF

# 3. 生成数据文件（静态模式用；服务器模式用 -import 导入）
node tools/build-manifest.js
./kongyu.exe -import
```

### 上线

- **服务器模式**：发布即上线。部署 = 拷走 `kongyu.exe` 一个文件（首次运行走 /install 向导配数据库），Nginx 反代到 `:8080` 即可。
- **纯静态模式**：把导出的 `manifest.js` 覆盖到 `web/posts/manifest.js`，把 `.md` 放进 `web/posts/src/` 归档，然后部署 `web/` 目录（Nginx 静态托管、COS/GitHub Pages/任意静态空间都行）。

## 五、支持的 Markdown

| 语法 | 写法 | 备注 |
| --- | --- | --- |
| 标题 | `#` ~ `######`，或下划线式 `===` / `---` | H2 自动编号（一、二、三），进入目录 |
| 强调 | `**粗**` `*斜*` `~~删~~` | 链接文字里也能用 |
| 代码 | `` `行内` `` / 围栏 ` ```js ` | 代码块保留原样，只做转义 |
| 引用 | `> 内容` | 橙色左边线 + 斜体大字 |
| 列表 | `-` `*` `+` / `1.` | 支持嵌套，缩进 2 空格起 |
| 表格 | `| 列 | 列 |` + `| --- | --- |` | 表头大写小字距 |
| 链接 / 图片 | `[文字](url)` `![图](url)` | 外链自动 `target="_blank"` |
| 自动链接 | 直接写 URL | 中文语境里保留空格才识别 |
| 分割线 | `---` | |
| 硬换行 | 行尾两个空格，或行尾 `\` | |
| Front matter | `---` 包裹的 `key: value` | `tags` 支持 `a, b` 或 `[a, b]` |

**排版小规矩**：正文第一个段落自动首字下沉；H2 会拿到中文编号；目录在 h2/h3 超过 3 条时才出现。

**已知边界**（刻意的取舍，够用就不加复杂度）：不支持 HTML 直通（会被转义，安全优先）；嵌套的强调语法（如 `**粗*斜*粗**` 里再嵌斜体）只解析一层。

## 六、改成你自己的

**首选：后台"站点设置"面板**（`/edit` → 站点设置）——站名、作者、标语、简介、版权起始年、开源地址、ICP 备案号、公安备案号，保存即写回 `config.json`，所有在线页面页脚热更新，不用改一行代码。

纯静态模式（没后端）下，站点信息在 `web/assets/store.js` 顶部的 `SITE`：

```js
var SITE = {
  name: '空雨不流泪',
  nameParts: ['空雨', '不流泪'],   // 顶栏 logo 的双色拆分
  tagline: '雨没下，就别撑伞',
  description: '……',              // 首页导语
  author: '空雨',
  since: '2021',                  // 版权起始年
  repoURL: 'https://github.com/…',// 页脚开源地址（空则不显示）
  icp: '',                        // ICP 备案号（空则不显示）
  police: '',                     // 公安备案号（空则不显示）
  footerNote: '……'
};
```

服务器模式下这份只是兜底默认值，会被 `/api/site` 覆盖。配色和纹理参数都在 `assets/style.css` 顶部的 CSS 变量里。

## 七、验收与自检

```bash
node tools/selftest.js            # 56 项断言：行内/块级解析、边界、数据层往返、双模式降级
```

浏览器验收（`preview/` 目录，需起本地服务或直接双击）：

- `verify-elements.html` —— 所有渲染元素的厨房水槽，`?theme=dark` 看暗版
- `verify-mobile.html` —— 用 iframe 强制 390px 真实移动视口（Windows 下 Chrome 无头模式窗口宽度有最小值，直接 `--window-size=390` 会被夹到 500px）

主题可以用 URL 参数强制指定，方便分享和验收：`index.html?theme=dark`。

自动化验收脚本（需本机 Chrome，走 CDP）：

```bash
node tools/browser-verify.js    # 登录门禁 → 回跳 → 发布 → SSE 同步 全链路
node tools/upload-verify.js     # 真上传 → 下载卡片 → 直链展开 → 站点设置回填
node tools/perf-probe.js        # 加载时间线探针（资源耗时排行）
```

## 八、设计参数（多轮实测定稿，别凭感觉改）

- 纸色 `#f5f0e6`（再黄就成出土文物了）；暗色底 `#171310` 暖褐，字 `#e8ddc8` 暗奶油
- 旧感**由纹理层演出**，底色只负责微暖 —— 两头一起使劲就脏
- 纹理全部内联 SVG data-uri，零图片请求：颗粒 3 层 / 纤维丝 2 层 / 木屑 2 层 / 狐斑 10 团
- 去网格感的关键：贴图块尺寸全取质数（421/313/257/1103/887/907/613），同种纹理叠**互质两层** + 质数平移，合成重复周期百万像素级
- 暗色模式纹理必须切 `mix-blend-mode: screen`（multiply 在深底上等于隐身）
- 正文列宽 `min(86vw, clamp(560px, 42vw + 180px, 960px))`，桌面端行长封顶 40–45 汉字
- 纸的痕迹 `position: absolute` 跟纸走；视口暗角 `position: fixed` 跟眼睛走
- 换肤 0.35s 过渡 —— 像拉窗帘，不像断电

---

## 九、文档与贡献

| 文档 | 内容 |
| --- | --- |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 生产部署：systemd、Nginx 反代 + HTTPS、备份恢复、安全须知 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构说明：双模式数据层、SSE 广播、embed 策略、鉴权设计 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录（SemVer） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、构建、测试、发布流程 |
| [build-release.sh](build-release.sh) | 四平台交叉编译脚本（Linux/Windows × amd64/arm64） |
| [.github/workflows/](.github/workflows) | CI 每次 push 跑 vet/自检/交叉编译；推 `v*` 标签自动发布 Release |

许可证：[MIT](LICENSE)。欢迎提 Issue / PR；安全问题请直接私信，别开公开 Issue。
