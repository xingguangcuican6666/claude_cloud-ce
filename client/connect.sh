#!/usr/bin/env bash
# 客户端接入脚本:把 cc 指向 claude_cloud-ce 服务器并启动 Remote Control 会话。
# 用法:
#   CC_SERVER=1.2.3.4:8898 CC_CA=/path/to/ca.pem client/connect.sh [会话名]
# 若服务器用的是公网真域名证书(非自签),可不设 CC_CA。
set -euo pipefail

SERVER="${CC_SERVER:-127.0.0.1:8898}"
NAME="${1:-}"

ENV_ARGS=(
  "HTTPS_PROXY=http://$SERVER"
  "HTTP_PROXY=http://$SERVER"
  # 身份四件套:ssh-placeholder 让鉴权源切到代理;scopes 补 user:profile;pro 过订阅门
  "CLAUDE_CODE_OAUTH_TOKEN=ssh-placeholder"
  "CLAUDE_CODE_OAUTH_SCOPES=user:inference user:profile user:office user:ccr_inference"
  "CLAUDE_CODE_SUBSCRIPTION_TYPE=pro"
)
[ -n "${CC_CA:-}" ] && ENV_ARGS+=("NODE_EXTRA_CA_CERTS=$CC_CA")

echo "[connect] 代理 $SERVER  CA=${CC_CA:-（系统信任，走真域名）}"
exec env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_UNIX_SOCKET \
  "${ENV_ARGS[@]}" claude --rc $NAME