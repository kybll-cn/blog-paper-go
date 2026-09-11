# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v1.0.0] - 2026-09-11

首个正式版本。单二进制个人博客系统。

### 新增
- **单二进制分发**：前台、写作后台、REST API、SSE 实时推送、安装向导全部 `go:embed` 进一个可执行文件；提供 Linux（amd64/arm64）与 Windows（amd64/arm64）四平台构建。
- **双模式数据层**：探测到后端 → 服务器模式（MariaDB 真发布）；探测不到（`file://` 或后端未启动）→ 纯静态模式（localStorage + manifest.js 导出兜底），零依赖可跑。
- **安装向导**：首次访问任意页面自动跳转 `/install`，填数据库连接、管理员账号、站点信息，程序自动建库建表并生成 `config.json`（0600）。
- **登录鉴权**：单管理员，无状态 HMAC 签名会话 Cookie（7 天），口令 salt + 迭代 SHA-256 存储，无第三方依赖。
- **写作后台**：`/edit`（前台无入口），Markdown 实时预览、草稿自动保存、工具栏快捷插入、导入/导出 `.md` 与 `manifest.js`。
- **上传系统**：后台一键传图/传件，扩展名白名单 + 大小上限 + 随机文件名；附件链接自动渲染为可展开直链、一键复制的下载卡片。
- **站点设置**：后台面板改站名/标语/简介/版权年/开源地址/ICP 备案号/公安备案号，保存即时热更新所有在线页面页脚。
- **SEO**：`/p/<slug>` 干净 URL，`title`/`description`/`canonical`/Open Graph/Twitter Card/JSON-LD 服务端直出；动态 `sitemap.xml` 与 `robots.txt`。
- **实时更新**：发布/删除/站点变更后经 SSE 推送，所有在线页面自动刷新，无需手动刷新。
- **主题**：书卷派 Editorial / Warm Minimalism（奶油纸色 + 衬线 + SVG 旧纸纹理），亮暗双主题，`?theme=dark|light` 可强制。

[unreleased]: https://github.com/kybll-cn/blog-paper-go/compare/v1.0.0...HEAD
[v1.0.0]: https://github.com/kybll-cn/blog-paper-go/releases/tag/v1.0.0
