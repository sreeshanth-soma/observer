#!/usr/bin/env bash
#
# OpenBroadcaster Observer — k6 Load Test Runner
#
# Usage:
#   ./run.sh [10|50|100|1000] [--baseline-save] [--baseline-compare]
#
# Examples:
#   ./run.sh 10                         # smoke test with 10 VUs
#   ./run.sh 100 --baseline-save        # run at 100 VUs and save results as baseline
#   ./run.sh 100 --baseline-compare     # run at 100 VUs and compare against saved baseline
#   ./run.sh 1000                       # stress test with 1000 VUs
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

# Handle --help before anything else.
case "${1:-}" in
    -h|--help)
        echo "Usage: ./run.sh [10|50|100|1000] [--baseline-save] [--baseline-compare]"
        echo ""
        echo "Levels:"
        echo "  10     Smoke test (10 VUs/scenario pattern, 30s)"
        echo "  50     Moderate load (50-level pattern, 60s)"
        echo "  100    Medium load (100 VUs/scenario pattern, 60s)"
        echo "  1000   Stress test (1000 VUs/scenario pattern, 120s)"
        echo ""
        echo "Options:"
        echo "  --baseline-save      Save this run as the reference baseline"
        echo "  --baseline-compare   Compare this run against the saved baseline"
        echo "  -h, --help           Show this help"
        exit 0
        ;;
esac

LOAD_LEVEL="${1:-10}"
BASELINE_SAVE=false
BASELINE_COMPARE=false

for arg in "$@"; do
    case "$arg" in
        --baseline-save)    BASELINE_SAVE=true ;;
        --baseline-compare) BASELINE_COMPARE=true ;;
        10|50|100|1000)     LOAD_LEVEL="$arg" ;;
    esac
done

if [[ ! "$LOAD_LEVEL" =~ ^(10|50|100|1000)$ ]]; then
    echo "Error: load level must be '10', '50', '100', or '1000' (got '$LOAD_LEVEL')"
    echo "  Run ./run.sh --help for usage."
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

# ── Server management (Nginx + PHP-FPM for parallel requests) ────────────────
# Extract port from OB_BASE_URL (default 8080)
OB_PORT=$(echo "$OB_BASE_URL" | grep -oE ':[0-9]+' | tail -1 | tr -d ':')
OB_PORT=${OB_PORT:-8080}

PHP_FPM_PID=""
NGINX_PID=""
STARTED_SERVERS=false

# Check if the server is already running and responding
if curl -sf --max-time 2 "$OB_BASE_URL/api.php" -d 'c=account&a=uid' >/dev/null 2>&1; then
    echo "  Server already running at $OB_BASE_URL"
else
    # Check if nginx and php-fpm are available
    if ! command -v nginx &>/dev/null; then
        echo "Error: nginx is not installed. Install with: brew install nginx"
        exit 1
    fi
    if ! command -v php-fpm &>/dev/null && [ ! -x /opt/homebrew/sbin/php-fpm ]; then
        echo "Error: php-fpm is not available. It should come with: brew install php"
        exit 1
    fi

    PHP_FPM_BIN=$(command -v php-fpm 2>/dev/null || echo /opt/homebrew/sbin/php-fpm)

    echo "  Starting Nginx + PHP-FPM (${OB_PORT}, 20 workers)..."

    # Kill any stale processes on our ports
    lsof -ti :"$OB_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti :9099 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1

    # Prepare nginx config with correct document root and port
    NGINX_CONF="/tmp/ob-k6-nginx.conf"
    sed -e "s|__OB_PUBLIC_ROOT__|${OB_ROOT}/public|g" \
        -e "s|listen 8080|listen ${OB_PORT}|g" \
        "$SCRIPT_DIR/server/nginx-observer.conf" > "$NGINX_CONF"

    # Prepare PHP-FPM config with current user (so it can access media_data/)
    FPM_CONF="/tmp/ob-k6-php-fpm.conf"
    sed -e "s|__USER__|$(whoami)|g" \
        -e "s|__GROUP__|$(id -gn)|g" \
        "$SCRIPT_DIR/server/php-fpm-observer.conf" > "$FPM_CONF"

    # Start PHP-FPM with our dedicated pool config
    "$PHP_FPM_BIN" \
        --fpm-config "$FPM_CONF" \
        --daemonize \
        2>/tmp/ob-k6-php-fpm-startup.log

    # Brief pause for FPM to initialize workers
    sleep 1

    # Verify PHP-FPM is listening
    if ! lsof -ti :9099 >/dev/null 2>&1; then
        echo "Error: PHP-FPM failed to start on port 9099."
        echo "  Check /tmp/ob-k6-php-fpm.log and /tmp/ob-k6-php-fpm-startup.log"
        exit 1
    fi
    echo "  PHP-FPM ready (20 workers on :9099)"

    # Start Nginx (daemon off, we background it ourselves)
    nginx -c "$NGINX_CONF" &>/tmp/ob-k6-nginx-startup.log &
    NGINX_PID=$!
    sleep 1

    # Verify Nginx is responding
    for i in {1..10}; do
        if curl -sf --max-time 2 "http://127.0.0.1:${OB_PORT}/api.php" -d 'c=account&a=uid' >/dev/null 2>&1; then
            echo "  Nginx ready (PID $NGINX_PID on :${OB_PORT})"
            STARTED_SERVERS=true
            break
        fi
        if [ $i -eq 10 ]; then
            echo "Error: Nginx failed to respond within 10 seconds."
            echo "  Check /tmp/ob-k6-nginx-error.log and /tmp/ob-k6-nginx-startup.log"
            kill "$NGINX_PID" 2>/dev/null
            # Stop PHP-FPM too
            kill $(lsof -ti :9099) 2>/dev/null || true
            exit 1
        fi
        sleep 1
    done
