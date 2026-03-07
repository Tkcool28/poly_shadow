-- Backfill settlementValue + settledAt for legacy SETTLED BUY trades
-- that were settled before these columns were added.
UPDATE "CopyTrade"
SET "settlementValue" = "filledSize" * "settlementPrice",
    "settledAt" = COALESCE("settledAt", "createdAt")
WHERE status = 'SETTLED'
  AND side = 'BUY'
  AND "settlementValue" IS NULL
  AND "settlementPrice" IS NOT NULL
  AND "filledSize" IS NOT NULL;
