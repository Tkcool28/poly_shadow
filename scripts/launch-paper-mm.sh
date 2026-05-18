#!/bin/bash
# Launch Paper MM instances for sports matches
# Each match runs as a separate background process with output logged to file
#
# Usage:
#   ./scripts/launch-paper-mm.sh                                  # Launch default matches
#   ./scripts/launch-paper-mm.sh epl-mun-ast-2026-03-15           # Launch specific EPL match
#   ./scripts/launch-paper-mm.sh nba-gsw-nyk-2026-03-15           # Launch specific NBA game
#   ./scripts/launch-paper-mm.sh nba-gsw-nyk-2026-03-15 nba-dal-cle-2026-03-15  # Multiple games

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs/paper-mm"
DATE=$(date -u +%Y-%m-%d)

# Create log directory
mkdir -p "$LOG_DIR"

# Default matches (today's EPL)
MATCHES=(
  "epl-mun-ast-2026-03-15"
  "epl-cry-lee-2026-03-15"
  "epl-not-ful-2026-03-15"
  "epl-liv-tot-2026-03-15"
)

# Override with CLI arg if provided
if [ $# -gt 0 ]; then
  MATCHES=("$@")
fi

# Auto-detect required ESPN leagues from match slugs
# Slug prefix → ESPN league code mapping
detect_leagues() {
  local leagues="eng.1"  # always include EPL
  for m in "${MATCHES[@]}"; do
    case "$m" in
      lal-*) leagues="$leagues,esp.1" ;;         # La Liga
      ucl-*) leagues="$leagues,uefa.champions" ;; # Champions League
      sea-*) leagues="$leagues,ita.1" ;;          # Serie A
      fl1-*) leagues="$leagues,fra.1" ;;          # Ligue 1 (slug prefix: fl1-)
      bun-*) leagues="$leagues,ger.1" ;;          # Bundesliga (slug prefix: bun-)
      uel-*) leagues="$leagues,uefa.europa" ;;    # Europa League
    esac
  done
  # Deduplicate
  echo "$leagues" | tr ',' '\n' | sort -u | tr '\n' ',' | sed 's/,$//'
}

# Set ESPN leagues env var based on matches
export SCALP_SOCCER_LEAGUES=$(detect_leagues)

# Faster ESPN polling during paper test (default 15s → 5s for faster goal detection)
export SCALP_SOCCER_POLL_INTERVAL_MS=5000

# MM Parameters
SPREAD="0.04"
SIZE="10"
MAX_INVENTORY="50"
STATS_INTERVAL="60"
WARM_UP="10"
MAX_STDDEV="0.03"
QUEUE_DEPTH="100"       # Historical backtest shows queue>=100 needed for realistic fills
MAX_RUNTIME="150"       # Auto-shutdown after 2.5 hours
MAX_LOSS="-20"          # Hard stop on $20 loss
MAX_INV_SHARES="200"    # Hard cap on shares
MAX_INV_USD="100"       # Hard cap on USD exposure

echo "=== Paper MM Launcher ==="
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Matches: ${#MATCHES[@]}"
echo "Config: spread=$SPREAD size=\$$SIZE maxInventory=\$$MAX_INVENTORY warmUp=${WARM_UP}s maxStdDev=$MAX_STDDEV queue=\$$QUEUE_DEPTH maxRuntime=${MAX_RUNTIME}m"
echo "ESPN leagues: $SCALP_SOCCER_LEAGUES"
echo ""

PIDS=""

for MATCH in "${MATCHES[@]}"; do
  LOGFILE="$LOG_DIR/${MATCH}-${DATE}.log"

  echo "Launching: $MATCH -> $LOGFILE"

  cd "$PROJECT_DIR"
  npx tsx src/scripts/scalp-mm-paper.ts \
    --match="$MATCH" \
    --spread="$SPREAD" \
    --size="$SIZE" \
    --max-inventory="$MAX_INVENTORY" \
    --stats-interval="$STATS_INTERVAL" \
    --warm-up="$WARM_UP" \
    --max-stddev="$MAX_STDDEV" \
    --queue-depth="$QUEUE_DEPTH" \
    --max-runtime="$MAX_RUNTIME" \
    --max-loss="$MAX_LOSS" \
    --max-inv-shares="$MAX_INV_SHARES" \
    --max-inv-usd="$MAX_INV_USD" \
    2>&1 | tee "$LOGFILE" &

  PID=$!
  PIDS="$PIDS $PID"
  echo "  PID: $PID"

  # Small delay between launches to avoid API rate limits
  sleep 1
done

echo ""
echo "All ${#MATCHES[@]} instances launched."
echo "PIDs:$PIDS"
echo ""
echo "Monitor: tail -f $LOG_DIR/*-${DATE}.log"
echo "Stop all: kill$PIDS"
echo ""

# Write PID file for easy cleanup
echo "$PIDS" > "$LOG_DIR/pids-${DATE}.txt"
echo "PIDs saved to $LOG_DIR/pids-${DATE}.txt"

# Wait for all processes
wait
