# Latency Optimization Monitoring Checklist

Run after deploying latency optimization batch. Use with `/loop 30m`.

## Quick Health Check (run via SSH)

### 1. WSS Provider Status
```bash
ssh $PROD_SSH_HOST "docker logs polymarket_trade_monitor --since 10m 2>&1 | grep 'heartbeat' | grep -oP 'chain-watcher-[ABC]' | sort | uniq -c"
```
Expected: 3 providers (A, B, C) all reporting heartbeats.

### 2. Per-Provider Event Delivery
```bash
ssh $PROD_SSH_HOST "docker logs polymarket_trade_monitor --since 10m 2>&1 | grep heartbeat | tail -6"
```
Check: `eventsReceived` incrementing for all 3 instances. `staleDisconnectCount` not rising fast.

### 3. Phantom Fill Tracking
```bash
ssh $PROD_SSH_HOST "docker logs polymarket_trade_monitor --since 1h 2>&1 | grep 'Phantom fill override' | tail -5"
```
Check: `phantomAgeMs` values. If all < 100ms, safe to reduce TAKER_DEBOUNCE_MS from 200 to 100.

### 4. Fill Latency (DB query)
```bash
ssh $PROD_SSH_HOST "docker exec polymarket_postgres psql -U polymarket -d polymarket_copytrade -c \"
SELECT COUNT(*) as fills,
  ROUND(AVG(q)) as avg_q, ROUND(MIN(q)) as min_q, ROUND(MAX(q)) as max_q,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY q)) as p50_q
FROM (SELECT (EXTRACT(EPOCH FROM ct.\\\"filledAt\\\")-EXTRACT(EPOCH FROM dt.\\\"detectedAt\\\"))*1000-ct.\\\"latencyMs\\\" as q
  FROM \\\"CopyTrade\\\" ct JOIN \\\"DetectedTrade\\\" dt ON ct.\\\"detectedTradeId\\\"=dt.id
  WHERE ct.status IN ('FILLED','SETTLED') AND ct.\\\"filledAt\\\" IS NOT NULL
  AND ct.\\\"isPaper\\\"=false AND dt.\\\"detectionSource\\\"='CHAIN_MAKER'
  AND ct.\\\"createdAt\\\" > NOW() - INTERVAL '1 hour') s;
\""
```

### 5. Detection Delay Distribution (last 1h)
```bash
ssh $PROD_SSH_HOST "docker exec polymarket_postgres psql -U polymarket -d polymarket_copytrade -c \"
SELECT CASE WHEN d<1 THEN '<1s' WHEN d<5 THEN '1-5s' WHEN d<10 THEN '5-10s' WHEN d<30 THEN '10-30s' ELSE '>30s' END as bucket, COUNT(*)
FROM (SELECT EXTRACT(EPOCH FROM dt.\\\"detectedAt\\\")-dt.timestamp as d FROM \\\"DetectedTrade\\\" dt
WHERE dt.\\\"detectedAt\\\">NOW()-INTERVAL '1 hour' AND dt.\\\"detectionSource\\\" IN ('CHAIN','CHAIN_MAKER')) s
GROUP BY bucket ORDER BY MIN(d);
\""
```
Expected after triple-WSS: >99% in <5s bucket, near-zero >10s.

### 6. Pre-filter Effectiveness
```bash
ssh $PROD_SSH_HOST "docker exec polymarket_postgres psql -U polymarket -d polymarket_copytrade -c \"
SELECT ct.side, CASE WHEN ct.\\\"failReason\\\" LIKE 'CHAIN_MAKER pre-filtered%' THEN 'batch-skipped' ELSE 'normal' END as p, COUNT(*)
FROM \\\"CopyTrade\\\" ct JOIN \\\"DetectedTrade\\\" dt ON ct.\\\"detectedTradeId\\\"=dt.id
WHERE dt.\\\"detectionSource\\\"='CHAIN_MAKER' AND ct.\\\"createdAt\\\">NOW()-INTERVAL '1 hour' AND ct.\\\"isPaper\\\"=false
GROUP BY ct.side,p ORDER BY ct.side,p;
\""
```

### 7. Coalescing Gate Check
```bash
ssh $PROD_SSH_HOST "docker logs polymarket_copy_trader --since 30m 2>&1 | grep 'COPY TRADE EXECUTED \[LIVE\]' | sed 's/.*queueMs\":/q:/' | sed 's/,.*//' | sort -t: -k2 -n | tail -5"
```
Expected: all queueMs < 50ms. If any > 7000ms, coalescing gate fix may not be deployed.

## What to Watch For
- **Any instance not reporting heartbeats** -> provider down, check logs for reconnect errors
- **`staleDisconnectCount` rising** -> WSS provider unreliable
- **`phantomAgeMs` consistently < 50ms** -> safe to reduce TAKER_DEBOUNCE_MS to 100ms
- **Detection delay >10s increasing** -> WSS delivery degradation
- **queueMs > 100ms** -> drain pipeline regression
