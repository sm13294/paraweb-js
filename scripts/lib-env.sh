#!/usr/bin/env bash
# Shared environment setup for ParaWeb scripts. Source this at the top of any
# script that needs `node` / `npm` / `npx` to be on PATH:
#
#   # shellcheck disable=SC1091
#   . "$(dirname "${BASH_SOURCE[0]}")/lib-env.sh"
#
# Behaviour, in order:
#   1. If nvm is installed under $HOME/.nvm (or $NVM_DIR), source it and
#      activate the default Node — this shadows any system-installed Node
#      (e.g. /usr/bin/node v18 shipped by the distro). Users who run
#      install-deps.sh expect *that* Node version to be used, regardless of
#      what else is on PATH.
#   2. Homebrew PATHs that some IDE-launched subshells drop.
#
# To opt out (i.e. keep the system Node even when nvm is installed), export
#   PARAWEB_USE_SYSTEM_NODE=1
# before sourcing.

__paraweb_nvm_dir="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$__paraweb_nvm_dir/nvm.sh" ] && [ "${PARAWEB_USE_SYSTEM_NODE:-0}" != "1" ]; then
  export NVM_DIR="$__paraweb_nvm_dir"
  # shellcheck disable=SC1091
  . "$__paraweb_nvm_dir/nvm.sh" >/dev/null 2>&1 || true
  if command -v nvm >/dev/null 2>&1; then
    # Activate the version installed by scripts/install-deps.sh. This prepends
    # nvm's node bin to PATH, shadowing any older system node.
    nvm use default >/dev/null 2>&1 \
      || nvm use node >/dev/null 2>&1 \
      || true
  fi
fi
unset __paraweb_nvm_dir

# Homebrew PATHs that some IDE-launched subshells drop.
case ":$PATH:" in
  *:/opt/homebrew/bin:*) ;;
  *) [ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH" ;;
esac
case ":$PATH:" in
  *:/usr/local/bin:*) ;;
  *) [ -d /usr/local/bin ] && export PATH="/usr/local/bin:$PATH" ;;
esac
