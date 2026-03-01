-- CreateTable
CREATE TABLE "CopyTrade" (
    "id" TEXT NOT NULL,
    "detectedTradeId" TEXT NOT NULL,
    "orderId" TEXT,
    "tokenId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "requestedAmount" DOUBLE PRECISION NOT NULL,
    "requestedPrice" DOUBLE PRECISION NOT NULL,
    "filledPrice" DOUBLE PRECISION,
    "filledSize" DOUBLE PRECISION,
    "slippageBps" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "failReason" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filledAt" TIMESTAMP(3),

    CONSTRAINT "CopyTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CopyTrade_detectedTradeId_key" ON "CopyTrade"("detectedTradeId");

-- CreateIndex
CREATE INDEX "CopyTrade_status_idx" ON "CopyTrade"("status");

-- CreateIndex
CREATE INDEX "CopyTrade_createdAt_idx" ON "CopyTrade"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "CopyTrade_tokenId_idx" ON "CopyTrade"("tokenId");

-- AddForeignKey
ALTER TABLE "CopyTrade" ADD CONSTRAINT "CopyTrade_detectedTradeId_fkey" FOREIGN KEY ("detectedTradeId") REFERENCES "DetectedTrade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
