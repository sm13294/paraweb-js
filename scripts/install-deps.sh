#!/usr/bin/env bash
# Installs everything ParaWeb needs to run its benchmarks.
#
# This script assumes NO root access by default. It will:
#   1. If Node.js is missing or too old: install Node.js >= 22 locally via nvm
#      under $HOME/.nvm, then source it into the current shell. No sudo.
#   2. Run `npm install`.
#   3. Run `npm run build` (TypeScript -> dist/).
#   4. Rebuild browser-bench/gpu-bundle.js via esbuild.
#
# On Linux, the GPU stack (NVIDIA driver + Vulkan loader) genuinely requires
# root privileges to install; this script cannot bypass that. It detects what
# is missing and prints the exact apt-get line to run. If you do not have
# root access on the target machine, you can still run every CPU benchmark
# (Node MP and Shared, browser CPU) — only the Node GPU and browser GPU
# suites need a working Vulkan + NVIDIA driver stack.
#
# Run:
#   bash scripts/install-deps.sh              # interactive
#   bash scripts/install-deps.sh --yes        # auto-confirm prompts
#   bash scripts/install-deps.sh --skip-build # install Node + npm deps only
#   bash scripts/install-deps.sh --no-node    # never auto-install Node

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

# Source the shared environment so we pick up a previously-installed nvm Node
# automatically. This is a no-op on fresh machines.
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib-env.sh"

# Exact versions pinned so the script is reproducible even if upstream shifts.
REQUIRED_NODE_VERSION="22.19.0"
NVM_VERSION="0.40.1"

SKIP_BUILD=0
ASSUME_YES=0
NO_NODE=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --no-node)    NO_NODE=1 ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then
  GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
else
  GREEN=""; YELLOW=""; RED=""; BOLD=""; RESET=""
fi
say()  { echo "${BOLD}==>${RESET} $*"; }
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; }
err()  { echo "  ${RED}✗${RESET} $*"; }

version_ge() {
  [ "$(printf '%s\n%s' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

confirm() {
  # confirm "prompt" — returns 0 if yes. Auto-yes with --yes.
  local prompt="$1"
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  if [ ! -t 0 ]; then
    # Non-interactive stdin without --yes: default to no and tell the user.
    echo "  (non-interactive: pass --yes to accept)"
    return 1
  fi
  local reply
  read -r -p "  $prompt [y/N] " reply
  case "${reply,,}" in y|yes) return 0 ;; *) return 1 ;; esac
}

# ---- Node.js auto-install via nvm (no root) ---------------------------------
# Installs nvm under $HOME/.nvm (no sudo) and Node $REQUIRED_NODE_VERSION
# inside it. Also writes the nvm sourcing snippet to the user's shell rc so
# that `node` is on PATH in every new shell — not just the one running the
# script. This is the "global for your user" behaviour users typically want.
install_node_locally() {
  say "Installing Node.js $REQUIRED_NODE_VERSION via nvm (user-local, no sudo)"
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  export NVM_DIR="$nvm_dir"

  if [ ! -s "$nvm_dir/nvm.sh" ]; then
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
      err "Need curl or wget to download nvm. Install one of them first."
      exit 1
    fi
    # Let the nvm installer write to the user's rc files so `node` is on PATH
    # in every new shell; we also double-check the write below.
    if command -v curl >/dev/null 2>&1; then
      curl -sSfL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash
    else
      wget -qO- "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash
    fi
  fi

  # Load nvm into the current shell.
  # shellcheck disable=SC1090
  . "$nvm_dir/nvm.sh"

  nvm install "$REQUIRED_NODE_VERSION" || { err "nvm install $REQUIRED_NODE_VERSION failed"; exit 1; }
  nvm use "$REQUIRED_NODE_VERSION"
  nvm alias default "$REQUIRED_NODE_VERSION" >/dev/null 2>&1 || true

  # Belt-and-suspenders: ensure the nvm source block is in whichever shell rc
  # the user will actually open next. The nvm installer only writes to one rc
  # file; this fills in the others it missed (e.g. on Ubuntu it may write to
  # ~/.bashrc but the user logs in with zsh, or vice-versa).
  ensure_rc_hook

  NODE_INSTALLED_LOCALLY=1
  ok "Node.js $(node --version) installed at $nvm_dir/versions/node/v$REQUIRED_NODE_VERSION"
}

