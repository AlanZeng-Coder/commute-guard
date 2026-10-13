#!/usr/bin/env bash
# One-time Cloudflare setup: KV namespace, secrets, deploy. Safe to re-run (keeps existing values
# from .env). Prerequisite: `wrangler login`.
#
# Writes the generated values to ../.env (gitignored):
#   CG_BASE_URL, CG_WRITE_TOKEN, APP_PASSCODE, NTFY_TOPIC
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
cd "$ROOT/worker"

touch "$ENV_FILE"
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
put() {
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i.bak "s|^$1=.*|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else echo "$1=$2" >> "$ENV_FILE"; fi
}
gen() { openssl rand -hex "$1"; }

wrangler whoami >/dev/null 2>&1 || { echo "先运行: wrangler login"; exit 1; }

# 1. KV namespace
if grep -q REPLACE_WITH_KV_NAMESPACE_ID wrangler.toml; then
  echo "→ 创建 KV namespace…"
  id="$(wrangler kv namespace create CG 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)"
  [ -n "$id" ] || { echo "创建 KV 失败"; exit 1; }
  sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/$id/" wrangler.toml && rm -f wrangler.toml.bak
fi

# 2. Secrets (generated once, then reused)
APP_PASSCODE="$(get APP_PASSCODE)"; [ -n "$APP_PASSCODE" ] || APP_PASSCODE="$(gen 6)"
CG_WRITE_TOKEN="$(get CG_WRITE_TOKEN)"; [ -n "$CG_WRITE_TOKEN" ] || CG_WRITE_TOKEN="$(gen 24)"
NTFY_TOPIC="$(get NTFY_TOPIC)"; [ -n "$NTFY_TOPIC" ] || NTFY_TOPIC="commute-guard-$(gen 8)"
put APP_PASSCODE "$APP_PASSCODE"
put CG_WRITE_TOKEN "$CG_WRITE_TOKEN"
put NTFY_TOPIC "$NTFY_TOPIC"

# 3. Deploy, then attach secrets in one batch
echo "→ 部署 Worker…"
out="$(wrangler deploy 2>&1)"; echo "$out" | tail -5
url="$(echo "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
[ -n "$url" ] && put CG_BASE_URL "$url"

secrets="$(mktemp)"; trap 'rm -f "$secrets"' EXIT
printf '{"APP_PASSCODE":"%s","WRITE_TOKEN":"%s","NTFY_TOPIC":"%s"}' "$APP_PASSCODE" "$CG_WRITE_TOKEN" "$NTFY_TOPIC" > "$secrets"
wrangler secret bulk "$secrets"

cat <<EOF

✅ 部署完成
  网站：        ${url:-（见上面 wrangler 输出）}
  访问密码：    $APP_PASSCODE
  ntfy topic：  $NTFY_TOPIC   ← 在手机 ntfy App 里订阅这个 topic
  这些值都存在 $ENV_FILE（不会进 git）
EOF
