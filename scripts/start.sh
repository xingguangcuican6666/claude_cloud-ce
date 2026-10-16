#!/usr/bin/env bash
# 启动 claude_cloud-ce 服务(幂等:已在跑则提示并退出,不重复启动)。
# 用法: scripts/start.sh
#
# 不是真常驻服务(无 systemd/pm2),宿主重启或会话结束就会掉——这就是这个脚本存在的原因:
# 随时跑一遍就能原样拉起来,数据全落盘 config/ 和 ~/.config/cc-cloud/,不会丢。
#
# 端口默认 443/8890/8898,和 server/app.mjs 自身的默认值一致;要覆盖就在调用前 export
# 同名环境变量(CC_APP_PORT/CC_WEB_PORT/CC_PROXY_PORT),这个脚本的健康检查会跟着用。
# ⚠ 这个脚本是纯 shell,不解析 config/config.json——如果你只在那份 json 里改了端口、
# 没有同时 export 对应环境变量,下面的检测用的还是旧端口号(不影响服务本身,只影响这个
# 健康检查脚本看得准不准)。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PIDFILE="$ROOT/.cc-cloud.pid"
BOOTLOG="$ROOT/boot.log"

WEB_PORT="${CC_WEB_PORT:-8890}"
PROXY_PORT="${CC_PROXY_PORT:-8898}"
APP_PORT="${CC_APP_PORT:-443}"
# APP_PORT<=0 对应 app.mjs 里"跳过该监听"的语义,检测列表要跟着摘掉这一项,
# 不然会出现"用户特意禁用了这个端口,脚本却还在等它"的新不一致。
PORTS="$WEB_PORT|$PROXY_PORT"
if [ "$APP_PORT" -gt 0 ] 2>/dev/null; then PORTS="$PORTS|$APP_PORT"; fi

# ── 已在跑?(pidfile 记录的进程确实存在,且确实是我们这个服务)──
if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null \
     && ps -p "$OLD_PID" -o args= 2>/dev/null | grep -q 'server/app.mjs'; then
    echo "[start] 已在运行 (pid=$OLD_PID)。要重启先执行 scripts/stop.sh 再启动。"
    exit 0
  fi
  echo "[start] pidfile 陈旧(进程已不在),清理"
  rm -f "$PIDFILE"
fi

# ── 没有有效 pidfile,但端口已被占用 → 大概率是别的方式(手动 nohup 等)起的实例,
#    不受本脚本管理,直接再起一个会端口冲突,先提醒用户自己处理 ──
if ss -ltn 2>/dev/null | grep -qE ":($PORTS)[[:space:]]"; then
  echo "[start] 端口 $PORTS 之一已被占用,但没有有效 pidfile(不是本脚本启动的)。"
  echo "[start] 可能是手动起的旧实例——先确认是什么、按需 stop 掉,再重新运行本脚本。"
  ss -ltnp 2>/dev/null | grep -E ":($PORTS)[[:space:]]" || true
  exit 1
fi

echo "[start] 启动 claude_cloud-ce ..."
nohup node server/app.mjs >> "$BOOTLOG" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"
disown "$NEW_PID" 2>/dev/null || true

# 等最多 5 秒,确认进程没有立刻崩、关键端口起来了
ok=0
for _ in $(seq 1 10); do
  sleep 0.5
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "[start] 进程已退出,启动失败。$BOOTLOG 最后 20 行:"
    tail -20 "$BOOTLOG"
    rm -f "$PIDFILE"
    exit 1
  fi
  if ss -ltn 2>/dev/null | grep -q ":$WEB_PORT[[:space:]]"; then ok=1; break; fi
done

echo "[start] 已启动 (pid=$NEW_PID)"
ss -ltnp 2>/dev/null | grep -E ":($PORTS)[[:space:]]" || true
if [ "$ok" -ne 1 ]; then
  echo "[start] ⚠ 5 秒内没看到 $WEB_PORT 端口起来,看看 $BOOTLOG / app.log 排查"
fi
echo "[start] 日志: app.log(应用日志,含 ban/login 等事件) / boot.log(启动期 stdout,崩溃排查用)"
