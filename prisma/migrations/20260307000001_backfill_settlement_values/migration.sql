-- Backfill settlementValue + settledAt for legacy SETTLED BUY trades
-- that were settled before these columns were added.
-- Guard: only run if column exists (safe for shadow DB)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CopyTrade' AND column_name = 'settlementValue'
  ) THEN
    UPDATE "CopyTrade"
    SET "settlementValue" = "filledSize" * "settlementPrice",
        "settledAt" = COALESCE("settledAt", "createdAt")
    WHERE status = 'SETTLED'
      AND side = 'BUY'
      AND "settlementValue" IS NULL
      AND "settlementPrice" IS NOT NULL
      AND "filledSize" IS NOT NULL;
  END IF;
END $$;
