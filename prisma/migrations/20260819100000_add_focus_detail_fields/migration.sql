-- Typed focus breakdown from the MediaPipe monitor.
ALTER TABLE "FocusSession" ADD COLUMN "noteTakingPercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FocusSession" ADD COLUMN "phonePercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FocusSession" ADD COLUMN "drowsinessPercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FocusSession" ADD COLUMN "lookAwayPercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FocusSession" ADD COLUMN "longestFocusStreakSec" INTEGER NOT NULL DEFAULT 0;
