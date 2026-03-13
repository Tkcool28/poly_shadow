-- Add majority-only mode to FollowAllocation
-- When enabled, only the majority side of both-side traders is copied after threshold detection
ALTER TABLE "FollowAllocation" ADD COLUMN "majorityOnlyMode" BOOLEAN NOT NULL DEFAULT false;
