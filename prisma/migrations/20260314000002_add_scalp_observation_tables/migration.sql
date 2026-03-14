-- CreateTable
CREATE TABLE "ScalpTradeLog" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "slug" TEXT,
    "side" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "usdValue" DOUBLE PRECISION NOT NULL,
    "txHash" TEXT,
    "clobTimestamp" BIGINT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScalpTradeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScalpSignalLog" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "slug" TEXT,
    "game" TEXT,
    "signalType" TEXT NOT NULL,
    "buyVolumeUsd" DOUBLE PRECISION NOT NULL,
    "sellVolumeUsd" DOUBLE PRECISION NOT NULL,
    "netImbalance" DOUBLE PRECISION NOT NULL,
    "tradeCount" INTEGER NOT NULL,
    "avgBuyPrice" DOUBLE PRECISION NOT NULL,
    "priceAtSignal" DOUBLE PRECISION NOT NULL,
    "bidAtSignal" DOUBLE PRECISION,
    "spreadAtSignal" DOUBLE PRECISION,
    "confidenceScore" DOUBLE PRECISION,
    "priceAt30s" DOUBLE PRECISION,
    "priceAt1m" DOUBLE PRECISION,
    "priceAt5m" DOUBLE PRECISION,
    "priceAt10m" DOUBLE PRECISION,
    "bidAt30s" DOUBLE PRECISION,
    "bidAt1m" DOUBLE PRECISION,
    "bidAt5m" DOUBLE PRECISION,
    "bidAt10m" DOUBLE PRECISION,
    "wouldHaveWon" BOOLEAN,
    "maxPriceAfter" DOUBLE PRECISION,
    "minPriceAfter" DOUBLE PRECISION,
    "signalAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScalpSignalLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScalpTradeLog_tokenId_receivedAt_idx" ON "ScalpTradeLog"("tokenId", "receivedAt");

-- CreateIndex
CREATE INDEX "ScalpTradeLog_receivedAt_idx" ON "ScalpTradeLog"("receivedAt" DESC);

-- CreateIndex
CREATE INDEX "ScalpSignalLog_tokenId_signalAt_idx" ON "ScalpSignalLog"("tokenId", "signalAt");

-- CreateIndex
CREATE INDEX "ScalpSignalLog_signalAt_idx" ON "ScalpSignalLog"("signalAt" DESC);
