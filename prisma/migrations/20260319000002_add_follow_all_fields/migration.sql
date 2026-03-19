-- Follow-all mode: per-allocation SELL-copy and committed-side-lock overrides
ALTER TABLE "FollowAllocation" ADD COLUMN "copySells" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FollowAllocation" ADD COLUMN "committedSideLock" BOOLEAN NOT NULL DEFAULT true;
