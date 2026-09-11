// ============================================================================
// 空雨不流泪 · 单二进制站点
// ----------------------------------------------------------------------------
// 一个 kongyu.exe = 前台 + 写作后台 + REST API + SSE 实时推送 + 安装向导。
// 前端资源用 go:embed 打进二进制（web/ 目录）；开发时磁盘文件优先，
// 改 HTML/CSS/JS 刷新即见，不用重编译。
//
// 首次运行：浏览器打开任意页面 → 自动跳 /install 安装向导，
// 填数据库地址、库名、管理员账号 → 自动建库建表 → 写 config.json → 重启生效。
// 之后：/login 登录，/edit 写作，发布后所有在线前台经 SSE 自动更新。
//
// 环境变量：KY_ADDR（监听地址，默认 :8080）。其余配置都在 config.json。
// ============================================================================
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"regexp"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

var (
	cfgAddr = getenv("KY_ADDR", ":8080")
	// version 由构建注入：go build -ldflags "-X main.version=v1.0.0"
	version = "dev"
	// slug 白名单：字母数字下划线连字符 + 中文（Go 的 RE2 不认 \u，要写 \x{}）
	slugRe = regexp.MustCompile(`^[\w\-\x{4e00}-\x{9fff}]{1,191}$`)
)

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ---------------------------------------------------------------------------
// 资源：磁盘优先（开发热更新），embed 兜底（单文件部署）
// ---------------------------------------------------------------------------

// 站点根目录 = 可执行文件所在目录（go run 时是工作目录）。
// 磁盘上存在 web/ 时直接读磁盘，方便改前端不重编译。
var webDir = "web"

// openWeb 按相对路径找页面：先磁盘后 embed
func openWeb(rel string) (io.ReadCloser, bool) {
	if f, err := os.Open(path.Join(webDir, rel)); err == nil {
		return f, true
	}
	f, err := webFS.Open("web/" + rel)
	if err != nil {
		return nil, false
	}
	return f, true
}

// servePage 把 web/ 下的一个 HTML 文件挂到指定路径
func servePage(w http.ResponseWriter, r *http.Request, rel string) {
	servePageT(w, r, rel, nil)
}

// servePageT 输出页面并做占位符替换（SEO 服务端直出的关键）。
// 模板用 <!--SEO:HEAD--> … <!--SEO:HEAD-END--> 圈住兜底 title/meta 区，
// 服务器模式整块替换为实时生成的 meta（含 canonical/OG/JSON-LD）；
// 纯静态模式（file://）原样输出兜底区，注释对浏览器不可见，页面照常工作。
var seoHeadRe = regexp.MustCompile(`(?s)<!--SEO:HEAD-->.*?<!--SEO:HEAD-END-->`)

func servePageT(w http.ResponseWriter, r *http.Request, rel string, data map[string]string) {
	f, ok := openWeb(rel)
	if !ok {
		http.Error(w, "页面缺失", 404)
		return
	}
	defer f.Close()
	body, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "页面读取失败", 500)
		return
	}
	html := string(body)
	if block, has := data["head"]; has {
		// ReplaceAllStringFunc：不解析替换串里的 $，防 JSON-LD 里的 $ 被当捕获组
		html = seoHeadRe.ReplaceAllStringFunc(html, func(string) string { return block })
	}
	if data["abs"] != "" {
		// 干净 URL（/p/<slug>）比根目录深一层：相对资源路径 assets/、posts/
		// 会被浏览器解析到 /p/ 下 → 404。整页改写成站点根绝对路径。
		html = strings.ReplaceAll(html, `"assets/`, `"/assets/`)
		html = strings.ReplaceAll(html, `"posts/`, `"/posts/`)
	}
	for k, v := range data {
		if k == "head" || k == "abs" {
			continue
		}
		html = strings.ReplaceAll(html, "<!--SEO:"+k+"-->", v)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	io.WriteString(w, html)
}

