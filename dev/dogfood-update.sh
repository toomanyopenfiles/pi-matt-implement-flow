#!/usr/bin/env bash
#
# dogfood-update.sh — 把预发布 npm tarball 滚动到本地 dogfood 镜像（pi 本地包路径）。
#
# 背景：pi 本地包按「解析后的绝对路径」识别身份、原地加载不复制。要长期 dogfood
# 预发包，就固定一个镜像目录做用户级安装（一次），之后每次预发只换镜像内容：
#
#   pi install ~/.pi/agent/dogfood/pi-matt-implement-flow     # 一次性
#   dev/dogfood-update.sh <tarball.tgz> [期望 sha256]         # 每次预发
#   dev/dogfood-update.sh --rollback [备份文件]               # 秒级回滚
#
# 用法：
#   dev/dogfood-update.sh <tarball.tgz> [期望 sha256]
#       核对摘要 → 备份当前镜像 → 原子替换（rsync --delete）→ 回显版本。
#       给了期望 sha256 就强校验（与发布运行的摘要对照）；不给只显示不拦截。
#   dev/dogfood-update.sh --rollback [备份文件]
#       回滚到指定备份；缺省回滚到最近一次备份。
#
# 镜像路径默认 ~/.pi/agent/dogfood/pi-matt-implement-flow，可用 DOGFOOD_MIRROR 覆盖。
# 备份保存在镜像同级 backups/ 下，最多保留 5 份。
# 换镜像后开新的 pi 会话生效（进行中的会话继续跑旧代码）。
# 本脚本是仓库开发工具，不随 npm 包发布。

set -euo pipefail

PKG_NAME="pi-matt-implement-flow"
MIRROR="${DOGFOOD_MIRROR:-$HOME/.pi/agent/dogfood/pi-matt-implement-flow}"
BACKUP_DIR="${DOGFOOD_BACKUP_DIR:-$(dirname "$MIRROR")/backups}"
KEEP_BACKUPS=5

usage() {
  sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

say()  { printf '  %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ⚠ %s\n' "$1" >&2; }
die()  { printf '  ✗ %s\n' "$1" >&2; exit 1; }

# 临时目录用全局（trap 在退出时求值，函数局部变量会出作用域）。
WORKDIR=""
cleanup() { [ -n "${WORKDIR:-}" ] && rm -rf "$WORKDIR"; return 0; }
trap cleanup EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
sha1_of() {
  if command -v sha1sum >/dev/null 2>&1; then sha1sum "$1" | cut -d' ' -f1
  else shasum -a 1 "$1" | cut -d' ' -f1; fi
}
pkg_name()    { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)' "$1"; }
pkg_version() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$1"; }

# ── 回滚 ─────────────────────────────────────────────────────────────────
rollback() {
  local backup="${1:-}"
  if [ -z "$backup" ]; then
    backup=$(ls -t "$BACKUP_DIR"/*.tgz 2>/dev/null | head -1 || true)
    [ -n "$backup" ] || die "backups/ 里没有备份可回滚"
  fi
  [ -f "$backup" ] || die "备份文件不存在：$backup"
  WORKDIR=$(mktemp -d)
  tar xzf "$backup" -C "$WORKDIR"
  [ -f "$WORKDIR/package.json" ] || die "备份内容异常（缺 package.json）：$backup"
  say "回滚来源：$backup"
  say "当前版本：$( [ -f "$MIRROR/package.json" ] && pkg_version "$MIRROR/package.json" || echo '（无）' )"
  mkdir -p "$MIRROR"
  rsync -a --delete "$WORKDIR/" "$MIRROR/"
  ok "已回滚到 $(pkg_version "$MIRROR/package.json") → $MIRROR"
  say "开新的 pi 会话生效。"
}

# ── 更新 ─────────────────────────────────────────────────────────────────
update() {
  local tarball="$1" expected="${2:-}"
  [ -f "$tarball" ] || die "tarball 不存在：$tarball"

  # ① 摘要核对
  local actual256 actual1
  actual256=$(sha256_of "$tarball")
  actual1=$(sha1_of "$tarball")
  say "tarball：$tarball"
  say "sha256：$actual256"
  say "sha1（= npm dist.shasum 核对值）：$actual1"
  if [ -n "$expected" ]; then
    [ "$actual256" = "$expected" ] || die "sha256 与期望不符（${actual256} ≠ ${expected}）——拒绝更新"
    ok "sha256 与期望一致"
  else
    warn "未给期望 sha256，只显示不拦截（建议对照发布运行的摘要）"
  fi

  # ② 解包并验包
  WORKDIR=$(mktemp -d)
  tar xzf "$tarball" -C "$WORKDIR"
  [ -f "$WORKDIR/package/package.json" ] || die "tarball 结构异常（缺 package/package.json）"
  [ "$(pkg_name "$WORKDIR/package/package.json")" = "$PKG_NAME" ] || die "包名不是 $PKG_NAME"
  local new_ver old_ver
  new_ver=$(pkg_version "$WORKDIR/package/package.json")
  old_ver=$( [ -f "$MIRROR/package.json" ] && pkg_version "$MIRROR/package.json" || echo '' )

  # ③ 备份当前镜像（保留最近 5 份）
  if [ -n "$old_ver" ] && [ -f "$MIRROR/package.json" ]; then
    mkdir -p "$BACKUP_DIR"
    local backup="$BACKUP_DIR/$PKG_NAME-$old_ver-$(date +%Y%m%d-%H%M%S).tgz"
    tar czf "$backup" -C "$MIRROR" .
    ok "已备份当前镜像（${old_ver}）→ $backup"
    ls -t "$BACKUP_DIR"/*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
  fi

  # ④ 原子替换（rsync --delete：旧文件不残留）
  mkdir -p "$MIRROR"
  rsync -a --delete "$WORKDIR/package/" "$MIRROR/"
  ok "镜像已更新：${old_ver:-（空）} → $(pkg_version "$MIRROR/package.json")"
  say "镜像路径：${MIRROR}（路径即包身份——不要移动或手改此目录）"
  say "下一步：开新的 pi 会话生效；出问题执行 dev/dogfood-update.sh --rollback"
}

# ── 入口 ─────────────────────────────────────────────────────────────────
case "${1:-}" in
  ''|-h|--help) usage ;;
  --rollback) shift; rollback "${1:-}" ;;
  *) update "$1" "${2:-}" ;;
esac
