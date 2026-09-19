-- Optional file attachment (image/document) on a cohort discussion post.
ALTER TABLE "DiscussionPost" ADD COLUMN "attachmentUrl" TEXT;
ALTER TABLE "DiscussionPost" ADD COLUMN "attachmentName" TEXT;
ALTER TABLE "DiscussionPost" ADD COLUMN "attachmentType" TEXT;
