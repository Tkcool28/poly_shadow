-- CreateEnum
CREATE TYPE "ArbCycleStatus" AS ENUM ('PENDING', 'WATCHING', 'ENTERED', 'WON', 'LOST', 'STOPPED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "ScalpCycleStatus" AS ENUM ('ENTERED', 'SOLD', 'SETTLED_WON', 'SETTLED_LOST', 'SKIPPED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "CopyTrade" ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settlementPnl" DOUBLE PRECISION,
ADD COLUMN     "settlementPrice" DOUBLE PRECISION,
ADD COLUMN     "settlementValue" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "DetectedTrade" ADD COLUMN     "detectionSource" TEXT;

-- AlterTable
ALTER TABLE "FollowAllocation" ADD COLUMN     "copyTradePercent" DOUBLE PRECISION,
ADD COLUMN     "maxPositionUsd" DOUBLE PRECISION,
ADD COLUMN     "maxPredictionPositionUsd" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Trade" ALTER COLUMN "outcomeIndex" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ArbStrategyConfig" (
    "strategy" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "assets" TEXT,
    "durations" TEXT,
    "positionSizeUsd" DOUBLE PRECISION NOT NULL,
    "maxEntryPrice" DOUBLE PRECISION NOT NULL,
    "initialCapitalUsd" DOUBLE PRECISION NOT NULL,
    "everyNth" INTEGER,
    "cooldownLosses" INTEGER,
    "cooldownSkip" INTEGER,
    "antiMartingale" BOOLEAN NOT NULL DEFAULT false,
    "minConfidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArbStrategyConfig_pkey" PRIMARY KEY ("strategy")
);

-- CreateTable
CREATE TABLE "ArbCapital" (
    "id" TEXT NOT NULL,
    "initialCapital" DOUBLE PRECISION NOT NULL,
    "currentCapital" DOUBLE PRECISION NOT NULL,
    "deployedCapital" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isPaper" BOOLEAN NOT NULL DEFAULT true,
    "strategy" TEXT NOT NULL DEFAULT 'standard',
    "totalPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCycles" INTEGER NOT NULL DEFAULT 0,
    "totalWins" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArbCapital_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArbCycle" (
    "id" TEXT NOT NULL,
    "marketType" TEXT NOT NULL,
    "candleStartMs" BIGINT NOT NULL,
    "slug" TEXT NOT NULL,
    "conditionId" TEXT,
    "btcOpenPrice" DOUBLE PRECISION NOT NULL,
    "btcEntryPrice" DOUBLE PRECISION,
    "btcClosePrice" DOUBLE PRECISION,
    "direction" TEXT,
    "tokenId" TEXT,
    "entryPrice" DOUBLE PRECISION,
    "entryShares" DOUBLE PRECISION,
    "entryAmountUsd" DOUBLE PRECISION,
    "orderId" TEXT,
    "confidenceScore" DOUBLE PRECISION,
    "confidenceSignals" TEXT,
    "oppositePrice" DOUBLE PRECISION,
    "settlementPrice" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION,
    "estimatedFee" DOUBLE PRECISION,
    "settlementStartedAt" TIMESTAMP(3),
    "status" "ArbCycleStatus" NOT NULL DEFAULT 'PENDING',
    "failReason" TEXT,
    "isPaper" BOOLEAN NOT NULL DEFAULT true,
    "strategy" TEXT NOT NULL DEFAULT 'standard',
    "enteredAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArbCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScalpCycle" (
    "id" TEXT NOT NULL,
    "game" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "conditionId" TEXT,
    "marketQuestion" TEXT,
    "outcomeLabel" TEXT,
    "tokenId" TEXT,
    "eventType" TEXT NOT NULL,
    "eventSequence" INTEGER NOT NULL DEFAULT 0,
    "eventDetail" TEXT,
    "signalSource" TEXT,
    "signalConfidence" TEXT,
    "entryPrice" DOUBLE PRECISION,
    "entryShares" DOUBLE PRECISION,
    "entryAmountUsd" DOUBLE PRECISION,
    "entryOrderId" TEXT,
    "entryOrderType" TEXT,
    "entryLatencyMs" INTEGER,
    "exitPrice" DOUBLE PRECISION,
    "exitShares" DOUBLE PRECISION,
    "exitOrderId" TEXT,
    "exitMethod" TEXT,
    "pnl" DOUBLE PRECISION,
    "estimatedEdge" DOUBLE PRECISION,
    "status" "ScalpCycleStatus" NOT NULL DEFAULT 'ENTERED',
    "failReason" TEXT,
    "isPaper" BOOLEAN NOT NULL DEFAULT true,
    "enteredAt" TIMESTAMP(3),
    "exitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScalpCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScalpCapital" (
    "id" TEXT NOT NULL,
    "initialCapital" DOUBLE PRECISION NOT NULL,
    "currentCapital" DOUBLE PRECISION NOT NULL,
    "deployedCapital" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isPaper" BOOLEAN NOT NULL DEFAULT true,
    "totalPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCycles" INTEGER NOT NULL DEFAULT 0,
    "totalWins" INTEGER NOT NULL DEFAULT 0,
    "dailyLossUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dailyLossResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScalpCapital_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScalpMarketWatch" (
    "id" TEXT NOT NULL,
    "game" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "outcomes" TEXT NOT NULL,
    "clobTokenIds" TEXT NOT NULL,
    "negRisk" BOOLEAN NOT NULL DEFAULT false,
    "tickSize" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "orderMinSize" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "liquidity" DOUBLE PRECISION,
    "eventSlug" TEXT,
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "marketType" TEXT NOT NULL DEFAULT 'series',
    "homeTeam" TEXT,
    "awayTeam" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScalpMarketWatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArbCapital_isPaper_strategy_key" ON "ArbCapital"("isPaper", "strategy");

-- CreateIndex
CREATE INDEX "ArbCycle_status_idx" ON "ArbCycle"("status");

-- CreateIndex
CREATE INDEX "ArbCycle_marketType_candleStartMs_idx" ON "ArbCycle"("marketType", "candleStartMs");

-- CreateIndex
CREATE INDEX "ArbCycle_createdAt_idx" ON "ArbCycle"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "ArbCycle_isPaper_status_idx" ON "ArbCycle"("isPaper", "status");

-- CreateIndex
CREATE INDEX "ArbCycle_isPaper_strategy_status_idx" ON "ArbCycle"("isPaper", "strategy", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ArbCycle_marketType_candleStartMs_isPaper_strategy_key" ON "ArbCycle"("marketType", "candleStartMs", "isPaper", "strategy");

-- CreateIndex
CREATE INDEX "ScalpCycle_status_idx" ON "ScalpCycle"("status");

-- CreateIndex
CREATE INDEX "ScalpCycle_isPaper_status_idx" ON "ScalpCycle"("isPaper", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScalpCycle_matchId_game_tokenId_eventType_eventSequence_isP_key" ON "ScalpCycle"("matchId", "game", "tokenId", "eventType", "eventSequence", "isPaper");

-- CreateIndex
CREATE UNIQUE INDEX "ScalpCapital_isPaper_key" ON "ScalpCapital"("isPaper");

-- CreateIndex
CREATE UNIQUE INDEX "ScalpMarketWatch_slug_key" ON "ScalpMarketWatch"("slug");

-- CreateIndex
CREATE INDEX "ScalpMarketWatch_game_isActive_marketType_idx" ON "ScalpMarketWatch"("game", "isActive", "marketType");

-- CreateIndex
CREATE INDEX "ScalpMarketWatch_homeTeam_awayTeam_idx" ON "ScalpMarketWatch"("homeTeam", "awayTeam");

-- CreateIndex
CREATE INDEX "CopyTrade_tokenId_followAllocationId_isPaper_status_idx" ON "CopyTrade"("tokenId", "followAllocationId", "isPaper", "status");

-- CreateIndex
CREATE INDEX "CopyTrade_status_side_createdAt_idx" ON "CopyTrade"("status", "side", "createdAt");

-- CreateIndex
CREATE INDEX "DetectedTrade_proxyWallet_detectedAt_idx" ON "DetectedTrade"("proxyWallet", "detectedAt" DESC);

-- CreateIndex
CREATE INDEX "FollowAllocation_isActive_updatedAt_idx" ON "FollowAllocation"("isActive", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Trader_backfillStatus_backfillCompleted_idx" ON "Trader"("backfillStatus", "backfillCompleted");

