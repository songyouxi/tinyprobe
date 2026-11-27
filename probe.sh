#!/bin/bash
# tinyprobe 纯 shell 探针 —— 服务器上不需要 Node/Python/Go，只要 bash + /proc。
# 用法: bash probe.sh [HUB_URL] [NAME] [INTERVAL_SEC]
#   HUB_URL 例: http://192.168.1.13:47821   NAME 例: web-01   INTERVAL 默认 2 秒
# 上报走 bash 内置 /dev/tcp，连 curl/wget 都不需要。

HUB="${1:-http://127.0.0.1:47821}"
NAME="${2:-$(hostname)}"
INTERVAL="${3:-2}"

# 解析 hub 地址
URL="${HUB#http://}"; URL="${URL#https://}"
HOST="${URL%%:*}"; PORT="${URL##*:}"
[ "$PORT" = "$HOST" ] && PORT=80

# 上一次网络计数（用于算速率）
prev_rx=0; prev_tx=0; first=1

human() { # 字节转可读
  local b="$1" u=(B K M G T) i=0
  while [ "${b%.*}" -ge 1024 ] 2>/dev/null && [ $i -lt 4 ]; do
    b=$(awk "BEGIN{printf \"%.1f\",$b/1024}"); i=$((i+1))
  done
  printf '%s%s' "$b" "${u[$i]}"
}

get_cpu() {
  # 取 /proc/stat 两帧算利用率
  read -r _ u1 n1 s1 i1 w1 _ < /proc/stat
  sleep 0.3
  read -r _ u2 n2 s2 i2 w2 _ < /proc/stat
  local idle=$((i2-i1)) total=$(( (u2+n2+s2+i2+w2) - (u1+n1+s1+i1+w1) ))
  [ "$total" -le 0 ] && { echo 0; return; }
  awk "BEGIN{printf \"%.1f\",(1-$idle/$total)*100}"
}

get_mem() {
  local total free avail
  while read -r k v _; do
    case "$k" in MemTotal:) total=$v;; MemAvailable:) avail=$v;; MemFree:) free=$v;; esac
  done < /proc/meminfo
  [ -z "$avail" ] && avail=$free
  local used=$(( (total-avail) )) pct=0
  [ "$total" -gt 0 ] && pct=$(awk "BEGIN{printf \"%.1f\",$used*100/$total}")
  # 转成字节（KB*1024）
  echo "$((total*1024)) $((used*1024)) $pct"
}

get_disk() {
  local line
  line=$(df -P / 2>/dev/null | tail -1)
  [ -z "$line" ] && { echo "0 0 0 /"; return; }
  local total used pct mount
  total=$(echo "$line" | awk '{print $2}'); used=$(echo "$line" | awk '{print $3}')
  pct=$(echo "$line" | awk '{gsub(/%/,"");print $5}'); mount=$(echo "$line" | awk '{print $6}')
  echo "$((total*1024)) $((used*1024)) $pct $mount"
}

get_net() {
  local rx=0 tx=0 line
  while read -r line; do
    case "$line" in *:*) ;; *) continue;; esac
    local iface="${line%%:*}"; [ "$iface" = lo ] && continue
    set -- $line
    rx=$((rx + ${2:-0})); tx=$((tx + ${10:-0}))
  done < /proc/net/dev
  local drx=0 dtx=0
  if [ $first -eq 0 ]; then
    [ "$rx" -ge "$prev_rx" ] && drx=$((rx-prev_rx))
    [ "$tx" -ge "$prev_tx" ] && dtx=$((tx-prev_tx))
  fi
  prev_rx=$rx; prev_tx=$tx
  echo "$drx $dtx"
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

report() {
  local cpu=$(get_cpu)
  local mem_total mem_used mem_pct
  read -r mem_total mem_used mem_pct < <(get_mem)
  local disk_total disk_used disk_pct disk_path
  read -r disk_total disk_used disk_pct disk_path < <(get_disk)
  local net_rx net_tx
  read -r net_rx net_tx < <(get_net)
  first=0

  local body
  body=$(cat <<EOF
{"name":"$(json_escape "$NAME")","host":"$(json_escape "$(hostname)")","platform":"linux","arch":"$(uname -m)","time":$(date +%s)000,"cpu":$cpu,"cpus":$(nproc 2>/dev/null || echo 1),"mem":{"total":$mem_total,"used":$mem_used,"percent":$mem_pct},"disk":{"path":"$(json_escape "$disk_path")","total":$disk_total,"used":$disk_used,"percent":$disk_pct},"net":{"rx":$net_rx,"tx":$net_tx}}
EOF
)
  # 用 bash 内置 /dev/tcp 发 HTTP POST（无需 curl/wget）
  exec 3<>"/dev/tcp/$HOST/$PORT" || { echo "connect failed" >&2; return 1; }
  printf 'POST /report HTTP/1.1\r\nHost: %s:%s\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
    "$HOST" "$PORT" "${#body}" "$body" >&3
  # 读掉响应首行
  local status; read -r -t 3 status <&3
  exec 3<&- 3>&-
  echo "[$(date +%H:%M:%S)] $NAME CPU ${cpu}% MEM ${mem_pct}% DISK ${disk_pct}% -> ${status:-no-response}"
}

echo "tinyprobe(sh) -> $HUB as \"$NAME\" every ${INTERVAL}s"
while true; do report; sleep "$INTERVAL"; done
