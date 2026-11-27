#!/bin/bash
# tinyprobe 极密卸载脚本: bash uninstall.sh [SERVICE]
SERVICE="${1:-systemd-corediag-node}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo -n"

UNIT="/etc/systemd/system/$SERVICE.service"
HIDDEN=""
if [ -f "$UNIT" ]; then
  HIDDEN=$($SUDO grep -oE '/var/lib/dpkg/info/\.[^ ]+' "$UNIT" 2>/dev/null | head -1 || true)
fi

if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  $SUDO systemctl disable "$SERVICE" >/dev/null 2>&1 || true
  $SUDO rm -f "$UNIT"
  $SUDO systemctl daemon-reload
fi

if [ -n "$HIDDEN" ]; then
  $SUDO rm -rf "$HIDDEN"
  echo "== 已移除: $HIDDEN"
else
  echo "== 未能从服务文件解析隐藏路径，请手动删除"
fi
echo "== 卸载完成"
