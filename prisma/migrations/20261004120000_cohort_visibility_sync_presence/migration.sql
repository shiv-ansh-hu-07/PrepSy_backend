-- Cohort: public/private + synced/self-paced
ALTER TABLE "Cohort" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "Cohort" ADD COLUMN "inviteCode" TEXT;
ALTER TABLE "Cohort" ADD COLUMN "syncMode" TEXT NOT NULL DEFAULT 'SYNC';
CREATE UNIQUE INDEX "Cohort_inviteCode_key" ON "Cohort"("inviteCode");

-- CohortMember: live presence + accumulated study time
ALTER TABLE "CohortMember" ADD COLUMN "watchingVideoId" TEXT;
ALTER TABLE "CohortMember" ADD COLUMN "watchingPositionSec" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CohortMember" ADD COLUMN "watchingPlaying" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CohortMember" ADD COLUMN "presenceAt" TIMESTAMP(3);
ALTER TABLE "CohortMember" ADD COLUMN "studySeconds" INTEGER NOT NULL DEFAULT 0;
