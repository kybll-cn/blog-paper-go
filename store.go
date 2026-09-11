// ============================================================================
// 存储层：MariaDB 四句 SQL + SSE 广播器
// ----------------------------------------------------------------------------
// 表结构见 schema.sql（安装向导会自动执行建表）。
// 写操作成功后 hub.Broadcast() 通知所有在线前台，实现"不刷新自动更新"。
// ============================================================================
package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

var db *sql.DB

// Post 与前端 store.js 的对象一一对应，JSON 直接互通
type Post struct {
	Slug     string   `json:"slug"`
	Title    string   `json:"title"`
	Date     string   `json:"date"`
	Summary  string   `json:"summary"`
	Tags     []string `json:"tags"`
	Markdown string   `json:"markdown"`
	Author   string   `json:"author"`
}

func openDB(dsn string) error {
	var err error
	db, err = sql.Open("mysql", dsn)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(5) // 个人博客，5 个连接用到地老天荒
	return db.Ping()
}

func listPosts() ([]Post, error) {
	rows, err := db.Query(
		`SELECT slug, title, DATE_FORMAT(date, '%Y-%m-%d'),
		        IFNULL(summary,''), IFNULL(tags,'[]'),
		        IFNULL(markdown,''), IFNULL(author,'')
		 FROM posts ORDER BY date DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Post{}
	for rows.Next() {
		var p Post
		var tagsJSON string
		if err := rows.Scan(&p.Slug, &p.Title, &p.Date, &p.Summary,
			&tagsJSON, &p.Markdown, &p.Author); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(tagsJSON), &p.Tags) // 坏数据不拦路，给空数组
		if p.Tags == nil {
			p.Tags = []string{}
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func getPost(slug string) (*Post, error) {
	row := db.QueryRow(
		`SELECT slug, title, DATE_FORMAT(date, '%Y-%m-%d'),
		        IFNULL(summary,''), IFNULL(tags,'[]'),
		        IFNULL(markdown,''), IFNULL(author,'')
		 FROM posts WHERE slug = ?`, slug)
	var p Post
	var tagsJSON string
	if err := row.Scan(&p.Slug, &p.Title, &p.Date, &p.Summary,
		&tagsJSON, &p.Markdown, &p.Author); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil // "没有"不是错误，返回 nil 让 handler 发 404
		}
		return nil, err
	}
	_ = json.Unmarshal([]byte(tagsJSON), &p.Tags)
	return &p, nil
}

// putPost 按 slug upsert：有则更新，无则插入。后台"发布"与"改稿"共用这一条。
func putPost(p *Post) error {
	tags, _ := json.Marshal(p.Tags)
	_, err := db.Exec(
		`INSERT INTO posts (slug, title, date, summary, tags, markdown, author)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE
		   title = VALUES(title), date = VALUES(date), summary = VALUES(summary),
		   tags = VALUES(tags), markdown = VALUES(markdown), author = VALUES(author)`,
		p.Slug, p.Title, p.Date, p.Summary, string(tags), p.Markdown, p.Author)
	return err
}

func deletePost(slug string) (bool, error) {
	res, err := db.Exec(`DELETE FROM posts WHERE slug = ?`, slug)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ---------------------------------------------------------------------------
// SSE 广播器：发布/删除后推一条 "change"，前台收到即重拉列表
// ---------------------------------------------------------------------------

type hub struct {
	mu   sync.Mutex
	subs map[chan string]bool
}

var hubInstance = &hub{subs: map[chan string]bool{}}

// Broadcast 向所有订阅者投递事件；缓冲区满（客户端掉线未消费）就丢弃，不阻塞写路径
func (h *hub) Broadcast(event string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- event:
		default:
		}
	}
}

func (h *hub) add() chan string {
	ch := make(chan string, 8)
	h.mu.Lock()
	h.subs[ch] = true
	h.mu.Unlock()
	return ch
}

func (h *hub) remove(ch chan string) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
	close(ch)
}

// serveEvents GET /api/events —— SSE 长连接
func serveEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "不支持流式响应", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	ch := hubInstance.add()
	defer hubInstance.remove(ch)

	fmt.Fprint(w, "retry: 3000\n\n") // 断线 3 秒自动重连
	flusher.Flush()

	keepalive := time.NewTicker(25 * time.Second) // 25s 心跳，防代理掐空闲连接
	defer keepalive.Stop()

	for {
		select {
		case ev := <-ch:
			fmt.Fprintf(w, "event: %s\ndata: %d\n\n", ev, time.Now().UnixMilli())
			flusher.Flush()
		case <-keepalive.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

// ---------------------------------------------------------------------------
// 建库建表（安装向导用）：幂等，重复执行不报错
// ---------------------------------------------------------------------------

const schemaDDL = `
CREATE TABLE IF NOT EXISTS posts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(191)    NOT NULL,
  title      VARCHAR(255)    NOT NULL,
  date       DATE            NOT NULL,
  summary    TEXT            NULL,
  tags       JSON            NULL,
  markdown   MEDIUMTEXT      NULL,
  author     VARCHAR(63)     NULL,
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_slug (slug),
  KEY idx_date (date DESC)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci`

// migrate 连接（不选库）→ CREATE DATABASE → 选库建表。
// 返回已选中目标库的连接。
func migrate(c *Config) error {
	root, err := sql.Open("mysql", c.DSN(""))
	if err != nil {
		return err
	}
	defer root.Close()

	if _, err := root.Exec(
		"CREATE DATABASE IF NOT EXISTS `" + sanitizeIdent(c.DBName) + "` " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
		return err
	}
	if err := openDB(c.DSN(c.DBName)); err != nil {
		return err
	}
	_, err = db.Exec(schemaDDL)
	return err
}

// sanitizeIdent 库名白名单过滤（标识符不能参数化，只能过滤）
func sanitizeIdent(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if out == "" {
		out = "kongyu"
	}
	return out
}

// randomHex 生成 n 字节随机数的 hex 串（盐、密钥都靠它）
func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		log.Fatal("随机数生成失败：", err)
	}
	return hex.EncodeToString(buf)
}
