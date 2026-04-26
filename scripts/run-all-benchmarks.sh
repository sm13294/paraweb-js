#!/usr/bin/env bash
# Runs every benchmark used in the ParaWeb paper, sequentially, and collects
# per-suite logs under benchmark-results/run-<timestamp>/.
#
# Suites:
#   1. Node CPU MP       (npm run test:benchmark)
#   2. Node CPU Shared   (npm run test:shared:benchmark)
#   3. Node GPU          (npm run test:gpu:benchmark)
#   4. Browser CPU       (node browser-bench/full.js)
#   5. Browser GPU       (node browser-bench/gpu-full.js)
#
# Expect ~2–3 hours total on an M3 Max at 10M elements. If any suite fails the
# script continues with the next and reports a non-zero exit at the end.
#
# Usage:
#   bash scripts/run-all-benchmarks.sh              # all five suites
#   bash scripts/run-all-benchmarks.sh --skip-gpu   # skip GPU suites (no GPU stack)
#   bash scripts/run-all-benchmarks.sh --skip-browser # skip browser suites
#   bash scripts/run-all-benchmarks.sh --only "Node MP"  # single suite by name

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

# Source shared environment so nvm-installed Node is on PATH even when the
# script is launched from a minimal shell.
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib-env.sh"

SKIP_GPU=0
SKIP_BROWSER=0
VERBOSE=0
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --skip-gpu)     SKIP_GPU=1 ;;
    --skip-browser) SKIP_BROWSER=1 ;;
    --verbose|-v)   VERBOSE=1 ;;
    --only)         shift; ONLY="${1:-}" ;;
    --only=*)       ONLY="${arg#--only=}" ;;
    -h|--help)
      sed -n '1,25p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Clean, grep-able output by default. Pass --verbose to keep the pretty
# per-pattern banners, emojis, and trailing summary tables.
if [ "$VERBOSE" -eq 0 ]; then
  export PARAWEB_QUIET=1
fi

if [[ -t 1 ]]; then
  GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
else
  GREEN=""; YELLOW=""; RED=""; BOLD=""; RESET=""
fi

# Preflight so we fail fast if the machine isn't ready.
bash scripts/check-deps.sh >/dev/null 2>&1 || {
  echo "${RED}check-deps.sh reported failures.${RESET} Run it directly to see what's missing:"
  echo "  bash scripts/check-deps.sh"
  exit 1
}

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="benchmark-results/run-$TS"
mkdir -p "$LOG_DIR"
# Route every per-pattern JSON/CSV the benchmark runner writes into the same
# per-run directory as the logs. Without this, the JSON files scatter into
# benchmark-results/ at the project root and tangle with older runs.
export PARAWEB_RESULTS_DIR="$ROOT_DIR/$LOG_DIR"
echo "${BOLD}Logs + results → $LOG_DIR${RESET}"
echo

SUITES=(
  "Node MP|npm run test:mp:benchmark"
  "Node Shared|npm run test:shared:benchmark"
  "Node GPU|npm run test:gpu:benchmark"
  "Browser CPU|node browser-bench/full.js"
  "Browser GPU|node browser-bench/gpu-full.js"
)

FAILED=()
OVERALL_START=$(date +%s)

for entry in "${SUITES[@]}"; do
  name="${entry%%|*}"
  cmd="${entry#*|}"

  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then continue; fi
  if [ "$SKIP_GPU" -eq 1 ] && [[ "$name" == *"GPU"* ]]; then
    echo "${YELLOW}Skipping $name (--skip-gpu)${RESET}"; continue
  fi
  if [ "$SKIP_BROWSER" -eq 1 ] && [[ "$name" == "Browser"* ]]; then
    echo "${YELLOW}Skipping $name (--skip-browser)${RESET}"; continue
  fi

  slug="$(echo "$name" | tr '[:upper:] ' '[:lower:]-')"
  log="$LOG_DIR/$slug.log"
  echo "${BOLD}==> $name${RESET}   ($cmd)"
  echo "    log: $log"
  start=$(date +%s)

  if bash -c "$cmd" > "$log" 2>&1; then
    end=$(date +%s)
    echo "    ${GREEN}✓ ok${RESET}  ($((end - start)) s)"
  else
    rc=$?
    end=$(date +%s)
    echo "    ${RED}✗ failed${RESET} (exit $rc, $((end - start)) s) — tail of log:"
    tail -20 "$log" | sed 's/^/      /'
    FAILED+=("$name")
  fi
  echo
done

OVERALL_END=$(date +%s)
OVERALL_SEC=$((OVERALL_END - OVERALL_START))
printf "Total wall time: %02d:%02d:%02d\n\n" $((OVERALL_SEC/3600)) $(((OVERALL_SEC%3600)/60)) $((OVERALL_SEC%60))

if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "${GREEN}${BOLD}All suites completed.${RESET}"
  echo "Summaries:"
  for log in "$LOG_DIR"/*.log; do
    echo "  ${BOLD}$(basename "$log" .log)${RESET}"
    grep -E "Speedups relative|Extremely Large|BENCHMARK:" "$log" | head -15 | sed 's/^/    /'
    echo
  done
  exit 0
else
  echo "${RED}${BOLD}Suites failed:${RESET} ${FAILED[*]}"
  echo "See logs under $LOG_DIR/"
  exit 1
fi
