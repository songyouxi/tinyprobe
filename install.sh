#!/bin/bash
# tinyprobe 一键安装 / 自注册 / 自启动脚本
# 服务器零环境：只需要 bash + (curl 或 wget)。自动识别架构，下载对应静态二进制，
# 校验 SHA256，注册 systemd 服务并启动。无 systemd 时用 nohup 兜底。
#
# 用法（一行安装）：
#   HUB=http://监控端IP:47821 NAME=web-01 bash install.sh
# 或带参数：
#   bash install.sh --hub http://监控端IP:47821 --name web-01 --token SECRET \
#     --repo https://raw.githubusercontent.com/OWNER/REPO/main/dist --version v1.1.0
#
# 环境变量也可：HUB, NAME, TOKEN, REPO, VERSION, SERVICE, INTERVAL, INSTALL_DIR

set -e

# ---------- 默认配置 ----------
HUB="${HUB:-http://127.0.0.1:47821}"
NAME="${NAME:-$(hostname)}"
TOKEN="${TOKEN:-}"
REPO="${REPO:-https://raw.githubusercontent.com/OWNER/REPO/main/dist}"
VERSION="${VERSION:-latest}"          # latest = 不拼版本目录；否则按 {ver} 目录拼
SERVICE="${SERVICE:-tinyprobe}"
INTERVAL="${INTERVAL:-2}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
BIN_NAME="tinyprobe-probe"
BIN_PATH="$INSTALL_DIR/$BIN_NAME"

# ---------- 参数解析 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --hub)      HUB="$2"; shift 2;;
    --name)     NAME="$2"; shift 2;;
    --token)    TOKEN="$2"; shift 2;;
    --repo)     REPO="$2"; shift 2;;
    --version)  VERSION="$2"; shift 2;;
    --service)  SERVICE="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    *) echo "未知参数: $1" >&2; shift;;
  esac
done

# ---------- 架构识别 ----------
detect_arch() {
  local m
  m=$(uname -m 2>/dev/null || echo unknown)
  case "$m" in
    x86_64|amd64)            echo amd64;;
    aarch64|arm64)           echo arm64;;
    i386|i486|i586|i686|386) echo 386;;
    armv7*|armv6*|arm)       echo arm;;
    mips64el)                echo mips64le;;
    mips64)                  echo mips64;;
    mipsel)                  echo mipsle;;
    mips)                    echo mips;;
    ppc64le|powerpc64le)     echo ppc64le;;
    s390x)                   echo s390x;;
    riscv64)                 echo riscv64;;
    loongarch64|loong64)     echo loong64;;
    *) echo "$m";;
  esac
}
ARCH=$(detect_arch)
echo "== 架构: $(uname -m) -> $ARCH"

# ---------- 下载地址构造 ----------
REPO="${REPO%/}"
FILE="probe-linux-$ARCH"
if [ "$VERSION" = "latest" ]; then
  BASE_URL="$REPO/$FILE"
  SUMS_URL="$REPO/SHA256SUMS"
else
  BASE_URL="$REPO/$VERSION/$FILE"
  SUMS_URL="$REPO/$VERSION/SHA256SUMS"
fi
echo "== 下载: $BASE_URL"

# ---------- 下载工具 ----------
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 10 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    echo "错误: 需要 curl 或 wget" >&2; return 1
  fi
}

TMP=$(mktemp -d 2>/dev/null || echo /tmp/.tinyprobe.$$)
trap 'rm -rf "$TMP"' EXIT
BIN_TMP="$TMP/$FILE"

# ---------- 下载二进制 ----------
if ! download "$BASE_URL" "$BIN_TMP"; then
  echo "错误: 下载失败，请检查 REPO 地址与架构 ($FILE)" >&2
  echo "提示: 该架构可能未提供二进制；可用源码自行编译（见 README）" >&2
  exit 1
fi
chmod +x "$BIN_TMP"

# ---------- 校验 SHA256（可选但强烈建议） ----------
if download "$SUMS_URL" "$TMP/SHA256SUMS" 2>/dev/null; then
  EXPECT=$(awk -v f="$FILE" '$2==f || $2=="./"f {print $1; exit}' "$TMP/SHA256SUMS")
  if [ -n "$EXPECT" ] && command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$BIN_TMP" | awk '{print $1}')
    if [ "$ACTUAL" != "$EXPECT" ]; then
      echo "错误: SHA256 校验失败 (期望 $EXPECT, 实际 $ACTUAL)" >&2
      exit 1
    fi
    echo "== SHA256 校验通过: $ACTUAL"
  elif [ -n "$EXPECT" ] && command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$BIN_TMP" | awk '{print $1}')
    if [ "$ACTUAL" != "$EXPECT" ]; then
      echo "错误: SHA256 校验失败" >&2; exit 1
    fi
    echo "== SHA256 校验通过: $ACTUAL"
  else
    echo "== 跳过校验（无 sha256sum/shasum 或无清单条目）"
  fi
else
  echo "== 无 SHA256SUMS，跳过校验"
fi

# ---------- 安装二进制 ----------
mkdir -p "$INSTALL_DIR"
OLD="$BIN_PATH.old"
[ -f "$BIN_PATH" ] && cp -f "$BIN_PATH" "$OLD" 2>/dev/null || true
cp -f "$BIN_TMP" "$BIN_PATH"
chmod +x "$BIN_PATH"
echo "== 已安装: $BIN_PATH"

# ---------- 注册开机自启 ----------
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  UNIT="/etc/systemd/system/$SERVICE.service"
  cat > "$UNIT" <<EOF
[Unit]
Description=tinyprobe monitor agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN_PATH -hub "$HUB" -name "$NAME" -interval $INTERVAL -token "$TOKEN" -service "$SERVICE"
Restart=always
RestartSec=5
LimitNOFILE=1024
MemoryMax=32M
CPUQuota=10%

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  echo "== systemd 服务已注册并启动: $SERVICE"
  sleep 1
  systemctl --no-pager status "$SERVICE" 2>/dev/null | head -12 || true
else
  echo "== 未检测到 systemd，使用 nohup 后台运行"
  pkill -f "$BIN_PATH" 2>/dev/null || true
  nohup "$BIN_PATH" -hub "$HUB" -name "$NAME" -interval $INTERVAL -token "$TOKEN" -service "$SERVICE" \
    >/var/log/tinyprobe.log 2>&1 &
  echo "== 已在后台运行，日志: /var/log/tinyprobe.log"
  echo "提示: 无 systemd 时不会开机自启，可在 /etc/rc.local 加入启动命令"
fi

echo "== 完成。节点名=$NAME 中心=$HUB 架构=$ARCH"
