-- Per-cohort toggle for surprise "fastest-finger" quizzes (default on).
ALTER TABLE "Cohort" ADD COLUMN "surpriseQuiz" BOOLEAN NOT NULL DEFAULT true;