# Append the nvm sourcing block to one or more shell rc files if it isn't
# already there. Idempotent — safe to call repeatedly.
ensure_rc_hook() {
  # The `nvm use default` call shadows any system-installed Node (e.g. the
  # distro's v18) with the version installed by this script. It adds a small
  # shell-startup cost (~100 ms on first invocation, cached thereafter), but
  # without it a fresh terminal on Ubuntu would keep resolving /usr/bin/node
  # and the benchmark scripts would hit the \"too old\" check.
  local hook="# >>> paraweb/nvm >>>
export NVM_DIR=\"\$HOME/.nvm\"
[ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
[ -s \"\$NVM_DIR/bash_completion\" ] && . \"\$NVM_DIR/bash_completion\"
command -v nvm >/dev/null 2>&1 && nvm use default >/dev/null 2>&1
# <<< paraweb/nvm <<<"
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    if ! grep -q "paraweb/nvm" "$rc" 2>/dev/null; then
      printf "\n%s\n" "$hook" >> "$rc"
      ok "Added nvm sourcing to $rc"
    elif ! grep -q "nvm use default" "$rc" 2>/dev/null; then
      # Upgrade an older block that only sourced nvm but didn't activate the
      # default version (older ParaWeb installs left this state). Rewrite the
      # marked region in place.
      local tmp; tmp="$(mktemp)"
      awk -v hook="$hook" '
        /# >>> paraweb\/nvm >>>/ { print hook; skip=1; next }
        /# <<< paraweb\/nvm <<</ { skip=0; next }
        !skip { print }
      ' "$rc" > "$tmp" && mv "$tmp" "$rc"
      ok "Upgraded nvm block in $rc (now activates default Node automatically)"
    fi
  done
  # If the user's primary shell is bash or zsh and has no rc at all, create
  # one so Node is found on next login.
  local primary="$(basename "${SHELL:-/bin/bash}")"
  case "$primary" in
    bash)
      if [ ! -f "$HOME/.bashrc" ]; then
        printf "%s\n" "$hook" > "$HOME/.bashrc"
        ok "Created $HOME/.bashrc with nvm sourcing"
      fi ;;
    zsh)
      if [ ! -f "$HOME/.zshrc" ]; then
        printf "%s\n" "$hook" > "$HOME/.zshrc"
        ok "Created $HOME/.zshrc with nvm sourcing"
      fi ;;
  esac
}

# ---- preflight ---------------------------------------------------------------
NODE_INSTALLED_LOCALLY=0
say "Preflight"

NEED_NODE_INSTALL=0
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js not found on PATH"
  NEED_NODE_INSTALL=1
else
  NODE_VERSION="$(node --version | tr -d v)"
  if version_ge "$NODE_VERSION" "22.0.0"; then
    ok "Node.js v$NODE_VERSION (required: >= 22)"
  else
    warn "Node.js v$NODE_VERSION is older than 22"
    NEED_NODE_INSTALL=1
  fi
fi

if [ "$NEED_NODE_INSTALL" -eq 1 ]; then
  if [ "$NO_NODE" -eq 1 ]; then
    err "Node.js is required but --no-node was passed. Install Node.js >= 22 (e.g. via nvm) and rerun."
    exit 1
  fi
  echo
  echo "  This script can install Node.js $REQUIRED_NODE_VERSION for you using nvm,"
  echo "  which installs entirely under \$HOME (no sudo, no system changes)."
  if confirm "Install Node.js locally via nvm now?"; then
    install_node_locally
  else
    err "Node.js is required to continue. Install it manually and rerun, or rerun with --yes."
    exit 1
  fi
fi

if ! command -v npm >/dev/null 2>&1; then
  err "npm not found. It usually ships with Node.js; your Node install may be broken."
  exit 1
fi
ok "npm $(npm --version)"

UNAME_S="$(uname -s)"

