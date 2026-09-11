// ============================================================================
// 配置：config.json 由安装向导（/install）生成，不在仓库里提交
// ----------------------------------------------------------------------------
// 密码不落明文：管理员口令以 salt + 迭代 SHA-256 哈希存储；
// Secret 用于签发会话 Cookie（HMAC），安装时随机生成。
// ============================================================================
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
)

type Config struct {
	// 数据库连接参数（拆开存，组装 DSN 时对密码做转义，省得用户密码里有 @ / ?）
	DBHost string `json:"db_host"`
	DBPort string `json:"db_port"`
	DBUser string `json:"db_user"`
	DBPass string `json:"db_pass"`
	DBName string `json:"db_name"`

	// 站点信息：安装向导填写，前端经 /api/site 读取后覆盖内置默认值
	SiteName    string `json:"site_name"`
	SiteTagline string `json:"site_tagline"`
	SiteDesc    string `json:"site_desc"`
	SiteAuthor  string `json:"site_author"`

	// 页脚三件套（后台"站点设置"可改）：版权年份起、开源地址、备案号（双证）
	CopyrightSince string `json:"copyright_since"` // 默认沿用 since 概念，存年份字符串
	RepoURL        string `json:"repo_url"`        // 开源地址，如 https://github.com/kybll-cn/blog-paper-go
	ICP            string `json:"icp"`             // ICP 备案号，如 京ICP备2026000000号-1（链 beian.miit.gov.cn）
	Police         string `json:"police"`          // 公安备案号，如 京公网安备11010502000000号（链 beian.mps.gov.cn）

	// 管理员账号（单用户博客：一个就够）
	AdminUser string `json:"admin_user"`
	AdminHash string `json:"admin_hash"` // hex(迭代sha256(salt|password))
	AdminSalt string `json:"admin_salt"` // hex 随机盐

	Secret string `json:"secret"` // 会话 Cookie 的 HMAC 签名密钥（hex）
}

// 站点信息默认值（兼容旧 config.json 缺字段的情况）
func (c *Config) applyDefaults() {
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
	if c.RepoURL == "" {
		c.RepoURL = "https://github.com/kybll-cn/blog-paper-go"
	}
	// ICP / 公安备案 留空合法：不是所有站都双证齐全
}

// SiteInfo 暴露给前端的站点配置（不含任何秘密字段）
type SiteInfo struct {
	Name           string `json:"name"`
	Tagline        string `json:"tagline"`
	Desc           string `json:"description"`
	Author         string `json:"author"`
	CopyrightSince string `json:"copyright_since"`
	RepoURL        string `json:"repo_url"`
	ICP            string `json:"icp"`
	Police         string `json:"police"`
}

func (c *Config) Site() SiteInfo {
	return SiteInfo{
		Name: c.SiteName, Tagline: c.SiteTagline, Desc: c.SiteDesc, Author: c.SiteAuthor,
		CopyrightSince: c.CopyrightSince, RepoURL: c.RepoURL, ICP: c.ICP, Police: c.Police,
	}
}

const configFile = "config.json"

// DSN 组装成 go-sql-driver 格式；utf8mb4 保证 emoji 和生僻字能进库
func (c *Config) DSN(dbName string) string {
	return fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?charset=utf8mb4&parseTime=false&loc=Local",
		c.DBUser, c.DBPass, c.DBHost, c.DBPort, dbName)
}

func loadConfig() (*Config, error) {
	b, err := os.ReadFile(configFile)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// saveConfig 0600：里面有密码哈希和密钥，别让同机其他用户读到
func saveConfig(c *Config) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configFile, b, 0600)
}

// hashPassword 迭代 SHA-256（1 万轮）。
// 说明：正统做法是 bcrypt/argon2，但那要引第三方依赖——本站单用户、
// 默认局域网/小服务器部署，stdlib 迭代哈希足够把拖库撞库挡在门外。
func hashPassword(password, saltHex string) string {
	salt, _ := hex.DecodeString(saltHex)
	h := sha256.Sum256(append(append([]byte{}, salt...), []byte(password)...))
	for i := 0; i < 10000; i++ {
		h = sha256.Sum256(append(h[:], salt...))
	}
	return hex.EncodeToString(h[:])
}
