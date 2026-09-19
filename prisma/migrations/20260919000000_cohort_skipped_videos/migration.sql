-- Videos excluded from a cohort's active plan (skipped at creation or jumped
-- past during a session). They don't affect the schedule/pace; offered as catch-up.
ALTER TABLE "Cohort" ADD COLUMN "skippedVideoIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
