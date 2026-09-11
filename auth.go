// ============================================================================
// 登录与会话
// ----------------------------------------------------------------------------
// 无状态会话：Cookie 值 = user|过期时间|HMAC-SHA256(secret, user|过期时间)。
// 服务端不存 session 表，改密码/重启即全体失效（Secret 变了）。
// 单用户博客：只认 config.json 里那一个管理员。
// ============================================================================
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const sessionCookie = "ky_session"
const sessionTTL = 7 * 24 * time.Hour // 记住一周，写作的人讨厌频繁登录

// signToken 生成/校验签名，防篡改 Cookie 里的用户名和过期时间
func signToken(secret, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

func makeSession(secret, user string) string {
	exp := time.Now().Add(sessionTTL).Unix()
	payload := user + "|" + strconv.FormatInt(exp, 10)
	return payload + "|" + signToken(secret, payload)
}

func parseSession(secret, cookie string) (string, bool) {
	parts := strings.Split(cookie, "|")
	if len(parts) != 3 {
		return "", false
	}
	payload := parts[0] + "|" + parts[1]
	want := signToken(secret, payload)
	if subtle.ConstantTimeCompare([]byte(want), []byte(parts[2])) != 1 {
		return "", false // 签名不对 = 被篡改
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", false // 已过期
	}
	return parts[0], true
}

// currentUser 从请求 Cookie 解出已登录用户名（未登录返回空）
func currentUser(r *http.Request, secret string) string {
	ck, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	if u, ok := parseSession(secret, ck.Value); ok {
		return u
	}
	return ""
}

// requireLogin API 写操作的门卫；401 时前端会跳登录页
func requireLogin(secret string, next func(w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if currentUser(r, secret) == "" {
			writeJSON(w, 401, errBody("未登录"))
			return
		}
		// CSRF 第二道锁：写接口只认 JSON（跨站表单伪造不出 application/json）
		if !strings.Contains(r.Header.Get("Content-Type"), "application/json") {
			writeJSON(w, 415, errBody("只接受 JSON 请求"))
			return
		}
		next(w, r)
	}
}

// handleLogin POST /api/login —— 校验用户名 + 迭代哈希，成功则种 Cookie
func handleLogin(c *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			User     string `json:"user"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, errBody("请求格式错误"))
			return
		}
		okUser := subtle.ConstantTimeCompare([]byte(body.User), []byte(c.AdminUser)) == 1
		okPass := subtle.ConstantTimeCompare(
			[]byte(hashPassword(body.Password, c.AdminSalt)), []byte(c.AdminHash)) == 1
		if !okUser || !okPass {
			writeJSON(w, 401, errBody("用户名或密码不对"))
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookie,
			Value:    makeSession(c.Secret, c.AdminUser),
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Expires:  time.Now().Add(sessionTTL),
		})
		writeJSON(w, 200, map[string]any{"ok": true, "user": c.AdminUser})
	}
}

// handleLogout POST /api/logout —— 过期 Cookie 即登出
func handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/",
		HttpOnly: true, Expires: time.Unix(0, 0),
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleMe GET /api/me —— 前端用它决定显隐"退出登录"按钮
func handleMe(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r, secret)
		writeJSON(w, 200, map[string]any{"logged": u != "", "user": u})
	}
}
