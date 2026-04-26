#!/usr/bin/env bash
# Verifies that the host has everything needed to reproduce ParaWeb's
# benchmarks. Reports findings as a checklist and exits non-zero if any
# required dependency is missing. Does NOT install anything — that's what
# scripts/install-deps.sh is for.
#
# Covered checks:
#   - Node.js >= 22
#   - npm available
#   - git available
#   - Platform (darwin / linux / unsupported)
#   - On Linux: NVIDIA driver (nvidia-smi), Vulkan loader, at least one Vulkan
#     physical device that is NOT a software renderer (llvmpipe/swiftshader)
#   - node_modules present (= `npm install` has been run)
#   - dist/ present (= `npm run build` has been run)
#   - browser-bench/gpu-bundle.js present (= esbuild bundle built)
#   - Puppeteer's Chromium cache present (= headless browser downloaded)

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

# Source the shared environment so we pick up nvm-installed Node even if the
# user is running the script from a shell that hasn't loaded their rc files.
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib-env.sh"

# ---- coloured status helpers -------------------------------------------------
if [[ -t 1 ]]; then
  GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
else
  GREEN=""; YELLOW=""; RED=""; BOLD=""; RESET=""
fi

FAIL_COUNT=0
WARN_COUNT=0

pass() { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; WARN_COUNT=$((WARN_COUNT + 1)); }
fail() { echo "  ${RED}✗${RESET} $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
info() { echo "  · $*"; }
hdr()  { echo; echo "${BOLD}$*${RESET}"; }

version_ge() {
  # returns 0 (success) if $1 >= $2, where both are dotted semver-ish strings.
  [ "$(printf '%s\n%s' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# ---- platform ----------------------------------------------------------------
hdr "Platform"
UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Darwin)  PLATFORM="darwin";  pass "macOS detected (GPU via Apple Metal)" ;;
  Linux)   PLATFORM="linux";   pass "Linux detected (GPU via Vulkan)" ;;
  *)       PLATFORM="other";   warn "Platform $UNAME_S is not officially supported; continuing with best-effort checks" ;;
esac

# ---- node / npm / git --------------------------------------------------------
hdr "Toolchain"

if command -v node >/dev/null 2>&1; then
  NODE_VERSION_RAW="$(node --version 2>/dev/null)"
  NODE_VERSION="${NODE_VERSION_RAW#v}"
  if version_ge "$NODE_VERSION" "22.0.0"; then
    pass "Node.js $NODE_VERSION_RAW"
  else
    fail "Node.js $NODE_VERSION_RAW is too old; need >= 22.0.0 (install-deps.sh can install it locally via nvm)"
  fi
else
  fail "Node.js not found on PATH (install-deps.sh can install it locally via nvm — no sudo)"
fi

if command -v npm >/dev/null 2>&1; then
  pass "npm $(npm --version 2>/dev/null)"
else
  fail "npm not found on PATH"
fi

if command -v git >/dev/null 2>&1; then
  pass "git $(git --version 2>/dev/null | awk '{print $3}')"
else
  warn "git not found (only needed if you plan to clone/update the repo)"
fi

if command -v npx >/dev/null 2>&1; then
  pass "npx available"
else
  warn "npx not found; you may need to invoke esbuild/tsc directly"
fi

