#!/usr/bin/env bash
# Cloudflare setup: KV namespace, secrets, deploy. Safe to re-run — generated values are kept in
# ../.env (gitignored), and values you add there later (API_511_KEY, ROUTINE_ID, ROUTINE_TOKEN,
# optional NTFY_TOPIC) are uploaded on the next run. Prerequisite: `wrangler login`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
cd "$ROOT/worker"

touch "$ENV_FILE"
# A hand-edited .env may lack a final newline; appending would glue two lines together.
if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then echo >> "$ENV_FILE"; fi
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
put() {
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i.bak "s|^$1=.*|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else echo "$1=$2" >> "$ENV_FILE"; fi
}
gen() { openssl rand -hex "$1"; }

if ! who="$(wrangler whoami 2>&1)"; then
  echo "$who"
  echo "wrangler 没登录或没装好：先运行 wrangler login（没装就 npm install -g wrangler）"
  exit 1
fi
case "$(get API_511_KEY)" in
  *=*) echo ".env 里的 API_511_KEY 看起来和下一行粘在一起了：$(get API_511_KEY)。修好再运行。"; exit 1 ;;
esac

# 1. KV namespace
if grep -q REPLACE_WITH_KV_NAMESPACE_ID wrangler.toml; then
  echo "→ 创建 KV namespace…"
  if ! kv_out="$(wrangler kv namespace create CG 2>&1)"; then
    echo "$kv_out"
    echo "创建 KV 失败。如果提示已存在：用 'wrangler kv namespace list' 找到 CG 的 id，填进 worker/wrangler.toml 再运行。"
    exit 1
  fi
  id="$(echo "$kv_out" | grep -oE '[0-9a-f]{32}' | head -1 || true)"
  [ -n "$id" ] || { echo "$kv_out"; echo "创建 KV 失败：输出里没有 id"; exit 1; }
  sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/$id/" wrangler.toml && rm -f wrangler.toml.bak
fi

# 2. Generated once, then reused
[ -n "$(get APP_PASSCODE)" ] || put APP_PASSCODE "$(gen 6)"
[ -n "$(get CG_WRITE_TOKEN)" ] || put CG_WRITE_TOKEN "$(gen 24)"
[ -n "$(get VAPID_PUBLIC_KEY)" ] || node "$ROOT/scripts/vapid-keys.mjs" >> "$ENV_FILE"

# 3. Deploy, then upload every secret that has a value
echo "→ 部署 Worker…"
if ! out="$(wrangler deploy 2>&1)"; then
  echo "$out"
  echo "部署失败（见上面 wrangler 的输出）"
  exit 1
fi
echo "$out" | tail -5
url="$(echo "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 || true)"
if [ -n "$url" ]; then put CG_BASE_URL "$url"; fi

secrets="$(mktemp)"; trap 'rm -f "$secrets"' EXIT
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const env = Object.fromEntries(
    readFileSync(process.argv[1], "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
  );
  // Worker secret name → .env name
  const names = { APP_PASSCODE: "APP_PASSCODE", WRITE_TOKEN: "CG_WRITE_TOKEN", VAPID_PUBLIC_KEY: "VAPID_PUBLIC_KEY",
    VAPID_PRIVATE_JWK: "VAPID_PRIVATE_JWK", API_511_KEY: "API_511_KEY", ROUTINE_ID: "ROUTINE_ID",
    ROUTINE_TOKEN: "ROUTINE_TOKEN", NTFY_TOPIC: "NTFY_TOPIC" };
  const out = Object.fromEntries(Object.entries(names).filter(([, k]) => env[k]).map(([s, k]) => [s, env[k]]));
  process.stdout.write(JSON.stringify(out));
' "$ENV_FILE" > "$secrets"
wrangler secret bulk "$secrets"

missing=()
[ -n "$(get API_511_KEY)" ] || missing+=("API_511_KEY（511 token，没有它查不了实时数据）")
[ -n "$(get ROUTINE_TOKEN)" ] || missing+=("ROUTINE_ID / ROUTINE_TOKEN（Claude routine 的 API 触发器；没有的话只推送自动检查结果）")

cat <<MSG

✅ 部署完成
  网站：      ${url:-（见上面 wrangler 输出）}
  访问密码：  $(get APP_PASSCODE)
  这些值都存在 $ENV_FILE（不会进 git）
MSG
if [ ${#missing[@]} -gt 0 ]; then
  echo "  还没填（写进 .env 后再运行一次本脚本）："
  for m in "${missing[@]}"; do echo "    - $m"; done
fi
