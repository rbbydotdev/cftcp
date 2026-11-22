#!/usr/bin/env bash
# Run the box locally and SSH in, via `wrangler dev` with the same wrangler.jsonc
# you deploy: pi uses your real Workers AI (the AI binding is proxied to your
# Cloudflare account and billed as in production).
#   npm run dev                 project "scratch"
#   npm run dev -- <project>    a new name makes the project; an existing one resumes it
#   npm run dev -- admin        the admin screen
# Needs `npx wrangler login` once. Preview: http://127.0.0.1:8787/<project>/
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in -h|--help) sed -n '2,8p' "$0"; exit 0 ;; esac
project="${1:-scratch}"
ssh_port=2222 # wrangler.jsonc "connect"
http_port="${HTTP_PORT:-8787}"

[ -d node_modules ] || npm install --silent
[ -f dist/worker.js ] || npm run build --silent

if ! npx wrangler whoami 2>/dev/null | grep -q "logged in"; then
  echo "Log in to Cloudflare first (pi runs on your Workers AI):  npx wrangler login" >&2
  exit 1
fi

# Local-only SSH key: the box's AUTHORIZED_KEYS for this run.
mkdir -p .wrangler
key=.wrangler/dev_ssh_key
[ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -C cftcp-dev -f "$key"

log=.wrangler/dev.log
npx wrangler dev --port "$http_port" --persist-to .wrangler/state \
  --var "AUTHORIZED_KEYS:$(cat "$key.pub")" --var PREVIEW_PUBLIC:1 \
  --var "PREVIEW_URL:http://127.0.0.1:$http_port" --var "SSH_HOST:127.0.0.1 -p $ssh_port" \
  > "$log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
for _ in $(seq 120); do
  grep -q "Ready on" "$log" 2>/dev/null && break
  kill -0 $server 2>/dev/null || { cat "$log"; exit 1; }
  sleep 0.5
done
[ "$project" != admin ] && echo "preview: http://127.0.0.1:$http_port/$project/"

ssh -t -p "$ssh_port" -i "$key" -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  "$project@127.0.0.1"
