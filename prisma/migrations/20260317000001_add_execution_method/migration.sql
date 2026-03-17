-- CreateEnum
CREATE TYPE "ExecutionMethod" AS ENUM ('FAK', 'GTC', 'POOL');

-- AlterTable
ALTER TABLE "CopyTrade" ADD COLUMN "executionMethod" "ExecutionMethod";
