-- Playback fields for the in-room player: the day's video IDs and, for a
-- video sliced across days, its time segment and part label.
ALTER TABLE "StudySession" ADD COLUMN "videoIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StudySession" ADD COLUMN "startSec" INTEGER;
ALTER TABLE "StudySession" ADD COLUMN "endSec" INTEGER;
ALTER TABLE "StudySession" ADD COLUMN "part" TEXT;
