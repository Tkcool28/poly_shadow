-- CreateEnum
CREATE TYPE "TraderSource" AS ENUM ('LEADERBOARD', 'MANUAL');

-- CreateEnum
CREATE TYPE "BackfillStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'PERMANENTLY_FAILED');

-- CreateTable
CREATE TABLE "Trader" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "userName" TEXT,
    "profileImage" TEXT,
    "xUsername" TEXT,
    "verifiedBadge" BOOLEAN NOT NULL DEFAULT false,
    "source" "TraderSource" NOT NULL DEFAULT 'LEADERBOARD',
    "isMonitored" BOOLEAN NOT NULL DEFAULT false,
    "backfillStatus" "BackfillStatus" NOT NULL DEFAULT 'PENDING',
    "backfillLockedAt" TIMESTAMP(3),
    "backfillStarted" TIMESTAMP(3),
    "backfillCompleted" TIMESTAMP(3),
    "backfillRetries" INTEGER NOT NULL DEFAULT 0,
    "backfillError" TEXT,
    "lastTradeSync" TIMESTAMP(3),
    "lastPositionSync" TIMESTAMP(3),
    "leaderboardPnl" DOUBLE PRECISION,
    "leaderboardVol" DOUBLE PRECISION,
    "leaderboardRank" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" TEXT,
    "outcomes" TEXT NOT NULL,
    "outcomePrices" TEXT,
    "endDate" TIMESTAMP(3),
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "volume" DOUBLE PRECISION,
    "liquidity" DOUBLE PRECISION,
    "image" TEXT,
    "icon" TEXT,
    "eventSlug" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "outcomeIndex" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "title" TEXT,
    "eventSlug" TEXT,
    "usdValue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "avgPrice" DOUBLE PRECISION NOT NULL,
    "initialValue" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION,
    "cashPnl" DOUBLE PRECISION,
    "percentPnl" DOUBLE PRECISION,
    "realizedPnl" DOUBLE PRECISION,
    "curPrice" DOUBLE PRECISION,
    "outcome" TEXT NOT NULL,
    "outcomeIndex" INTEGER NOT NULL,
    "title" TEXT,
    "eventSlug" TEXT,
    "endDate" TIMESTAMP(3),
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClosedPosition" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "avgPrice" DOUBLE PRECISION NOT NULL,
    "totalBought" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL,
    "curPrice" DOUBLE PRECISION NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "outcomeIndex" INTEGER,
    "title" TEXT,
    "eventSlug" TEXT,
    "endDate" TIMESTAMP(3),

    CONSTRAINT "ClosedPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "conditionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "usdcSize" DOUBLE PRECISION NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "asset" TEXT,
    "side" TEXT,
    "outcomeIndex" INTEGER,
    "title" TEXT,
    "eventSlug" TEXT,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraderScore" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "totalPnl" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL,
    "unrealizedPnl" DOUBLE PRECISION NOT NULL,
    "roi" DOUBLE PRECISION NOT NULL,
    "avgProfitPerTrade" DOUBLE PRECISION NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "maxWinStreak" INTEGER NOT NULL,
    "maxLossStreak" INTEGER NOT NULL,
    "returnStdDev" DOUBLE PRECISION NOT NULL,
    "maxDrawdown" DOUBLE PRECISION NOT NULL,
    "totalTrades" INTEGER NOT NULL,
    "totalMarkets" INTEGER NOT NULL,
    "avgPositionSize" DOUBLE PRECISION NOT NULL,
    "avgHoldDuration" DOUBLE PRECISION,
    "tradeFrequency" DOUBLE PRECISION NOT NULL,
    "activeDays" INTEGER NOT NULL,
    "avgRelativePositionSize" DOUBLE PRECISION NOT NULL,
    "concentrationScore" DOUBLE PRECISION NOT NULL,
    "recentPnl30d" DOUBLE PRECISION NOT NULL,
    "recentWinRate30d" DOUBLE PRECISION NOT NULL,
    "trendDirection" DOUBLE PRECISION NOT NULL,
    "compositeScore" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TraderScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraderScoreHistory" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "compositeScore" DOUBLE PRECISION NOT NULL,
    "totalPnl" DOUBLE PRECISION NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TraderScoreHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryScore" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "pnl" DOUBLE PRECISION NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "totalTrades" INTEGER NOT NULL,
    "avgReturn" DOUBLE PRECISION NOT NULL,
    "specializationScore" DOUBLE PRECISION NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategoryScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectedTrade" (
    "id" TEXT NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "userName" TEXT,
    "side" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "outcome" TEXT NOT NULL,
    "title" TEXT,
    "eventSlug" TEXT,
    "transactionHash" TEXT NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "compositeScore" DOUBLE PRECISION,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DetectedTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemHealth" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunDuration" INTEGER NOT NULL,
    "lastRunResult" TEXT NOT NULL,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemHealth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Trader_proxyWallet_key" ON "Trader"("proxyWallet");

-- CreateIndex
CREATE INDEX "Trader_backfillStatus_idx" ON "Trader"("backfillStatus");

