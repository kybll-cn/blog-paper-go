// ============================================================================
// SEO：服务端直出的 title/meta、干净 URL、动态 robots/sitemap
// ----------------------------------------------------------------------------
// 爬虫看不懂 JS 渲染的页面，所以首屏关键信息必须服务端写进 HTML：
//
//	模板里放 <!--SEO:title-->…<!--SEO:title-end--> 与 meta 占位块，
//	servePageT 按请求实时填充（站名来自安装向导，文章信息来自数据库）。
//
// URL 规范：
//
//	/            首页（index.html 301 过来）
//	/p/<slug>    文章页（旧 post.html?p= 301 过来）
//	/sitemap.xml 动态生成，库里有几篇列几篇
//	/robots.txt  动态生成，自动带上当前 Host 的 Sitemap 行
//
// ============================================================================
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// baseURL 推断站点绝对地址（canonical/OG/sitemap 都需要绝对 URL）。
// 优先 X-Forwarded-Proto / X-Forwarded-Host，兼容 Nginx 反代与 HTTPS 终结。
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host
}

// escHTML 转义进 HTML 的内容——SEO 注入面不能裸奔（文章标题里可能有 <）
var htmlEsc = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")

func escHTML(s string) string { return htmlEsc.Replace(s) }

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// estReadingMinutes 与前端 readingTime 同口径：汉字+字母数字，350 字/分钟
func estReadingMinutes(md string) int {
	n := 0
	for _, r := range md {
		if (r >= 0x4e00 && r <= 0x9fff) || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			n++
		}
	}
	m := (n + 120) / 350
	if m < 1 {
		m = 1
	}
	return m
}

// ---------------------------------------------------------------------------
// meta 块组装
// ---------------------------------------------------------------------------

// homeSEOData 首页 title + meta 块
func homeSEOData(c *Config, r *http.Request) map[string]string {
	s := c.Site()
	base := baseURL(r)
	title := escHTML(s.Name) + " —— " + escHTML(s.Tagline)
	meta := strings.Join([]string{
		`<title>` + title + `</title>`,
		`<meta name="description" content="` + escHTML(s.Desc) + `">`,
		`<meta name="author" content="` + escHTML(s.Author) + `">`,
		`<link rel="canonical" href="` + base + `/">`,
		`<meta property="og:type" content="website">`,
		`<meta property="og:site_name" content="` + escHTML(s.Name) + `">`,
		`<meta property="og:title" content="` + title + `">`,
		`<meta property="og:description" content="` + escHTML(s.Desc) + `">`,
		`<meta property="og:url" content="` + base + `/">`,
		`<meta property="og:locale" content="zh_CN">`,
		`<meta name="twitter:card" content="summary">`,
		`<meta name="twitter:title" content="` + title + `">`,
		`<meta name="twitter:description" content="` + escHTML(s.Desc) + `">`,
		`<script type="application/ld+json">` + ldSite(s, base) + `</script>`,
	}, "\n")
	return map[string]string{"head": meta} // 整块替换模板的兜底 HEAD 区
}

// postSEOData 文章页：title + OG(article) + JSON-LD(BlogPosting)
func postSEOData(c *Config, p *Post, r *http.Request) map[string]string {
	s := c.Site()
	base := baseURL(r)
	title := escHTML(p.Title) + " · " + escHTML(s.Name)
	u := base + "/p/" + url.PathEscape(p.Slug)
	block := strings.Join([]string{
		`<title>` + title + `</title>`,
		`<meta name="description" content="` + escHTML(p.Summary) + `">`,
		`<meta name="author" content="` + escHTML(orDefault(p.Author, s.Author)) + `">`,
		`<link rel="canonical" href="` + u + `">`,
		`<meta property="og:type" content="article">`,
		`<meta property="og:site_name" content="` + escHTML(s.Name) + `">`,
		`<meta property="og:title" content="` + escHTML(p.Title) + `">`,
		`<meta property="og:description" content="` + escHTML(p.Summary) + `">`,
		`<meta property="og:url" content="` + u + `">`,
		`<meta property="og:locale" content="zh_CN">`,
		`<meta property="article:published_time" content="` + escHTML(p.Date) + `">`,
		`<meta property="article:author" content="` + escHTML(orDefault(p.Author, s.Author)) + `">`,
		`<meta name="twitter:card" content="summary">`,
		`<meta name="twitter:title" content="` + escHTML(p.Title) + `">`,
		`<meta name="twitter:description" content="` + escHTML(p.Summary) + `">`,
		`<script type="application/ld+json">` + ldBlogPosting(s, p, u, base) + `</script>`,
	}, "\n")
	// abs=1：告诉 servePageT 本页面在 /p/ 目录下，把相对资源路径改写为根绝对路径
	return map[string]string{"head": block, "abs": "1"}
}

// ldSite JSON-LD WebSite（schema.org）
func ldSite(s SiteInfo, base string) string {
	b, _ := json.Marshal(map[string]any{
		"@context":    "https://schema.org",
		"@type":       "WebSite",
		"name":        s.Name,
		"description": s.Desc,
		"url":         base + "/",
		"inLanguage":  "zh-CN",
		"author":      map[string]any{"@type": "Person", "name": s.Author},
	})
	return string(b)
}

