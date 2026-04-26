#!/usr/bin/env bash
# Diagnostic for the browser benchmark hang described in README-BENCH.
# Exercises each layer of the stack in isolation so you can see which one is
# broken:
#
#   1. HTTP server starts and serves files.
#   2. Puppeteer is installed and knows where its Chromium lives.
#   3. Headless Chromium can actually launch (times out after 30s if not).
#   4. The test page's runBench hook is callable from the driver.
#
# Output is short; run with --verbose to see Chromium's stderr too.

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib-env.sh"

VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

if [[ -t 1 ]]; then
  GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
else
  GREEN=""; YELLOW=""; RED=""; BOLD=""; RESET=""
fi
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; }
fail() { echo "  ${RED}✗${RESET} $*"; }

echo "${BOLD}1. Puppeteer package${RESET}"
if [ -d "$ROOT_DIR/node_modules/puppeteer" ]; then
  V="$(node -e 'console.log(require("puppeteer/package.json").version)' 2>/dev/null || echo "?")"
  ok "installed (v$V)"
else
  fail "puppeteer not in node_modules — run scripts/install-deps.sh first"
  exit 1
fi

echo "${BOLD}2. Chromium binary${RESET}"
CHROMIUM_PATH="$(node -e 'try { console.log(require("puppeteer").executablePath()); } catch(e) { process.exit(1); }' 2>/dev/null)"
if [ -n "$CHROMIUM_PATH" ] && [ -x "$CHROMIUM_PATH" ]; then
  ok "$CHROMIUM_PATH"
else
  fail "Chromium binary not found or not executable"
  warn "Prefetch with: node -e \"require('puppeteer').launch().then(b => b.close())\""
  exit 1
fi

echo "${BOLD}3. Chromium can launch (timeout 30s)${RESET}"
LAUNCH_OUT="$(mktemp)"
if [ "$VERBOSE" -eq 1 ]; then
  node -e '
    const puppeteer = require("puppeteer");
    const t = setTimeout(() => { console.error("LAUNCH_TIMEOUT"); process.exit(2); }, 30000);
    puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], dumpio: true })
      .then(b => b.close())
      .then(() => { clearTimeout(t); process.exit(0); })
      .catch(e => { clearTimeout(t); console.error("LAUNCH_ERROR:", e.message); process.exit(1); });
  ' 2>&1 | tee "$LAUNCH_OUT"
else
  node -e '
    const puppeteer = require("puppeteer");
    const t = setTimeout(() => { console.error("LAUNCH_TIMEOUT"); process.exit(2); }, 30000);
    puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] })
      .then(b => b.close())
      .then(() => { clearTimeout(t); process.exit(0); })
      .catch(e => { clearTimeout(t); console.error("LAUNCH_ERROR:", e.message); process.exit(1); });
  ' > "$LAUNCH_OUT" 2>&1
fi
rc=$?
if [ $rc -eq 0 ]; then
  ok "launched and closed cleanly"
elif [ $rc -eq 2 ]; then
  fail "Chromium launch hung (> 30s) — most common causes on Linux:"
  warn "  • Missing shared libraries. Try:"
  warn "      sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 \\"
  warn "          libxss1 libgbm1 libdrm2 libasound2 libxkbcommon0 libxcomposite1 \\"
  warn "          libxdamage1 libxrandr2 libu2f-udev"
  warn "  • /dev/shm too small (Docker). --disable-dev-shm-usage is already set."
  warn "  • Headless-without-display bug: on very old distros, try --single-process."
  echo "---- stderr/stdout ----"; cat "$LAUNCH_OUT"
  rm -f "$LAUNCH_OUT"; exit 1
else
  fail "Chromium launch failed"
  echo "---- stderr/stdout ----"; cat "$LAUNCH_OUT"
  rm -f "$LAUNCH_OUT"; exit 1
fi
rm -f "$LAUNCH_OUT"

echo "${BOLD}4. Local bench server serves index.html${RESET}"
# If a previous aborted run left a server holding port 8787, the benchmarks
# will crash on spawn with EADDRINUSE. Detect that first, then launch.
PORT_HOLDER=""
if command -v lsof >/dev/null 2>&1; then
  PORT_HOLDER="$(lsof -ti :8787 2>/dev/null | head -n1)"
fi
if [ -n "$PORT_HOLDER" ]; then
  warn "port 8787 is already in use by pid $PORT_HOLDER"
  warn "kill it with: kill $PORT_HOLDER  (or: lsof -ti :8787 | xargs kill)"
  fail "benchmark server will fail to bind until the port is free"
  exit 1
fi
node "$ROOT_DIR/browser-bench/server.js" > /tmp/paraweb-diag-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
sleep 0.5
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/browser-bench/index.html | grep -q "^200$"; then
  ok "server returns 200 for /browser-bench/index.html"
else
  fail "server did not respond on :8787 — see /tmp/paraweb-diag-server.log"
  exit 1
fi

echo
echo "${GREEN}${BOLD}All checks passed.${RESET} If the real bench still hangs, run it with --verbose and"
echo "check logs for errors after the 'step: launching headless Chromium' line."