# ---- GPU / Vulkan (Linux) ---------------------------------------------------
if [ "$PLATFORM" = "linux" ]; then
  hdr "GPU / Vulkan (Linux)"
  if command -v nvidia-smi >/dev/null 2>&1; then
    DRIVER="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1)"
    GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)"
    if [ -n "$DRIVER" ]; then
      pass "NVIDIA driver $DRIVER ($GPU_NAME)"
      if version_ge "$DRIVER" "525.0.0"; then :; else
        warn "NVIDIA driver is older than 525; WebGPU via Dawn may misbehave"
      fi
    else
      warn "nvidia-smi ran but reported no driver/GPU; is the driver loaded?"
    fi
  else
    warn "nvidia-smi not found — if you have another GPU vendor you can ignore this; otherwise install the NVIDIA driver"
  fi

  if command -v vulkaninfo >/dev/null 2>&1; then
    if vulkaninfo --summary >/dev/null 2>&1; then
      VK_GPUS="$(vulkaninfo --summary 2>/dev/null | awk '/deviceName/ {sub(/^[^=]*= */,""); print}')"
      if [ -n "$VK_GPUS" ]; then
        pass "Vulkan devices:"
        while IFS= read -r line; do info "  $line"; done <<< "$VK_GPUS"
        if echo "$VK_GPUS" | grep -qiE "llvmpipe|swiftshader|software"; then
          if echo "$VK_GPUS" | grep -qvE "llvmpipe|swiftshader|software"; then :; else
            warn "Only a software Vulkan renderer is available; GPU benchmarks will run on CPU and be meaningless"
          fi
        fi
      else
        warn "vulkaninfo reported no devices"
      fi
    else
      fail "vulkaninfo exited with error; Vulkan loader is installed but cannot enumerate devices"
    fi
  else
    fail "vulkaninfo not found; install the Vulkan tools (e.g. apt-get install vulkan-tools libvulkan1)"
  fi
fi

# ---- macOS GPU note ----------------------------------------------------------
if [ "$PLATFORM" = "darwin" ]; then
  hdr "GPU (macOS)"
  pass "Apple GPU is accessed through Metal; no extra setup needed"
  if system_profiler SPDisplaysDataType 2>/dev/null | grep -qE "Chipset Model|Metal"; then
    GPU="$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2; exit}')"
    if [ -n "$GPU" ]; then info "GPU: $GPU"; fi
  fi
fi

# ---- project state -----------------------------------------------------------
hdr "Project state"
if [ -d "node_modules" ]; then
  pass "node_modules/ present"
else
  fail "node_modules/ missing — run: npm install  (or scripts/install-deps.sh)"
fi

if [ -d "dist" ] && [ -f "dist/index.js" ]; then
  pass "dist/ built"
else
  fail "dist/ missing or incomplete — run: npm run build"
fi

if [ -f "browser-bench/gpu-bundle.js" ]; then
  pass "browser-bench/gpu-bundle.js present"
else
  warn "browser-bench/gpu-bundle.js missing — needed for browser GPU bench; the install script rebuilds it"
fi

# ---- puppeteer cache (optional) ----------------------------------------------
PUPPETEER_CACHE_DIRS=(
  "$HOME/.cache/puppeteer/chrome"
  "$HOME/.cache/puppeteer/chrome-headless-shell"
  "$ROOT_DIR/node_modules/puppeteer/.local-chromium"
)
CHROMIUM_FOUND=0
for d in "${PUPPETEER_CACHE_DIRS[@]}"; do
  # Cache is populated iff the directory exists and contains at least one
  # version subdirectory. Binary name / path varies by platform and puppeteer
  # version (`chrome`, `chrome-headless-shell`, or "Google Chrome for Testing"
  # inside a .app bundle on macOS), so we trust the directory layout.
  if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then
    CHROMIUM_FOUND=1
    info "Puppeteer Chromium cache at $d"
  fi
done
if [ "$CHROMIUM_FOUND" -eq 1 ]; then
  pass "Puppeteer Chromium downloaded"
else
  warn "Puppeteer Chromium not yet downloaded (happens automatically on first browser-bench run)"
fi

# ---- summary -----------------------------------------------------------------
hdr "Summary"
if [ "$FAIL_COUNT" -eq 0 ]; then
  if [ "$WARN_COUNT" -eq 0 ]; then
    echo "${GREEN}All checks passed — you can run the benchmark suites.${RESET}"
  else
    echo "${YELLOW}All required checks passed, with $WARN_COUNT warning(s) above.${RESET}"
  fi
  exit 0
else
  echo "${RED}$FAIL_COUNT required check(s) failed, $WARN_COUNT warning(s).${RESET}"
  echo "Run ${BOLD}./scripts/install-deps.sh${RESET} to fix project-side issues, then rerun this script."
  exit 1
fi