fi

# Cleanup function: stop Nginx + PHP-FPM if we started them
cleanup() {
    if [ "$STARTED_SERVERS" = true ]; then
        echo ""
        echo "  Stopping Nginx + PHP-FPM..."
        # Stop nginx gracefully
        [ -n "$NGINX_PID" ] && kill "$NGINX_PID" 2>/dev/null && wait "$NGINX_PID" 2>/dev/null
        # Stop PHP-FPM (all workers on port 9099)
        lsof -ti :9099 2>/dev/null | xargs kill 2>/dev/null || true
        echo "  Servers stopped."
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
    -e "GIT_COMMIT=$(git -C "$OB_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
)

# ── Run k6 ───────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Observer k6 Load Test                                      ║"
echo "║  VUs: ${LOAD_LEVEL}                                                 ║"
echo "║  Target: ${OB_BASE_URL}                                     "
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

REPORT_HTML="outputs/report-${TIMESTAMP}-${LOAD_LEVEL}vus.html"

K6_EXIT=0
K6_WEB_DASHBOARD=true \
K6_WEB_DASHBOARD_EXPORT="$REPORT_HTML" \
k6 run \
    "${K6_ENV_FLAGS[@]}" \
    main.js || K6_EXIT=$?

if [ "$K6_EXIT" -eq 99 ]; then
    echo ""
    echo "  ⚠  Thresholds crossed (exit 99) — review the results above."
    echo "     At higher VU counts, this indicates the server is under heavy load."
    echo "     Try increasing pm.max_children in server/php-fpm-observer.conf."
elif [ "$K6_EXIT" -ne 0 ]; then
    echo ""
    echo "  ✗  k6 failed with exit code $K6_EXIT"
    exit "$K6_EXIT"
fi

echo ""
echo "  HTML report saved to: ${REPORT_HTML}"

# ── Post-run: clean up test-generated files on disk ─────────────────────────
# k6's teardown deletes DB records (playlists, timeslots, media) but can't
# remove files from disk. Upload scenarios leave behind files in media_data/.
# Clean up everything created after the test started.

UNAPPROVED_DIR="$OB_ROOT/media_data/unapproved"
UPLOADS_DIR="$OB_ROOT/media_data/uploads"

CLEANED=0
if [ -d "$UNAPPROVED_DIR" ]; then
    COUNT=$(find "$UNAPPROVED_DIR" -type f -newer "$SCRIPT_DIR/main.js" -name "*.mp3" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$COUNT" -gt 0 ]; then
        find "$UNAPPROVED_DIR" -type f -newer "$SCRIPT_DIR/main.js" -name "*.mp3" -delete 2>/dev/null
        # Remove empty directories left behind
        find "$UNAPPROVED_DIR" -type d -empty -delete 2>/dev/null
        CLEANED=$((CLEANED + COUNT))
    fi
fi

if [ -d "$UPLOADS_DIR" ]; then
    COUNT=$(find "$UPLOADS_DIR" -type f -newer "$SCRIPT_DIR/main.js" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$COUNT" -gt 0 ]; then
        find "$UPLOADS_DIR" -type f -newer "$SCRIPT_DIR/main.js" -delete 2>/dev/null
        CLEANED=$((CLEANED + COUNT))
    fi
fi

if [ "$CLEANED" -gt 0 ]; then
    echo "  Cleaned up $CLEANED test files from media_data/"
fi

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
