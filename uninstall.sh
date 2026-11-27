#!/bin/bash
# tinyprobe 卸载脚本：停止服务、删服务文件、删二进制。
# 用法: bash uninstall.sh [SERVICE_NAME]   默认 tinyprobe

SERVICE="${1:-tinyprobe}"
BIN="/usr/local/bin/tinyprobe-probe"

if command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  systemctl disable "$SERVICE" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  echo "== 服务已停止并移除: $SERVICE"
else
  pkill -f "$BIN" 2>/dev/null || true
  echo "== 后台进程已停止"
fi

rm -f "$BIN" "$BIN.old"
echo "== 二进制已移除: $BIN"
echo "== 卸载完成"
