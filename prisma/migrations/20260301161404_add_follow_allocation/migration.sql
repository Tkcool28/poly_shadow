-- AlterTable
ALTER TABLE "CopyTrade" ADD COLUMN     "followAllocationId" TEXT;

-- CreateTable
CREATE TABLE "FollowAllocation" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "initialCapital" DOUBLE PRECISION NOT NULL,
    "currentCapital" DOUBLE PRECISION NOT NULL,
    "deployedCapital" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "traderPortfolioValue" DOUBLE PRECISION,
    "portfolioValueAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FollowAllocation_proxyWallet_key" ON "FollowAllocation"("proxyWallet");

-- CreateIndex
CREATE INDEX "FollowAllocation_isActive_idx" ON "FollowAllocation"("isActive");

-- CreateIndex
CREATE INDEX "CopyTrade_followAllocationId_idx" ON "CopyTrade"("followAllocationId");

-- AddForeignKey
ALTER TABLE "FollowAllocation" ADD CONSTRAINT "FollowAllocation_proxyWallet_fkey" FOREIGN KEY ("proxyWallet") REFERENCES "Trader"("proxyWallet") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyTrade" ADD CONSTRAINT "CopyTrade_followAllocationId_fkey" FOREIGN KEY ("followAllocationId") REFERENCES "FollowAllocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