// staticFS 兜底静态资源（assets/、posts/、favicon 等）
func staticHandler() http.Handler {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal("embed 资源异常：", err)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/")
		// 防目录穿越：%2e%2e 解码后的 .. 不会经过 mux 的路径清理
		if strings.Contains(rel, "..") {
			http.Error(w, "nope", http.StatusBadRequest)
			return
		}
		// 根路径 → 首页
		if rel == "" {
			servePage(w, r, "index.html")
			return
		}
		// 目录（磁盘模式可能命中）→ 找里面的 index.html
		if st, err := os.Stat(path.Join(webDir, rel)); err == nil && st.IsDir() {
			servePage(w, r, path.Join(rel, "index.html"))
			return
		}
		// 磁盘优先：开发期改 CSS/JS 立刻生效
		if f, err := os.Open(path.Join(webDir, rel)); err == nil {
			defer f.Close()
			setMIME(w, rel)
			w.Header().Set("Cache-Control", "no-cache")
			io.Copy(w, f)
			return
		}
		if strings.HasSuffix(rel, ".html") {
			http.NotFound(w, r)
			return
		}
		setMIME(w, rel)
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, r, sub, rel)
	})
}

func setMIME(w http.ResponseWriter, name string) {
	switch {
	case strings.HasSuffix(name, ".css"):
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case strings.HasSuffix(name, ".js"):
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case strings.HasSuffix(name, ".json"):
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
}

// ---------------------------------------------------------------------------
// JSON 与错误
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func errBody(msg string) map[string]any { return map[string]any{"error": msg} }

func today() string { return time.Now().Format("2006-01-02") }

// ---------------------------------------------------------------------------
// 文章 API
// ---------------------------------------------------------------------------

// apiPosts GET 公开；PUT/DELETE 需登录（Cookie 会话），成功后 SSE 广播
func apiPosts(cfg *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET,PUT,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}

		slug := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/posts"), "/")

		// ---- 集合：GET /api/posts ----
		if slug == "" {
			if r.Method != http.MethodGet {
				writeJSON(w, 405, errBody("只支持 GET"))
				return
			}
			posts, err := listPosts()
			if err != nil {
				writeJSON(w, 500, errBody("查询失败："+err.Error()))
				return
			}
			writeJSON(w, 200, posts)
			return
		}

		if !slugRe.MatchString(slug) {
			writeJSON(w, 400, errBody("slug 不合法"))
			return
		}

		switch r.Method {
		case http.MethodGet:
			p, err := getPost(slug)
			if err != nil {
				writeJSON(w, 500, errBody("查询失败："+err.Error()))
				return
			}
			if p == nil {
				writeJSON(w, 404, errBody("文章不存在"))
				return
			}
			writeJSON(w, 200, p)

		case http.MethodPut:
			if currentUser(r, cfg.Secret) == "" {
				writeJSON(w, 401, errBody("未登录"))
				return
			}
			var p Post
			if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&p); err != nil {
				writeJSON(w, 400, errBody("JSON 解析失败："+err.Error()))
				return
			}
			// URL 里的 slug 为准，防止请求体篡改去覆盖别人的文章
			p.Slug = slug
			if strings.TrimSpace(p.Title) == "" || strings.TrimSpace(p.Markdown) == "" {
				writeJSON(w, 400, errBody("标题和正文不能为空"))
				return
			}
			if p.Date == "" {
				p.Date = today()
			}
			if err := putPost(&p); err != nil {
				writeJSON(w, 500, errBody("写入失败："+err.Error()))
				return
			}
			hubInstance.Broadcast("change") // 在线前台即刻更新
			writeJSON(w, 200, map[string]any{"ok": true, "slug": p.Slug})

		case http.MethodDelete:
			if currentUser(r, cfg.Secret) == "" {
				writeJSON(w, 401, errBody("未登录"))
				return
			}
			ok, err := deletePost(slug)
			if err != nil {
				writeJSON(w, 500, errBody("删除失败："+err.Error()))
				return
			}
			if !ok {
				writeJSON(w, 404, errBody("文章不存在"))
				return
			}
			hubInstance.Broadcast("change")
			writeJSON(w, 200, map[string]any{"ok": true})

		default:
			writeJSON(w, 405, errBody("方法不支持"))
		}
	}
}

