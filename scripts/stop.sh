#!/usr/bin/env bash
# 停止 claude_cloud-ce 服务(配 scripts/start.sh 用)。
# 用法: scripts/stop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$ROOT/.cc-cloud.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "[stop] 没有 pidfile,本来就没在跑(或者是别的方式启动的,不受本脚本管理)"
  exit 0
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "[stop] pid=$PID 已不存在(陈旧 pidfile),清理"
  rm -f "$PIDFILE"
  exit 0
fi

echo "[stop] 停止 pid=$PID ..."
kill "$PID"
for _ in $(seq 1 20); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.3
done
if kill -0 "$PID" 2>/dev/null; then
  echo "[stop] 优雅退出超时(6秒),强制 kill -9"
  kill -9 "$PID" 2>/dev/null || true
fi
rm -f "$PIDFILE"
echo "[stop] 已停止"