// ldBlogPosting JSON-LD BlogPosting
func ldBlogPosting(s SiteInfo, p *Post, u, base string) string {
	b, _ := json.Marshal(map[string]any{
		"@context":         "https://schema.org",
		"@type":            "BlogPosting",
		"headline":         p.Title,
		"description":      p.Summary,
		"inLanguage":       "zh-CN",
		"datePublished":    p.Date,
		"timeRequired":     fmt.Sprintf("PT%dM", estReadingMinutes(p.Markdown)),
		"author":           map[string]any{"@type": "Person", "name": orDefault(p.Author, s.Author)},
		"publisher":        map[string]any{"@type": "Person", "name": orDefault(p.Author, s.Author)},
		"mainEntityOfPage": u,
		"isPartOf":         base + "/",
	})
	return string(b)
}

// ---------------------------------------------------------------------------
// 页面 handler
// ---------------------------------------------------------------------------

// redirectLegacyPost 旧链接 post.html?p=<slug> → 301 干净 URL /p/<slug>
// （301 会把权重转移给新地址；同时 sitemap 只收录新地址，不留两份重复内容）
func redirectLegacyPost(w http.ResponseWriter, r *http.Request) {
	slug := r.URL.Query().Get("p")
	if slug == "" {
		http.Redirect(w, r, "/", http.StatusMovedPermanently)
		return
	}
	http.Redirect(w, r, "/p/"+url.PathEscape(slug), http.StatusMovedPermanently)
}

// serveHome 首页（"/"）：服务端直出 SEO
func serveHome(c *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		servePageT(w, r, "index.html", homeSEOData(c, r))
	}
}

// servePost 干净 URL /p/<slug>：SEO 直出；正文仍由前端渲染（数据走 API，
// URL 好看 + 爬虫拿到首屏信息，两头兼顾）
func servePost(c *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slug := strings.TrimPrefix(r.URL.Path, "/p/")
		if !slugRe.MatchString(slug) {
			http.NotFound(w, r)
			return
		}
		p, err := getPost(slug)
		if err != nil {
			http.Error(w, "查询失败", 500)
			return
		}
		if p == nil {
			// 真 404：给爬虫正确状态码，别拿 200 喂"内容不存在"（soft 404 伤收录）
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprintf(w, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">`+
				`<meta name="robots" content="noindex"><title>文章不存在 · %s</title>`+
				`<link rel="stylesheet" href="/assets/style.css"></head>`+
				`<body style="margin:0"><div style="padding:120px 6vw;text-align:center">`+
				`<h1>这篇没有找到</h1><p><a href="/">← 回到首页</a></p></div></body></html>`,
				escHTML(c.SiteName))
			return
		}
		servePageT(w, r, "post.html", postSEOData(c, p, r))
	}
}

// ---------------------------------------------------------------------------
// sitemap / robots / site 配置接口
// ---------------------------------------------------------------------------

func sitemapHandler(c *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		posts, err := listPosts()
		if err != nil {
			http.Error(w, "db error", 500)
			return
		}
		base := baseURL(r)
		var sb strings.Builder
		sb.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
		sb.WriteString(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` + "\n")
		sb.WriteString(fmt.Sprintf("  <url><loc>%s/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n", base))
		for _, p := range posts {
			sb.WriteString(fmt.Sprintf("  <url><loc>%s/p/%s</loc><lastmod>%s</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>\n",
				base, url.PathEscape(p.Slug), p.Date))
		}
		sb.WriteString("</urlset>\n")
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		io.WriteString(w, sb.String())
	}
}

// robotsHandler 动态 robots.txt：Host 从请求里取，不用配置域名
func robotsHandler(c *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		fmt.Fprintf(w, "User-agent: *\nAllow: /\nDisallow: /edit\nDisallow: /edit/\nDisallow: /login\nDisallow: /install\nDisallow: /api/\n\nSitemap: %s/sitemap.xml\n", baseURL(r))
	}
}

// siteAPI GET /api/site —— 安装时填的站点信息（公开，不含任何秘密字段）
func siteAPI(c *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, c.Site())
	}
}

// siteSaveAPI PUT /api/site —— 后台"站点设置"写回（需登录）。
// 只允许改展示字段，DB/管理员/密钥碰都不碰。
func siteSaveAPI(c *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if currentUser(r, c.Secret) == "" {
			writeJSON(w, 401, errBody("未登录"))
			return
		}
		var s SiteInfo
		if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
			writeJSON(w, 400, errBody("JSON 解析失败"))
			return
		}
		c.SiteName = strings.TrimSpace(s.Name)
		c.SiteTagline = strings.TrimSpace(s.Tagline)
		c.SiteDesc = strings.TrimSpace(s.Desc)
		c.SiteAuthor = strings.TrimSpace(s.Author)
		c.CopyrightSince = strings.TrimSpace(s.CopyrightSince)
		c.RepoURL = strings.TrimSpace(s.RepoURL)
		c.ICP = strings.TrimSpace(s.ICP)
		c.Police = strings.TrimSpace(s.Police)
		// 核心字段空则回默认；repo_url / icp / police 允许清空（不渲染对应链接）
		if c.SiteName == "" {
			c.SiteName = "空雨不流泪"
		}
		if c.SiteTagline == "" {
			c.SiteTagline = "雨没下，就别撑伞"
		}
		if c.SiteDesc == "" {
			c.SiteDesc = "一个写字的地方。关于雨、关于告别、关于那些没发生的事。"
		}
		if c.SiteAuthor == "" {
			c.SiteAuthor = "空雨"
		}
		if c.CopyrightSince == "" {
			c.CopyrightSince = "2021"
		}
		if err := saveConfig(c); err != nil {
			writeJSON(w, 500, errBody("保存失败："+err.Error()))
			return
		}
		hubInstance.Broadcast("site") // 通知在线页面刷新页脚/站点信息
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}
