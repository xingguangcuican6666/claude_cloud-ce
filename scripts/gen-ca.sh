#!/usr/bin/env bash
# 生成自签 CA + 叶子证书(SAN 含 api.anthropic.com)。
# 用法: scripts/gen-ca.sh [额外域名 ...]
#   例: scripts/gen-ca.sh cloud.example.com   # 顺带把你的真域名也签进去
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config"
mkdir -p "$DIR"; cd "$DIR"

# ── SAN 列表:第一方域名是硬要求,其余为可选 ──
# ── SAN:通配覆盖 Claude/Anthropic 全系功能域(App 保留原域名,我们按 SNI 接)──
SAN="DNS:*.anthropic.com,DNS:anthropic.com,DNS:*.claude.ai,DNS:claude.ai,DNS:*.claude.com,DNS:claude.com,DNS:*.claudeusercontent.com,DNS:*.claudemcpcontent.com,DNS:*.growthbook.io,DNS:localhost,IP:127.0.0.1"
# 额外参数:带 IP:/DNS: 前缀的原样加(IP:203.0.113.10),否则当域名
for d in "$@"; do case "$d" in IP:*|DNS:*) SAN="$SAN,$d";; *) SAN="$SAN,DNS:$d";; esac; done

# CA 已存在就复用——绝不重生,否则手机里已装的信任会失效
if [ -f ca.key ] && [ -f ca.pem ]; then
  echo "[gen-ca] 复用已有 CA(手机已装的信任仍有效)"
else
  echo "[gen-ca] 新建 CA ..."
  openssl genrsa -out ca.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
    -subj "/CN=claude_cloud-ce local CA" -out ca.pem 2>/dev/null
fi

echo "[gen-ca] 叶子证书  SAN=$SAN"
openssl genrsa -out leaf.key 2048 2>/dev/null
openssl req -new -key leaf.key -subj "/CN=api.anthropic.com" -out leaf.csr 2>/dev/null
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days 825 -sha256 -extfile <(printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$SAN") \
  -out leaf.pem 2>/dev/null

cat leaf.pem ca.pem > chain.pem
rm -f leaf.csr
chmod 600 ca.key leaf.key
echo "[gen-ca] 完成 → $DIR"
echo "         服务端用 chain.pem + leaf.key;客户端 NODE_EXTRA_CA_CERTS 指 ca.pem"
ls -l ca.pem chain.pem leaf.key