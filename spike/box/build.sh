#!/usr/bin/env bash
# Build russh->wasm, wasm-bindgen glue, and bundle the Worker into dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.wasixcc/llvm/bin:$PATH"
# Build output lives outside the repo (keeps the project folder small).
export CARGO_TARGET_DIR="$HOME/.cache/cftcp/cargo-target"
(cd sshd && CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=llvm-ar \
  cargo +1.91.0 build --release --target wasm32-unknown-unknown -q)
wasm-bindgen --target web --out-dir sshd/pkg "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/cftcp_sshd.wasm"
mkdir -p dist && cp sshd/pkg/cftcp_sshd_bg.wasm dist/
node box/bundle.mjs
sed -i "s|\"\.\./sshd/pkg/cftcp_sshd_bg\.wasm\"|\"./cftcp_sshd_bg.wasm\"|" dist/worker.js
ls -la dist
echo "gzip total: $(cat dist/* | gzip -9 | wc -c) bytes"
