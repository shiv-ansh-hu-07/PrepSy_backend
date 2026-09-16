-- No-show (10-min-after-start) check fired-once flag.
ALTER TABLE "StudySession" ADD COLUMN "missedCheckSent" BOOLEAN NOT NULL DEFAULT false;
