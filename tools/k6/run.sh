#!/usr/bin/env bash
#
# OpenBroadcaster Observer — k6 Load Test Runner
#
# Usage:
#   ./run.sh [low|medium|high] [--baseline-save] [--baseline-compare]
#
# Examples:
#   ./run.sh low                       # smoke test with ~15 VUs
#   ./run.sh medium --baseline-save    # run at ~150 VUs and save results as baseline
#   ./run.sh medium --baseline-compare # run at ~150 VUs and compare against saved baseline
#   ./run.sh high                      # stress test with ~1100 VUs
#
# Prerequisites:
#   - k6 installed (https://k6.io/docs/get-started/installation/)
#   - jq installed (for --baseline-compare)
#   - config.env file (copy from config.example.env)
#   - PHP 8.x (if using built-in dev server)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Observer repo root (two directories up from tools/k6)
OB_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Load config ──────────────────────────────────────────────────────────────

if [ ! -f config.env ]; then
    echo "Error: config.env not found."
    echo "  cp config.example.env config.env"
    echo "  Then fill in your Observer URL and credentials."
    exit 1
fi

set -a
source config.env
set +a

# ── Parse arguments ──────────────────────────────────────────────────────────

LOAD_LEVEL="${1:-low}"
BASELINE_SAVE=false
BASELINE_COMPARE=false

for arg in "$@"; do
    case "$arg" in
        --baseline-save)    BASELINE_SAVE=true ;;
        --baseline-compare) BASELINE_COMPARE=true ;;
        low|medium|high)    LOAD_LEVEL="$arg" ;;
    esac
done

if [[ ! "$LOAD_LEVEL" =~ ^(low|medium|high)$ ]]; then
    echo "Error: load level must be 'low', 'medium', or 'high' (got '$LOAD_LEVEL')"
    exit 1
fi

# ── Check prerequisites ─────────────────────────────────────────────────────

if ! command -v k6 &>/dev/null; then
    echo "Error: k6 is not installed."
    echo "  Install: https://k6.io/docs/get-started/installation/"
    exit 1
fi

if [ "$BASELINE_COMPARE" = true ] && ! command -v jq &>/dev/null; then
    echo "Error: jq is required for baseline comparison."
    echo "  Install: brew install jq  (macOS) or apt install jq  (Linux)"
    exit 1
fi

# ── Prepare output directories ──────────────────────────────────────────────

mkdir -p outputs baselines

TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# ── PHP dev server management ───────────────────────────────────────────────
# Extract port from OB_BASE_URL (default 8000)
OB_PORT=$(echo "$OB_BASE_URL" | grep -oE ':[0-9]+' | tail -1 | tr -d ':')
OB_PORT=${OB_PORT:-8000}

PHP_PID=""

# Check if the server is already running and responding
if curl -sf --max-time 2 "$OB_BASE_URL/api.php" -d 'c=account&a=uid' >/dev/null 2>&1; then
    echo "  Server already running at $OB_BASE_URL"
else
    echo "  Starting PHP dev server on 0.0.0.0:${OB_PORT}..."

    # Kill any stale PHP servers on this port
    lsof -ti :"$OB_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1

    # Start PHP built-in server. Key details:
    #   - Bind to 0.0.0.0 (not localhost) to ensure IPv4 works
    #   - Redirect all output to log file to prevent tty suspension
    #   - Run from Observer root so relative paths (routes.json) work
    php -S "0.0.0.0:${OB_PORT}" -t "$OB_ROOT/public" \
        > /tmp/ob_php_server.log 2>&1 &
    PHP_PID=$!

    # Wait for server to be ready
    for i in {1..10}; do
        if curl -sf --max-time 2 "http://127.0.0.1:${OB_PORT}/api.php" -d 'c=account&a=uid' >/dev/null 2>&1; then
            echo "  Server ready (PID $PHP_PID)"
            break
        fi
        if [ $i -eq 10 ]; then
            echo "Error: PHP server failed to start within 10 seconds."
            echo "  Check /tmp/ob_php_server.log for errors."
            [ -n "$PHP_PID" ] && kill "$PHP_PID" 2>/dev/null
            exit 1
        fi
        sleep 1
    done
fi

# Cleanup function: stop the PHP server if we started it
cleanup() {
    if [ -n "$PHP_PID" ]; then
        kill "$PHP_PID" 2>/dev/null || true
        wait "$PHP_PID" 2>/dev/null || true
        echo "  PHP server stopped."
    fi
}
trap cleanup EXIT

# ── Build k6 environment flags ──────────────────────────────────────────────

K6_ENV_FLAGS=(
    -e "OB_BASE_URL=${OB_BASE_URL}"
    -e "OB_USERNAME=${OB_USERNAME}"
    -e "OB_PASSWORD=${OB_PASSWORD}"
    -e "OB_PLAYER_ID=${OB_PLAYER_ID}"
    -e "OB_PLAYER_PASSWORD=${OB_PLAYER_PASSWORD}"
    -e "OB_TEST_MEDIA_ID=${OB_TEST_MEDIA_ID:-}"
    -e "OB_TEST_USER_ID=${OB_TEST_USER_ID:-1}"
    -e "K6_LOAD_LEVEL=${LOAD_LEVEL}"
)

# ── Run k6 ───────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Observer k6 Load Test                                      ║"
echo "║  Level: ${LOAD_LEVEL}                                              ║"
echo "║  Target: ${OB_BASE_URL}                                     "
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

K6_WEB_DASHBOARD=true k6 run \
    "${K6_ENV_FLAGS[@]}" \
    main.js

# ── Post-run: baseline management ───────────────────────────────────────────

if [ "$BASELINE_SAVE" = true ]; then
    if [ -f outputs/latest.json ]; then
        cp outputs/latest.json "baselines/baseline-${TIMESTAMP}.json"
        cp outputs/latest.json baselines/current.json
        echo ""
        echo "Baseline saved to baselines/current.json (and baselines/baseline-${TIMESTAMP}.json)"
    else
        echo "Warning: outputs/latest.json not found — baseline not saved."
    fi
fi

if [ "$BASELINE_COMPARE" = true ]; then
    if [ ! -f baselines/current.json ]; then
        echo ""
        echo "Error: No baseline found. Run with --baseline-save first."
        exit 1
    fi
    if [ ! -f outputs/latest.json ]; then
        echo ""
        echo "Error: outputs/latest.json not found — cannot compare."
        exit 1
    fi
    echo ""
    bash baseline/compare.sh baselines/current.json outputs/latest.json
fi
