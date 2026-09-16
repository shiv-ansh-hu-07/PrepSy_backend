-- Near-session "starting soon" reminder fired-once flag.
ALTER TABLE "StudySession" ADD COLUMN "reminderSent" BOOLEAN NOT NULL DEFAULT false;
