#!/bin/bash
# =============================================================================
# Polymarket Copy Trade — Health Check Script
# =============================================================================
# Run via host cron: */5 * * * * ~/polymarket-copytrade/.server/scripts/health-check.sh
#
# Checks:
#   1. Core worker containers are running (auto-restarts if not)
#   2. PostgreSQL healthcheck status
#   3. SystemHealth table heartbeat staleness
#   4. Disk and memory usage

set -euo pipefail

COMPOSE_DIR="$HOME/polymarket-copytrade"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.ghcr.yml"
LOGFILE="$COMPOSE_DIR/health-check.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
FAILED=0

# Rotate log if >10MB
if [ -f "$LOGFILE" ] && [ "$(stat -c%s "$LOGFILE" 2>/dev/null || stat -f%z "$LOGFILE" 2>/dev/null || echo 0)" -gt 10485760 ]; then
  mv "$LOGFILE" "${LOGFILE}.old"
fi

log() { echo "[$TIMESTAMP] $1" >> "$LOGFILE"; }

# ─── Check compose file exists ───
if [ ! -f "$COMPOSE_FILE" ]; then
  log "ERROR: Compose file not found at $COMPOSE_FILE"
  exit 1
fi

cd "$COMPOSE_DIR"

# ─── Container health ───
CORE_WORKERS="trade-monitor history-backfiller leaderboard-scanner score-calculator"

for worker in $CORE_WORKERS; do
  STATUS=$(docker compose -f "$COMPOSE_FILE" ps --format json "$worker" 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('State','unknown'))" 2>/dev/null || echo "missing")

  if [ "$STATUS" != "running" ]; then
    log "WARN: $worker is $STATUS — restarting"
    docker compose -f "$COMPOSE_FILE" restart "$worker" 2>/dev/null || log "ERROR: failed to restart $worker"
    FAILED=$((FAILED + 1))
  else
    log "OK: $worker running"
  fi
done

# ─── PostgreSQL health ───
PG_STATUS=$(docker compose -f "$COMPOSE_FILE" ps --format json polymarket_postgres 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Health','unknown'))" 2>/dev/null || echo "unknown")

if [ "$PG_STATUS" != "healthy" ]; then
  log "WARN: polymarket_postgres health=$PG_STATUS"
  FAILED=$((FAILED + 1))
else
  log "OK: polymarket_postgres healthy"
fi

# ─── SystemHealth heartbeat check (last 30 min) ───
STALE_JOBS=$(docker exec polymarket_postgres psql -U polymarket -d polymarket_copytrade -t -c \
  "SELECT \"jobName\" FROM \"SystemHealth\" WHERE \"lastRunAt\" < NOW() - INTERVAL '30 minutes';" 2>/dev/null | \
  tr -d ' ' | grep -v '^$' || true)

if [ -n "$STALE_JOBS" ]; then
  log "WARN: Stale SystemHealth heartbeat for: $STALE_JOBS"
fi

# ─── Disk usage ───
DISK_PCT=$(df / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [ "$DISK_PCT" -gt 85 ]; then
  log "WARN: Disk usage at ${DISK_PCT}%"
  FAILED=$((FAILED + 1))
fi

# ─── Memory usage ───
MEM_FREE_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $7}' || echo "0")
if [ "$MEM_FREE_MB" -lt 256 ] && [ "$MEM_FREE_MB" -gt 0 ]; then
  log "WARN: Low available memory: ${MEM_FREE_MB}MB"
  FAILED=$((FAILED + 1))
fi

# ─── Summary ───
if [ "$FAILED" -gt 0 ]; then
  log "SUMMARY: $FAILED issue(s) detected"
  exit 1
fi

log "SUMMARY: All checks passed"
