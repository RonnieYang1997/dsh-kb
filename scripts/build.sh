#!/bin/bash
# Build: compile src/ → lib/ (host) and bundle src/client → lib/client.js (UI).
#
# 两条路径（2026-10-11 实测本机现实）：
#  A) 有 DSH 源码 checkout（$DSH_CHECKOUT 或 ~/dsh-harness …，含 packages/）：
#     按官方形态从 checkout 里 junction 链接 @deepseek-ai/* 与 @types/node，再用 checkout 的 tsc。
#  B) 没有 checkout（本机就是这样：DSH 装在 app.asar 里，没有源码树、没有 .d.ts）：
#     退回到**本包自己的 devDependencies**（typescript / tsdown，已 npm i 装好）。
#
# 无论哪条路径，产物都是 lib/index.js（host）+ lib/client.js（UI bundle）。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find_checkout() {
  local c="${DSH_CHECKOUT:-}"
  if [ -n "$c" ] && [ -d "$c/packages" ]; then echo "$c"; return 0; fi
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then echo "$candidate"; return 0; fi
  done
  echo ""
}

CHECKOUT="$(find_checkout)"
TSC=""

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    return 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
}

if [ -n "$CHECKOUT" ] && [ -x "$CHECKOUT/node_modules/.bin/tsc" -o -f "$CHECKOUT/node_modules/.bin/tsc.cmd" ]; then
  echo "=== Path A: linking build deps from checkout ($CHECKOUT) ==="
  mkdir -p node_modules/@deepseek-ai
  link_pkg @deepseek-ai/cordis vendor/cordis || exit 1
  link_pkg cosmokit vendor/cosmokit || exit 1
  link_pkg @deepseek-ai/schemastery vendor/schemastery || exit 1
  link_pkg @deepseek-ai/dsh-tools packages/core/tools || exit 1
  link_pkg @deepseek-ai/dsh-llm packages/llm/llm || exit 1
  link_pkg @deepseek-ai/dsh-system-prompt packages/core/system-prompt || exit 1
  link_pkg @types/node node_modules/@types/node || exit 1
  TSC="$CHECKOUT/node_modules/.bin/tsc"
else
  echo "=== Path B: no DSH source checkout — using this package's own devDependencies ==="
  if [ -x node_modules/.bin/tsc ] || [ -f node_modules/.bin/tsc.cmd ]; then
    TSC="node_modules/.bin/tsc"
  fi
fi

if [ -z "$TSC" ]; then
  echo "build: no TypeScript compiler found." >&2
  echo "       Path A needs a DSH source checkout (set DSH_CHECKOUT); Path B needs 'npm install' (typescript devDependency)." >&2
  exit 1
fi

echo "=== Compiling src → lib (host: $TSC) ==="
"$TSC" -p tsconfig.json
TSC_RC=$?
if [ $TSC_RC -ne 0 ]; then
  echo "build: tsc failed (exit $TSC_RC)" >&2
  exit $TSC_RC
fi

echo "=== Bundling client (tsdown → lib/client.js) ==="
if [ -f node_modules/tsdown/dist/run.mjs ]; then
  node node_modules/tsdown/dist/run.mjs
  CLIENT_RC=$?
  if [ $CLIENT_RC -ne 0 ]; then
    echo "build: client bundle failed (exit $CLIENT_RC)" >&2
    exit $CLIENT_RC
  fi
else
  echo "build: tsdown 不可用 → 跳过 client bundle（面板缺失，host 工具照常可用）" >&2
fi

echo "=== Build complete ==="
ls -l lib/index.js lib/client.js 2>/dev/null || true
