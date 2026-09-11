#!/usr/bin/env bash
# ============================================================================
# 交叉编译发布脚本：一次产出四平台单文件二进制
# ----------------------------------------------------------------------------
# 用法：bash build-release.sh [版本号]      （默认 v1.0.0）
# 产物：dist/kongyu-<os>-<arch>/  每个含二进制 + web 说明 + 配置样例
#       dist/*.zip / dist/*.tar.gz  对应压缩包（Linux 用 tar.gz，Windows 用 zip）
#
# 前端已 go:embed 进二进制，发布包无需带 web/ 目录；
# uploads/ 是运行期产物，用户首次上传时自动创建。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

VER="${1:-v1.0.0}"
LDFLAGS="-s -w -X main.version=${VER}"   # -s -w 去符号表，二进制瘦一圈

# 目标矩阵：OS/ARCH
TARGETS=(
  "linux/amd64"
  "linux/arm64"
  "windows/amd64"
  "windows/arm64"
)

echo "==> 编译 ${VER}（$(go version | awk '{print $3}')）"
mkdir -p dist
# 清理旧产物；某些沙箱环境禁止通配删除，失败也不影响本次构建（|| true 兜底）
rm -rf dist/kongyu-* dist/*.tar.gz dist/*.zip 2>/dev/null || true

for T in "${TARGETS[@]}"; do
  OS="${T%/*}"; ARCH="${T#*/}"
  NAME="kongyu-${OS}-${ARCH}"
  OUT="dist/${NAME}"
  mkdir -p "$OUT"
  BIN="${NAME}"
  [ "$OS" = "windows" ] && BIN="${BIN}.exe"

  echo "  -> ${OS}/${ARCH}"
  # CGO_ENABLED=0：纯静态，不依赖目标机 libc（go-sql-driver 是纯 Go，无需 CGO）
  CGO_ENABLED=0 GOOS="$OS" GOARCH="$ARCH" \
    go build -trimpath -ldflags "${LDFLAGS}" -o "${OUT}/${BIN}" .

  # 每个包附带的说明与配置样例
  cp config.example.json "${OUT}/" 2>/dev/null || true
  cp README.md "${OUT}/README.txt"
  printf '本目录内容：\n  %s   可执行文件（前端已内嵌，双击/运行即可）\n  config.example.json  配置样例（复制为 config.json 或直接跑，首次访问走 /install 向导）\n  README.txt   完整说明\n\n快速开始：\n  1. 确保 MariaDB 已启动\n  2. 运行本目录的可执行文件\n  3. 浏览器打开 http://localhost:6888 → 自动进入安装向导\n' "$BIN" > "${OUT}/运行说明.txt"

  # 打包：Linux 用 tar.gz，Windows 用 zip
  ( cd dist
    if [ "$OS" = "windows" ]; then
      # zip 若无则退回 tar；主流环境都有 zip
      if command -v zip >/dev/null 2>&1; then
        zip -qr "${NAME}.zip" "${NAME}"
      else
        tar czf "${NAME}.tar.gz" "${NAME}"
      fi
    else
      tar czf "${NAME}.tar.gz" "${NAME}"
    fi
  )
done

echo "==> 校验和"
( cd dist
  for f in kongyu-*.tar.gz kongyu-*.zip; do
    [ -e "$f" ] || continue
    sha256sum "$f" > "${f}.sha256"
    echo "  $(basename "$f")  $(cut -d' ' -f1 "${f}.sha256" | cut -c1-16)…"
  done
)

echo "==> 完成，产物在 dist/："
ls -1 dist/*.tar.gz dist/*.zip 2>/dev/null | xargs -I{} sh -c 'printf "  %-40s %s\n" "{}" "$(du -h "{}" | cut -f1)"'