# ---- Linux GPU stack (requires root on the target system) --------------------
if [ "$UNAME_S" = "Linux" ]; then
  say "Linux GPU stack (system packages — require root)"

  MISSING_PKGS=()
  if ! command -v vulkaninfo >/dev/null 2>&1; then MISSING_PKGS+=("vulkan-tools"); fi
  if ! ldconfig -p 2>/dev/null | grep -q libvulkan.so; then MISSING_PKGS+=("libvulkan1"); fi

  if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
    warn "Missing Vulkan packages: ${MISSING_PKGS[*]}"
    APT_CMD="sudo apt-get update && sudo apt-get install -y ${MISSING_PKGS[*]}"
    echo "    To install them (needs sudo):"
    echo "      ${BOLD}$APT_CMD${RESET}"
    warn "Without root access on this machine, you can only run CPU benchmarks;"
    warn "Node GPU and browser GPU benchmarks require the Vulkan loader."
  else
    ok "Vulkan loader and tools present"
  fi

  if command -v nvidia-smi >/dev/null 2>&1; then
    DRIVER="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1)"
    ok "NVIDIA driver $DRIVER"
    if ! version_ge "$DRIVER" "525.0.0"; then
      warn "NVIDIA driver $DRIVER is older than 525; Dawn/WebGPU may misbehave"
    fi
  else
    warn "nvidia-smi not found. If this machine has an NVIDIA GPU, install the driver (needs root):"
    echo "      ${BOLD}sudo apt-get install -y nvidia-driver-535${RESET}"
  fi
fi

# ---- macOS note --------------------------------------------------------------
if [ "$UNAME_S" = "Darwin" ]; then
  say "macOS"
  ok "GPU access via Apple Metal is built into the OS; no driver setup needed."
fi

# ---- npm dependencies --------------------------------------------------------
say "npm install"
npm install --no-audit --no-fund || { err "npm install failed"; exit 1; }
ok "dependencies installed"

# ---- build -------------------------------------------------------------------
if [ "$SKIP_BUILD" -eq 0 ]; then
  say "TypeScript build"
  npm run build || { err "tsc build failed"; exit 1; }
  ok "dist/ ready"

  say "Rebuilding browser GPU bundle"
  if [ -f "browser-bench/entry.js" ]; then
    npx esbuild browser-bench/entry.js \
      --bundle \
      --outfile=browser-bench/gpu-bundle.js \
      --platform=browser \
      --external:webgpu \
      --external:worker_threads \
      --log-level=warning || { err "esbuild bundle failed"; exit 1; }
    ok "browser-bench/gpu-bundle.js rebuilt"
  else
    err "browser-bench/entry.js is missing — cannot rebuild gpu-bundle.js"
    echo "    Likely cause: you cloned the repo before .gitignore was fixed, so the"
    echo "    hand-written JS files under browser-bench/ and browser-demo/ were"
    echo "    excluded. Pull the latest revision of .gitignore and the committed"
    echo "    browser JS files, then rerun this script. In the interim, the Node"
    echo "    CPU and Node GPU benchmarks still work — only the browser"
    echo "    benchmarks need gpu-bundle.js."
    exit 1
  fi
fi

# ---- puppeteer Chromium warmup ----------------------------------------------
if [ -d "node_modules/puppeteer" ]; then
  say "Puppeteer Chromium"
  CHROMIUM_FOUND=0
  for d in "$HOME/.cache/puppeteer/chrome" "$HOME/.cache/puppeteer/chrome-headless-shell" "node_modules/puppeteer/.local-chromium"; do
    if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then CHROMIUM_FOUND=1; break; fi
  done
  if [ "$CHROMIUM_FOUND" -eq 1 ]; then
    ok "Chromium cache present"
  else
    warn "Chromium not yet downloaded; it will fetch on the first browser-bench run."
    warn "To prefetch it now:  node -e \"require('puppeteer').launch().then(b => b.close())\""
  fi
fi

# ---- done --------------------------------------------------------------------
echo
if [ "$NODE_INSTALLED_LOCALLY" -eq 1 ]; then
  echo "${YELLOW}Node was installed under \$HOME/.nvm.${RESET} It is already active in this shell."
  echo "For new shells, the nvm sourcing block was written to your shell rc (~/.bashrc and/or"
  echo "~/.zshrc / ~/.profile). If you open a fresh terminal right now Node will be on PATH."
  echo "If a future shell still can't find node, run:  ${BOLD}source ~/.bashrc${RESET}  (or ~/.zshrc)"
  echo
fi
echo "${GREEN}${BOLD}Install complete.${RESET} Next: ${BOLD}./scripts/check-deps.sh${RESET} to verify, then:"
echo "   • Node CPU:     ${BOLD}npm run test:shared:benchmark${RESET}"
echo "   • Node GPU:     ${BOLD}npm run test:gpu:benchmark${RESET}     (needs GPU stack)"
echo "   • Browser CPU:  ${BOLD}node browser-bench/full.js${RESET}"
echo "   • Browser GPU:  ${BOLD}node browser-bench/gpu-full.js${RESET} (needs GPU stack)"
echo "See README-BENCH.md for details and platform-specific notes."
