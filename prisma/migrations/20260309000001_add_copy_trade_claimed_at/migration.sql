-- AlterTable
ALTER TABLE "CopyTrade" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CopyTrade_status_settlementPrice_isPaper_idx" ON "CopyTrade"("status", "settlementPrice", "isPaper");