// ---------------------------------------------------------------------------
// 安装向导：无 config.json 时全站跳 /install，填完即建库建表建管理员
// ---------------------------------------------------------------------------

func handleInstallGet(w http.ResponseWriter, r *http.Request) {
	servePage(w, r, "install.html")
}

// handleInstallPost POST /api/install —— 表单校验 → 试连数据库 → 建库建表 → 落盘 config
func handleInstallPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host     string `json:"host"`
		Port     string `json:"port"`
		User     string `json:"user"`
		Pass     string `json:"pass"`
		DB       string `json:"db"`
		Admin    string `json:"admin"`
		Password string `json:"password"`
		// 站点信息（可留空，留空用默认值）
		SiteName    string `json:"site_name"`
		SiteTagline string `json:"site_tagline"`
		SiteDesc    string `json:"site_desc"`
		SiteAuthor  string `json:"site_author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, errBody("请求格式错误"))
		return
	}
	if body.Host == "" || body.User == "" || body.DB == "" || body.Admin == "" || body.Password == "" {
		writeJSON(w, 400, errBody("数据库与管理员字段都是必填的"))
		return
	}
	if body.Port == "" {
		body.Port = "3306"
	}
	if len(body.Password) < 6 {
		writeJSON(w, 400, errBody("管理员密码至少 6 位"))
		return
	}

	c := &Config{
		DBHost: body.Host, DBPort: body.Port, DBUser: body.User,
		DBPass: body.Pass, DBName: sanitizeIdent(body.DB),
		AdminUser:   strings.TrimSpace(body.Admin),
		AdminSalt:   randomHex(16),
		Secret:      randomHex(32),
		SiteName:    strings.TrimSpace(body.SiteName),
		SiteTagline: strings.TrimSpace(body.SiteTagline),
		SiteDesc:    strings.TrimSpace(body.SiteDesc),
		SiteAuthor:  strings.TrimSpace(body.SiteAuthor),
	}
	c.applyDefaults() // 站点信息留空 → 内置默认
	c.AdminHash = hashPassword(body.Password, c.AdminSalt)

	// 先试连：密码错/端口不通在这里就报给用户，别等建表建一半
	if err := migrate(c); err != nil {
		writeJSON(w, 400, errBody("数据库连接/初始化失败："+err.Error()))
		return
	}
	if err := saveConfig(c); err != nil {
		writeJSON(w, 500, errBody("config.json 写入失败："+err.Error()))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

func main() {
	doImport := flag.Bool("import", false, "把 web/posts/manifest.js 导入数据库后退出（迁移旧文章）")
	showVer := flag.Bool("version", false, "打印版本号后退出")
	flag.Parse()

	if *showVer {
		fmt.Printf("kongyu %s\n", version)
		return
	}

	mux := http.NewServeMux()

	cfg, cfgErr := loadConfig()
	if cfgErr != nil {
		// ---- 未安装：全站跳安装向导 ----
		log.Print("未找到 config.json —— 首次运行，请访问 /install 完成安装")
		mux.HandleFunc("/install", handleInstallGet)
		mux.HandleFunc("/api/install", handleInstallPost)
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/favicon.ico" {
				http.NotFound(w, r)
				return
			}
			http.Redirect(w, r, "/install", http.StatusFound)
		})
		// 注意：安装模式下不注册任何文章 API——库还没建，注册了也是 500
		if err := http.ListenAndServe(cfgAddr, mux); err != nil {
			log.Fatal("监听失败：", err)
		}
		return
	}

	// ---- 已安装：补默认值（旧 config.json 可能缺新字段）→ 连库 ----
	cfg.applyDefaults()
	if err := openDB(cfg.DSN(cfg.DBName)); err != nil {
		log.Fatalf("连接 MariaDB 失败：%v\n检查服务是否启动、config.json 里的连接参数是否正确", err)
	}

	if *doImport {
		importManifest(path.Join(webDir, "posts", "manifest.js"))
		return
	}

	mux.HandleFunc("/api/posts", apiPosts(cfg))
	mux.HandleFunc("/api/posts/", apiPosts(cfg))
	mux.HandleFunc("/api/events", serveEvents)
	mux.HandleFunc("/api/login", handleLogin(cfg))
	mux.HandleFunc("/api/logout", handleLogout)
	mux.HandleFunc("/api/me", handleMe(cfg.Secret))
	// /api/site：GET 读（公开）、PUT 写（登录）。ServeMux 同 pattern 只能注册一次，按方法分发
	mux.HandleFunc("/api/site", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			siteSaveAPI(cfg)(w, r)
			return
		}
		siteAPI(cfg)(w, r)
	})
	mux.HandleFunc("/api/upload", func(w http.ResponseWriter, r *http.Request) {
		if currentUser(r, cfg.Secret) == "" {
			writeJSON(w, 401, errBody("未登录"))
			return
		}
		handleUpload(w, r)
	})
	mux.HandleFunc("/api/install", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 400, errBody("已安装；如需重装，删除 config.json 后重启"))
	})

	// 页面路由（全部 embed/磁盘双源）
	mux.HandleFunc("/install", handleInstallGet) // 已安装也响应，给个"已安装"提示
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		servePage(w, r, "login.html")
	})
	mux.HandleFunc("/edit", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/edit/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/edit/", func(w http.ResponseWriter, r *http.Request) {
		servePage(w, r, "edit.html")
	})

	// SEO 路由：干净 URL + 服务端直出 meta。
	// "/" 是 catch-all，首页之外的路径全部转给静态资源处理。
	static := staticHandler()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			serveHome(cfg)(w, r)
			return
		}
		static.ServeHTTP(w, r)
	})
	mux.HandleFunc("/p/", servePost(cfg))            // 文章 /p/<slug>
	mux.HandleFunc("/post.html", redirectLegacyPost) // 旧 ?p= 链接 301 到干净 URL
	mux.HandleFunc("/index.html", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/", http.StatusMovedPermanently) // 规范化
	})
	mux.HandleFunc("/robots.txt", robotsHandler(cfg))   // 动态：带 Sitemap 行
	mux.HandleFunc("/sitemap.xml", sitemapHandler(cfg)) // 动态：列出库中全部文章
	mux.HandleFunc("/uploads/", serveUploads)           // 上传文件只读服务（运行期产物，不在 embed 里）

	log.Printf("空雨不流泪 %s · 单二进制已启动 http://localhost%s （库 %s，管理员 %s）", version, cfgAddr, cfg.DBName, cfg.AdminUser)
	log.Printf("前台 / · 登录 /login · 写作 /edit · 安装向导 /install")
	if err := http.ListenAndServe(cfgAddr, mux); err != nil {
		log.Fatal("监听失败：", err)
	}
}

// ---------------------------------------------------------------------------
// manifest.js 导入器：把纯静态时代的遗产搬进数据库
// ---------------------------------------------------------------------------

func importManifest(p string) {
	b, err := os.ReadFile(p)
	if err != nil {
		log.Fatalf("读不到 %s：%v", p, err)
	}
	s := string(b)
	i := strings.Index(s, "[")
	j := strings.LastIndex(s, "]")
	if i < 0 || j <= i {
		log.Fatal("manifest.js 里没找到数组，格式不认识")
	}
	var posts []Post
	if err := json.Unmarshal([]byte(s[i:j+1]), &posts); err != nil {
		log.Fatalf("解析文章 JSON 失败：%v", err)
	}
	n := 0
	for i := range posts {
		po := posts[i]
		if strings.TrimSpace(po.Slug) == "" || strings.TrimSpace(po.Title) == "" {
			continue
		}
		if err := putPost(&po); err != nil {
			log.Printf("导入《%s》失败：%v", po.Title, err)
			continue
		}
		n++
	}
	log.Printf("导入完成：%d/%d 篇写入数据库", n, len(posts))
}
