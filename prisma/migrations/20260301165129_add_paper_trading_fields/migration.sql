-- AlterTable
ALTER TABLE "CopyTrade" ADD COLUMN     "estimatedFee" DOUBLE PRECISION,
ADD COLUMN     "isPaper" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "FollowAllocation" ADD COLUMN     "isPaper" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "CopyTrade_isPaper_idx" ON "CopyTrade"("isPaper");
