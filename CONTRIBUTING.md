# 贡献指南

感谢你有兴趣动这个仓库。以下约定能让我们都省时间。

## 开发环境

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Go | ≥ 1.27 | 后端（唯一第三方依赖：`go-sql-driver/mysql`） |
| Node.js | ≥ 22 | 前端自检与验收脚本（零 npm 依赖，不用 `npm install`） |
| MariaDB | 10.x / 12.x | 数据库（本项目在 12.3 验证） |

```bash
git clone https://github.com/kybll-cn/blog-paper-go.git && cd blog-paper-go
go build -o kongyu .

# 起一个本地 MariaDB，然后运行程序，浏览器打开 http://localhost:8080
# 首次自动进 /install 向导（填你本地数据库的连接信息即可）
./kongyu
```

前端资源在 `web/` 下，**改文件刷新即见**（磁盘优先于 embed，不用重编译）。

## 目录地图

```
├── *.go              后端（单 package main，按职责分文件）
├── web/              前端：页面 + assets（go:embed 进二进制）
├── tools/            开发期脚本（自检/验收/探针，不参与运行）
│   └── lib/cdp.js    零依赖 CDP 客户端（需本机 Chrome，验收脚本共用）
├── docs/             部署与架构文档
└── .github/workflows CI 与自动发布
```

## 测试

提交前跑这两样，CI 也跑这两样：

```bash
node tools/selftest.js        # 56 项断言：Markdown 解析 + 数据层双模式
go vet ./... && go build ./...
```

端到端验收（需服务在 8080 运行 + 本机 Chrome）：

```bash
node tools/browser-verify.js   # 登录门禁 → 回跳 → 发布 → SSE 同步
node tools/upload-verify.js    # 真上传 → 下载卡片 → 站点设置回填
```

测试账号走环境变量（默认本地开发口令）：`KY_TEST_USER` / `KY_TEST_PASS`。

## 约定

- **代码风格**：Go 用 `gofmt`（CI 会检查）；注释写"为什么"而不是"是什么"，中文注释欢迎。
- **前端零依赖**：不要引入任何 npm 包或 CDN 资源（Google Fonts 尤其禁止——国内不可达时 render-blocking 会卡首屏 10 秒，血泪教训）。
- **stdlib 优先**：新依赖需要充分理由，PR 里请说明为什么标准库做不到。
- **双模式不破**：任何前端改动都要保证 `file://` 双击仍可用（store.js 的静态兜底路径）。
- **样式**：改视觉前先读 README「设计参数」一节——那是一份调了五轮的定稿配方，别凭感觉改。

## 提交与发布

- 直接开 PR，描述里说清楚动机；小修复不用先开 Issue。
- 版本号遵循 SemVer，改动记入 `CHANGELOG.md`。
- 发布：维护者打 `v*` 标签 → GitHub Actions 自动交叉编译四平台并发布 Release：

```bash
bash build-release.sh v1.0.1     # 本地复现构建（Linux tar.gz + Windows zip）
git tag v1.0.1 && git push origin v1.0.1   # 触发自动发布
```

## 安全漏洞

请发私信/邮件给维护者，**不要开公开 Issue**，给我们留出修复窗口。
