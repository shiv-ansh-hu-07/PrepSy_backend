-- Cohort: shared recurring room + daily scheduling
ALTER TABLE "Cohort" ADD COLUMN "roomId" TEXT;
ALTER TABLE "Cohort" ADD COLUMN "startMode" TEXT;
ALTER TABLE "Cohort" ADD COLUMN "dailyTime" TEXT;
ALTER TABLE "Cohort" ADD COLUMN "startDate" TIMESTAMP(3);

-- StudySession: per-day topic status + ordering
ALTER TABLE "StudySession" ADD COLUMN "description" TEXT;
ALTER TABLE "StudySession" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'SCHEDULED';
ALTER TABLE "StudySession" ADD COLUMN "orderIndex" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "StudySession_status_scheduledAt_idx" ON "StudySession"("status", "scheduledAt");
