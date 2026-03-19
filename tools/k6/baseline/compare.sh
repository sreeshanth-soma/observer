#!/usr/bin/env bash
#
# Baseline Comparison Tool
#
# Compares two k6 result JSON files (produced by handleSummary in main.js)
# and outputs a table showing performance changes per scenario.
#
# Usage:
#   bash compare.sh <baseline.json> <current.json>
#
# Flags metrics that degraded by more than 10% with [WARN].

set -euo pipefail

if [ $# -ne 2 ]; then
    echo "Usage: $0 <baseline.json> <current.json>"
    exit 1
fi

BASELINE="$1"
CURRENT="$2"

if [ ! -f "$BASELINE" ]; then echo "Error: baseline file not found: $BASELINE"; exit 1; fi
if [ ! -f "$CURRENT" ];  then echo "Error: current file not found: $CURRENT";   exit 1; fi

if ! command -v jq &>/dev/null; then
    echo "Error: jq is required. Install: brew install jq (macOS) or apt install jq (Linux)"
    exit 1
fi

# ── Header ───────────────────────────────────────────────────────────────────

BASE_LEVEL=$(jq -r '.load_level // "unknown"' "$BASELINE")
CURR_LEVEL=$(jq -r '.load_level // "unknown"' "$CURRENT")
BASE_TIME=$(jq -r '.timestamp // "unknown"' "$BASELINE")
CURR_TIME=$(jq -r '.timestamp // "unknown"' "$CURRENT")

echo ""
echo "═══════════════════════════════════════════════════════════════════════════"
echo "  Baseline Comparison"
echo "  Baseline: ${BASE_TIME} (${BASE_LEVEL})"
echo "  Current:  ${CURR_TIME} (${CURR_LEVEL})"
echo "═══════════════════════════════════════════════════════════════════════════"
echo ""

if [ "$BASE_LEVEL" != "$CURR_LEVEL" ]; then
    echo "  WARNING: Load levels differ (${BASE_LEVEL} vs ${CURR_LEVEL}). Comparison may not be meaningful."
    echo ""
fi

# ── Table header ─────────────────────────────────────────────────────────────

printf "  %-25s  %-12s  %10s  %10s  %10s\n" "Scenario" "Metric" "Baseline" "Current" "Change"
printf "  %-25s  %-12s  %10s  %10s  %10s\n" "-------------------------" "------------" "----------" "----------" "----------"

# ── Compare each scenario ────────────────────────────────────────────────────

SCENARIOS=$(jq -r '.scenarios | keys[]' "$BASELINE" 2>/dev/null || echo "")

if [ -z "$SCENARIOS" ]; then
    echo "  No scenario data found in baseline."
    exit 0
fi

WARN_COUNT=0

compare_metric() {
    local scenario="$1"
    local metric_key="$2"
    local metric_label="$3"
    local unit="$4"

    local base_val
    local curr_val
    base_val=$(jq -r ".scenarios.\"${scenario}\".${metric_key} // \"null\"" "$BASELINE")
    curr_val=$(jq -r ".scenarios.\"${scenario}\".${metric_key} // \"null\"" "$CURRENT")

    if [ "$base_val" = "null" ] || [ "$curr_val" = "null" ]; then
        printf "  %-25s  %-12s  %10s  %10s  %10s\n" "$scenario" "$metric_label" "${base_val}" "${curr_val}" "n/a"
        return
    fi

    # Calculate percentage change.
    local change
    local flag=""
    change=$(echo "$base_val $curr_val" | awk '{
        if ($1 == 0) { printf "n/a"; exit }
        pct = (($2 - $1) / $1) * 100
        printf "%+.1f%%", pct
    }')

    # Flag degradations > 10% (higher is worse for latency/error metrics).
    local pct_num
    pct_num=$(echo "$base_val $curr_val" | awk '{
        if ($1 == 0) { print 0; exit }
        print (($2 - $1) / $1) * 100
    }')

    if echo "$pct_num" | awk '{ exit ($1 > 10) ? 0 : 1 }'; then
        flag=" [WARN]"
        WARN_COUNT=$((WARN_COUNT + 1))
    fi

    # Format values with unit.
    local base_fmt
    local curr_fmt
    base_fmt=$(printf "%.1f%s" "$base_val" "$unit")
    curr_fmt=$(printf "%.1f%s" "$curr_val" "$unit")

    printf "  %-25s  %-12s  %10s  %10s  %10s\n" "$scenario" "$metric_label" "$base_fmt" "$curr_fmt" "${change}${flag}"
}

for scenario in $SCENARIOS; do
    compare_metric "$scenario" "p95_ms"     "p95 (ms)"   "ms"
    compare_metric "$scenario" "avg_ms"     "avg (ms)"   "ms"
    compare_metric "$scenario" "error_rate" "error rate"  ""
    echo ""
done

# ── Global metrics ───────────────────────────────────────────────────────────

printf "  %-25s  %-12s  %10s  %10s  %10s\n" "--- GLOBAL ---" "" "" "" ""

for metric in p95_ms avg_ms error_rate; do
    label="$metric"
    unit=""
    case "$metric" in
        p95_ms)     label="p95 (ms)";    unit="ms" ;;
        avg_ms)     label="avg (ms)";    unit="ms" ;;
        error_rate) label="error rate";  unit="" ;;
    esac

    base_val=$(jq -r ".global.${metric} // \"null\"" "$BASELINE")
    curr_val=$(jq -r ".global.${metric} // \"null\"" "$CURRENT")

    if [ "$base_val" != "null" ] && [ "$curr_val" != "null" ]; then
        change=$(echo "$base_val $curr_val" | awk '{
            if ($1 == 0) { printf "n/a"; exit }
            pct = (($2 - $1) / $1) * 100
            printf "%+.1f%%", pct
        }')

        base_fmt=$(printf "%.1f%s" "$base_val" "$unit")
        curr_fmt=$(printf "%.1f%s" "$curr_val" "$unit")

        printf "  %-25s  %-12s  %10s  %10s  %10s\n" "global" "$label" "$base_fmt" "$curr_fmt" "$change"
    fi
done

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
if [ "$WARN_COUNT" -gt 0 ]; then
    echo "  ${WARN_COUNT} metric(s) degraded by more than 10%. Check [WARN] flags above."
else
    echo "  All metrics within acceptable range (no degradation > 10%)."
fi
echo ""
