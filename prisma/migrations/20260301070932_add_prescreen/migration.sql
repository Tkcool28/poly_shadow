-- AlterEnum
ALTER TYPE "BackfillStatus" ADD VALUE 'SCREENED_OUT';

-- AlterTable
ALTER TABLE "Trader" ADD COLUMN     "screenPositionCount" INTEGER,
ADD COLUMN     "screenRoi" DOUBLE PRECISION,
ADD COLUMN     "screenWinRate" DOUBLE PRECISION,
ADD COLUMN     "screenedAt" TIMESTAMP(3);
