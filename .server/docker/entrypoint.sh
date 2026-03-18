#!/bin/sh
set -e

# NODE_OPTIONS env var (e.g., --max-old-space-size=8192 for backfiller)
# is automatically picked up by Node.js — no explicit forwarding needed.
#
# exec ensures node is PID 1 → receives SIGTERM directly from Docker.
# Critical: shutdown.ts handles SIGTERM → prisma.$disconnect() → process.exit(0)
# Workers with custom handlers (trade-monitor, arb-worker, scalp-worker) also
# close WebSocket connections and feeds before disconnecting.

exec node --import tsx "$@"
