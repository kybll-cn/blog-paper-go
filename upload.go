// ============================================================================
// 上传系统：图片 + 附件（下载卡片用）
// ----------------------------------------------------------------------------
// POST /api/upload （multipart/form-data，字段 file，需登录）
//
//	→ 存到 uploads/YYYYMM/<随机hex><ext>，返回 {url,name,size,mime}
//
// 文件不进 embed（运行期产物），GET /uploads/* 直接读磁盘。
// 安全：扩展名白名单、大小上限、随机文件名（防覆盖/防猜）、Content-Type 收敛。
// ============================================================================
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var uploadDir = "uploads"

// 允许上传的扩展名 → 存储时使用的规范扩展名（防 .php/.exe 之类）
var uploadAllow = map[string]string{
	// 图片
	".jpg": ".jpg", ".jpeg": ".jpg", ".png": ".png", ".gif": ".gif",
	".webp": ".webp", ".svg": ".svg", ".avif": ".avif", ".bmp": ".bmp",
	// 附件
	".pdf": ".pdf", ".zip": ".zip", ".rar": ".rar", ".7z": ".7z", ".tar": ".tar", ".gz": ".gz",
	".doc": ".doc", ".docx": ".docx", ".xls": ".xls", ".xlsx": ".xlsx", ".ppt": ".ppt", ".pptx": ".pptx",
	".txt": ".txt", ".md": ".md", ".csv": ".csv", ".json": ".json",
	".mp3": ".mp3", ".mp4": ".mp4", ".m4a": ".m4a", ".wav": ".wav",
}

const uploadMaxBytes = 20 << 20 // 20MB，个人博客够用；Nginx 反代记得同步 client_max_body_size

// handleUpload 接收单个文件，落盘并返回可访问 URL
func handleUpload(w http.ResponseWriter, r *http.Request) {
	// 限流内存：超出的部分 Go 自动落临时文件，不爆内存
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeJSON(w, 400, errBody("表单解析失败（文件过大或格式错误）"))
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, 400, errBody("没收到文件字段 file"))
		return
	}
	defer file.Close()

	if hdr.Size > uploadMaxBytes {
		writeJSON(w, 400, errBody(fmt.Sprintf("文件超过 %dMB 上限", uploadMaxBytes>>20)))
		return
	}

	ext := strings.ToLower(filepath.Ext(hdr.Filename))
	safeExt, ok := uploadAllow[ext]
	if !ok {
		writeJSON(w, 400, errBody("不支持的文件类型："+ext))
		return
	}

	// 随机文件名：防覆盖、防枚举；日期子目录方便归档与清理
	sub := time.Now().Format("200601")
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		writeJSON(w, 500, errBody("生成文件名失败"))
		return
	}
	name := hex.EncodeToString(buf) + safeExt
	dir := filepath.Join(uploadDir, sub)
	if err := os.MkdirAll(dir, 0755); err != nil {
		writeJSON(w, 500, errBody("创建目录失败："+err.Error()))
		return
	}
	dst := filepath.Join(dir, name)
	out, err := os.Create(dst)
	if err != nil {
		writeJSON(w, 500, errBody("写入失败："+err.Error()))
		return
	}
	defer out.Close()
	if _, err := io.Copy(out, io.LimitReader(file, uploadMaxBytes)); err != nil {
		writeJSON(w, 500, errBody("保存中断："+err.Error()))
		return
	}

	url := "/uploads/" + sub + "/" + name
	writeJSON(w, 200, map[string]any{
		"url":  url,
		"name": hdr.Filename, // 原始文件名（展示用）
		"size": hdr.Size,
		"mime": mimeOf(safeExt),
	})
}

// serveUploads GET /uploads/* —— 只读磁盘，带下载头与正确 MIME
func serveUploads(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/uploads/")
	if rel == "" || strings.Contains(rel, "..") {
		http.Error(w, "nope", http.StatusBadRequest)
		return
	}
	full := filepath.Join(uploadDir, filepath.FromSlash(rel))
	st, err := os.Stat(full)
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	setMIME(w, full)
	w.Header().Set("Cache-Control", "public, max-age=2592000") // 文件名含随机串，可长缓存
	if q := r.URL.Query().Get("dl"); q != "" {                 // ?dl=文件名 → 触发下载
		w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+urlQueryEscape(q))
	}
	http.ServeFile(w, r, full)
}

// urlQueryEscape 手写避免引入 net/url 的循环依赖顾虑（其实没循环，纯粹够用）
func urlQueryEscape(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for _, r := range []byte(s) {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '-' || r == '_' || r == '.' || r == '~' {
			b.WriteByte(r)
		} else {
			b.WriteByte('%')
			b.WriteByte(hexDigits[r>>4])
			b.WriteByte(hexDigits[r&0x0f])
		}
	}
	return b.String()
}

// mimeOf 按规范扩展名给 MIME（下载卡片与 img 标签都要正确的类型）
func mimeOf(ext string) string {
	switch ext {
	case ".jpg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	case ".avif":
		return "image/avif"
	case ".bmp":
		return "image/bmp"
	case ".pdf":
		return "application/pdf"
	case ".zip":
		return "application/zip"
	case ".mp4":
		return "video/mp4"
	case ".mp3":
		return "audio/mpeg"
	default:
		return "application/octet-stream"
	}
}
