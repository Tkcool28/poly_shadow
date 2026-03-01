-- DropForeignKey
ALTER TABLE "ClosedPosition" DROP CONSTRAINT "ClosedPosition_conditionId_fkey";

-- DropForeignKey
ALTER TABLE "Position" DROP CONSTRAINT "Position_conditionId_fkey";

-- DropForeignKey
ALTER TABLE "Trade" DROP CONSTRAINT "Trade_conditionId_fkey";
