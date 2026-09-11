# 部署指南

本文面向把博客跑在服务器上的人。开发/本地体验见 [README](../README.md)。

## 一、前置条件

- **MariaDB 10.x / 12.x**（或 MySQL 5.7+，本项目在 MariaDB 12.3 上验证）。
- 服务器能访问数据库端口（同机部署用 `127.0.0.1:3306` 即可）。
- 下载对应平台的发布包（见 [Releases](https://github.com/kybll-cn/blog-paper-go/releases)）：

  | 平台 | 包 | 典型场景 |
  | --- | --- | --- |
  | Linux x86_64 | `kongyu-linux-amd64.tar.gz` | 大多数云服务器 |
  | Linux ARM64 | `kongyu-linux-arm64.tar.gz` | 树莓派 / 阿里云 ARM / AWS Graviton |
  | Windows x64 | `kongyu-windows-amd64.zip` | Windows 服务器 |
  | Windows ARM64 | `kongyu-windows-arm64.zip` | Surface / ARM 云主机 |

  每个包附 `*.sha256`，下载后 `sha256sum -c` 校验完整性。

## 二、首次部署（三步）

```bash
# 1. 解压
tar xzf kongyu-linux-amd64.tar.gz && cd kongyu-linux-amd64
# Windows: 解压 zip 即可

# 2. 运行（默认监听 :8080）
./kongyu-linux-amd64
# Windows: 双击 kongyu-windows-amd64.exe，或命令行运行

# 3. 浏览器打开 http://服务器IP:8080
#    → 自动跳转 /install 安装向导
#    → 填数据库连接 + 管理员账号 + 站点信息 → 安装
#    → 完成后自动跳 /login，登录即可写作
```

安装向导会：连接数据库 → `CREATE DATABASE IF NOT EXISTS` → 建表 → 生成 `config.json`（含随机盐、口令哈希、会话密钥，权限 0600）。

> 重装：删掉 `config.json` 重启，回到安装向导。数据库里的文章不受影响。

## 三、生产环境

### 3.1 systemd（Linux 推荐）

```ini
# /etc/systemd/system/kongyu.service
[Unit]
Description=Kongyu Blog
After=network.target mariadb.service

[Service]
Type=simple
User=kongyu
WorkingDirectory=/opt/kongyu
ExecStart=/opt/kongyu/kongyu-linux-amd64
Environment=KY_ADDR=127.0.0.1:8080
Restart=on-failure
# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/kongyu/uploads /opt/kongyu/config.json
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kongyu
journalctl -u kongyu -f          # 看日志
```

### 3.2 Nginx 反向代理 + HTTPS

博客本身只监听本地端口，对外由 Nginx 终结 TLS。

```nginx
server {
    listen 443 ssl http2;
    server_name blog.example.com;

    ssl_certificate     /etc/nginx/fullchain.pem;
    ssl_certificate_key /etc/nginx/privkey.pem;

    client_max_body_size 20m;          # 与上传上限对齐，否则大附件被网关先掐

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;   # 关键：SEO canonical/OG 靠它识别 https

        # SSE 实时推送：关掉缓冲，否则 change 事件被 Nginx 攒着不下发
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
```

`X-Forwarded-Proto: https` 让程序知道外部是 HTTPS，生成的 canonical/OG/sitemap 才会用 `https://`，不会误导爬虫和分享卡片。

### 3.3 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KY_ADDR` | `:8080` | 监听地址。反代后建议 `127.0.0.1:8080` 只监听本地 |

其余配置（数据库、站点信息、密钥）都在 `config.json`，由安装向导生成。

## 四、数据与备份

需要备份的只有两样：

1. **数据库**：`mysqldump -u root -p --databases kongyu > backup.sql`
2. **`config.json`**：含站点配置与密钥（丢了要重装，且旧会话 Cookie 全部失效）
3. **`uploads/`**：上传的图片/附件（运行期产物，不在二进制里）

恢复：还原数据库 + 放回 `config.json` 与 `uploads/` 即可，程序本身无状态。

## 五、安全须知

- `config.json` 含数据库密码与管理员口令哈希，**权限务必 0600**，且已在 `.gitignore` 中——切勿提交到公开仓库。
- 安装向导仅在**未安装时**（无 config.json）开放。装好后 `/api/install` 直接返回 400，无法二次提交。
- 写接口（发布/删除/上传/站点设置）全部要求登录会话；未登录返回 401。
- 公网部署请把管理员密码换成强密码（安装时设），并考虑在 Nginx 层对 `/login` 做限流。

## 六、升级

```bash
# 停服务 → 换二进制 → 起服务。config.json 与 uploads/ 不动，数据无损
sudo systemctl stop kongyu
cp /new/path/kongyu-linux-amd64 /opt/kongyu/kongyu-linux-amd64
sudo systemctl start kongyu
```

跨版本升级若涉及表结构变更，会在 CHANGELOG 标注；v1.0.0 阶段无自动迁移，重大变更需手动执行 SQL。