-- CreateIndex
CREATE INDEX "Trader_isMonitored_idx" ON "Trader"("isMonitored");

-- CreateIndex
CREATE INDEX "Trader_leaderboardPnl_idx" ON "Trader"("leaderboardPnl" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Market_conditionId_key" ON "Market"("conditionId");

-- CreateIndex
CREATE INDEX "Market_category_idx" ON "Market"("category");

-- CreateIndex
CREATE INDEX "Market_slug_idx" ON "Market"("slug");

-- CreateIndex
CREATE INDEX "Trade_proxyWallet_timestamp_idx" ON "Trade"("proxyWallet", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "Trade_conditionId_idx" ON "Trade"("conditionId");

-- CreateIndex
CREATE INDEX "Trade_timestamp_idx" ON "Trade"("timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Trade_transactionHash_proxyWallet_asset_side_size_price_key" ON "Trade"("transactionHash", "proxyWallet", "asset", "side", "size", "price");

-- CreateIndex
CREATE INDEX "Position_proxyWallet_idx" ON "Position"("proxyWallet");

-- CreateIndex
CREATE INDEX "Position_conditionId_idx" ON "Position"("conditionId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_proxyWallet_asset_key" ON "Position"("proxyWallet", "asset");

-- CreateIndex
CREATE INDEX "ClosedPosition_proxyWallet_idx" ON "ClosedPosition"("proxyWallet");

-- CreateIndex
CREATE INDEX "ClosedPosition_conditionId_idx" ON "ClosedPosition"("conditionId");

-- CreateIndex
CREATE UNIQUE INDEX "ClosedPosition_proxyWallet_asset_conditionId_key" ON "ClosedPosition"("proxyWallet", "asset", "conditionId");

-- CreateIndex
CREATE INDEX "Activity_proxyWallet_timestamp_idx" ON "Activity"("proxyWallet", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "Activity_type_idx" ON "Activity"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_transactionHash_proxyWallet_conditionId_type_times_key" ON "Activity"("transactionHash", "proxyWallet", "conditionId", "type", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "TraderScore_proxyWallet_key" ON "TraderScore"("proxyWallet");

-- CreateIndex
CREATE INDEX "TraderScore_compositeScore_idx" ON "TraderScore"("compositeScore" DESC);

-- CreateIndex
CREATE INDEX "TraderScore_calculatedAt_idx" ON "TraderScore"("calculatedAt" DESC);

-- CreateIndex
CREATE INDEX "TraderScoreHistory_proxyWallet_calculatedAt_idx" ON "TraderScoreHistory"("proxyWallet", "calculatedAt" DESC);

-- CreateIndex
CREATE INDEX "CategoryScore_proxyWallet_idx" ON "CategoryScore"("proxyWallet");

-- CreateIndex
CREATE INDEX "CategoryScore_category_idx" ON "CategoryScore"("category");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryScore_proxyWallet_category_calculatedAt_key" ON "CategoryScore"("proxyWallet", "category", "calculatedAt");

-- CreateIndex
CREATE INDEX "DetectedTrade_detectedAt_idx" ON "DetectedTrade"("detectedAt" DESC);

-- CreateIndex
CREATE INDEX "DetectedTrade_proxyWallet_idx" ON "DetectedTrade"("proxyWallet");

-- CreateIndex
CREATE UNIQUE INDEX "DetectedTrade_transactionHash_proxyWallet_asset_key" ON "DetectedTrade"("transactionHash", "proxyWallet", "asset");

-- CreateIndex
CREATE UNIQUE INDEX "SystemHealth_jobName_key" ON "SystemHealth"("jobName");

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_proxyWallet_fkey" FOREIGN KEY ("proxyWallet") REFERENCES "Trader"("proxyWallet") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_conditionId_fkey" FOREIGN KEY ("conditionId") REFERENCES "Market"("conditionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_proxyWallet_fkey" FOREIGN KEY ("proxyWallet") REFERENCES "Trader"("proxyWallet") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_conditionId_fkey" FOREIGN KEY ("conditionId") REFERENCES "Market"("conditionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosedPosition" ADD CONSTRAINT "ClosedPosition_proxyWallet_fkey" FOREIGN KEY ("proxyWallet") REFERENCES "Trader"("proxyWallet") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosedPosition" ADD CONSTRAINT "ClosedPosition_conditionId_fkey" FOREIGN KEY ("conditionId") REFERENCES "Market"("conditionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_proxyWallet_fkey" FOREIGN KEY ("proxyWallet") REFERENCES "Trader"("proxyWallet") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraderScore" ADD CONSTRAINT "TraderScore_proxyWallet_fkey" FOREIGN KEY ("proxyWallet") REFERENCES "Trader"("proxyWallet") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraderScoreHistory" ADD CONSTRAINT "TraderScoreHistory_proxyWallet_fkey" FOREIGN KEY ("proxyWallet") REFERENCES "Trader"("proxyWallet") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryScore" ADD CONSTRAINT "CategoryScore_proxyWallet_fkey" FOREIGN KEY ("proxyWallet") REFERENCES "Trader"("proxyWallet") ON DELETE RESTRICT ON UPDATE CASCADE;
