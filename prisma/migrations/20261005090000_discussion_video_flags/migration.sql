-- Video flags: discussion posts pinned to a moment in a playlist video
ALTER TABLE "DiscussionPost" ADD COLUMN "videoId" TEXT;
ALTER TABLE "DiscussionPost" ADD COLUMN "timeSec" INTEGER;
CREATE INDEX "DiscussionPost_cohortId_videoId_idx" ON "DiscussionPost"("cohortId", "videoId");
