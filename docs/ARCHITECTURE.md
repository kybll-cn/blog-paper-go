# 架构说明

本文解释「为什么这么设计」。安装与部署见 [DEPLOY.md](DEPLOY.md)，功能总览见 [README.md](../README.md)。

## 设计目标

1. **一个文件跑起来**：无构建、无运行时依赖（除 MariaDB），下载解压即用。
2. **后端可选**：没有后端时前端仍是一个能读能写的静态站，不强制绑定部署形态。
3. **零第三方框架**：Go 只用标准库 + `go-sql-driver/mysql`；前端零依赖（连 Markdown 渲染器都手写）。代码量小是特性，不是缺陷——审计面小，长期不腐烂。

## 双模式数据层（核心）

前端 `web/assets/store.js` 是唯一的数据出入口，页面代码只认 `all()/bySlug()/save()/remove()`，不关心底下是谁：

```
页面加载
  │
  ├─ fetch GET /api/posts（2s 超时）
  │     ├─ 成功（返回数组）→ 服务器模式
  │     │     · 文章快照存内存，写操作走 PUT/DELETE
  │     │     · 挂 EventSource 订阅 SSE
  │     │     · fetch /api/site 覆盖内置站点配置
  │     └─ 失败/超时/file:// → 纯静态模式
  │           · 内置文章 = posts/manifest.js（window.KY_BUILTIN_POSTS）
  │           · 本地文章 = localStorage（发布只进本机浏览器）
  │           · 上线 = 导出 manifest.js 覆盖 posts/
```

**为什么先渲染再切换**：探测是异步的，页面不能白屏等网络。策略是先按静态兜底立刻渲染（`file://` 秒开），`ready` Promise 解析出服务器模式后重建一次。个人博客数据量小，闪一次重渲染的代价远小于白屏等待。

**重建的代价**：重建会二次执行挂顶栏/页脚的逻辑，所以 `mountChrome` 开头先 `remove()` 旧的 `body > header/footer`，事件监听加 `_on` 幂等守卫，SSE 订阅列表提供 `clearChangeHandlers()`。少一处防抖，UI 就叠两层。

## 后端结构

单 package（`main`），按职责分文件：

| 文件 | 职责 |
| --- | --- |
| `main.go` | 路由装配、`go:embed`、安装模式分支、`-import` 迁移器 |
| `store.go` | MariaDB 四句 SQL（list/get/put/delete）+ SSE 广播器 + 建库建表 |
| `auth.go` | 无状态会话（HMAC 签名 Cookie）、登录/登出/me |
| `config.go` | `config.json` 读写、口令迭代哈希、站点信息默认值 |
| `seo.go` | 服务端直出 title/meta/OG/JSON-LD、`/p/<slug>`、sitemap、robots |
| `upload.go` | 图片/附件上传、白名单、`/uploads/*` 只读服务 |

### go:embed + 磁盘优先

前端全部资源在 `web/`，`//go:embed web` 打进二进制。资源加载**磁盘优先、embed 兜底**：

```go
// 先试 os.Open("web/"+rel)，命中就读磁盘
// 未命中走 fs.Sub(webFS, "web")
```

这样开发期改 `web/` 下的 CSS/JS 刷新即见、不用重编译；部署只拷一个 exe。**代价**：embed 里是编译那一刻的旧货——改了前端文件，发布前必须重新 `go build`。

### 鉴权：为什么不用用户体系

单作者博客，一个管理员就是全部。口令以 `salt + 迭代 SHA-256(1万轮)` 存 `config.json`，会话是 `user|过期秒|HMAC-SHA256(secret, user|过期秒)` 的无状态 Cookie——服务端不存 session，改 Secret（重装）即全体失效。写接口 401 → 前端跳 `/login?next=`。CSRF 靠「写接口只认 `application/json`」这道锁（跨站表单伪造不出这个 Content-Type）。

正统做法是 bcrypt/argon2 + session 存储，但那要引第三方依赖。单用户、默认小服务器场景，stdlib 方案够用且少两个依赖——这是有意识的取舍，不是偷懒。

### SSE 实时更新

`GET /api/events` 长连接，服务端维护 `map[chan string]bool` 广播器。写操作成功后 `hub.Broadcast("change"|"site")`，所有在线页面收到即重拉数据重渲染。

- 只推事件不推数据：数据仍走 GET，逻辑简单、不怕丢事件。
- 通道带缓冲（8），满了丢弃不阻塞写路径（掉线的客户端不该拖慢发布）。
- 25s 心跳注释帧防代理掐空闲连接；`retry: 3000` 断线自动重连。

### SEO 为什么服务端直出

爬虫不执行 JavaScript。所以 `/` 和 `/p/<slug>` 的 `title`/`description`/`canonical`/OG/Twitter/JSON-LD 全部由 Go 在返回 HTML 前生成——模板里放 `<!--SEO:HEAD-->…兜底…<!--SEO:HEAD-END-->`，`servePageT` 按请求整块替换。纯静态模式不替换，兜底 meta 原样输出（注释对浏览器不可见），一份模板两模式共用。

替换用 `ReplaceAllStringFunc` 而非 `ReplaceAllString`——JSON-LD 里的 `$` 会被后者当捕获组引用吃掉。

## 已知边界（刻意的取舍）

- **单管理员**：多作者需要 users 表 + 角色，当前架构不覆盖。
- **无评论**：无用户体系的必然结果。
- **上传文件不进 embed**：`uploads/` 是运行期产物，换服务器要单独迁移。
- **Markdown 渲染器自研**（约 400 行）：不支持 HTML 直通（转义，安全优先）、嵌套强调只解析一层。够用就不加复杂度。
- **v1.0.0 无自动迁移**：表结构变更需手动执行 SQL，重大变更会在 CHANGELOG 标注。
