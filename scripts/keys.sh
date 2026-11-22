#!/usr/bin/env bash
# Set who can SSH in: uploads public keys as the deployed Worker's AUTHORIZED_KEYS.
#   npm run keys                          ~/.ssh/id_ed25519.pub
#   npm run keys -- a.pub b.pub           several devices (replaces the whole list)
# Paste a key instead (e.g. from Termius): npx wrangler secret put AUTHORIZED_KEYS
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in -h|--help) sed -n '2,5p' "$0"; exit 0 ;; esac
[ $# -gt 0 ] || set -- "$HOME/.ssh/id_ed25519.pub"

keys=""
for f in "$@"; do
  [ -f "$f" ] || { echo "no such file: $f (make one with: ssh-keygen -t ed25519)" >&2; exit 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    case "$line" in
      ssh-ed25519\ *|ecdsa-sha2-*\ *|ssh-rsa\ *) ;;
      *) echo "$f doesn't look like a public key (a private key? use the .pub file)" >&2; exit 1 ;;
    esac
    printf '%s\n' "$line" | ssh-keygen -lf - >/dev/null 2>&1 || { echo "$f: invalid public key" >&2; exit 1; }
    keys+="$line"$'\n'
  done < "$f"
done

echo "These keys will be able to log in (replacing the current list):"
printf '%s' "$keys" | ssh-keygen -lf - | sed 's/^/  /'
printf '%s' "$keys" | npx wrangler secret put AUTHORIZED_KEYS
