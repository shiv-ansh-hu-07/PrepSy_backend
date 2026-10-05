-- Per-day cohort study time (weekly race + rank movement)
CREATE TABLE "CohortStudyDay" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CohortStudyDay_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CohortStudyDay_cohortId_userId_day_key" ON "CohortStudyDay"("cohortId", "userId", "day");
CREATE INDEX "CohortStudyDay_cohortId_day_idx" ON "CohortStudyDay"("cohortId", "day");
