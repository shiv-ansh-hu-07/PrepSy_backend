-- Cohorts are small study crews (deck max = 6), not broadcasts.
ALTER TABLE "Cohort" ALTER COLUMN "maxSize" SET DEFAULT 6;
