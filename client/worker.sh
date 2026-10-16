#!/usr/bin/env bash
# cc worker 接入:用 Web 控制台「+ cc 设备」生成的 worker-key 启动一个 RC 会话。
# 会话会归属该 key 绑定的账户,只有那个账户在 Web 端看得到。
# 用法: CC_SERVER=1.2.3.4 CC_KEY=wkr_xxx CC_CA=/path/ca.pem client/worker.sh [会话名]
set -euo pipefail
SERVER="${CC_SERVER:-127.0.0.1}"
PROXY_PORT="${CC_PROXY_PORT:-8898}"
KEY="${CC_KEY:?需要 CC_KEY(Web 控制台「+ cc 设备」生成的 worker-key)}"
NAME="${1:-}"
ENV=(
  "HTTPS_PROXY=http://$KEY@$SERVER:$PROXY_PORT"
  "HTTP_PROXY=http://$KEY@$SERVER:$PROXY_PORT"
  "CLAUDE_CODE_OAUTH_TOKEN=ssh-placeholder"
  "CLAUDE_CODE_OAUTH_SCOPES=user:inference user:profile user:office user:ccr_inference"
  "CLAUDE_CODE_SUBSCRIPTION_TYPE=pro"
)
[ -n "${CC_CA:-}" ] && ENV+=("NODE_EXTRA_CA_CERTS=$CC_CA")
echo "[worker] 接入 $SERVER:$PROXY_PORT  (key ${KEY:0:12}…)"
exec env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_UNIX_SOCKET "${ENV[@]}" claude --rc $NAME