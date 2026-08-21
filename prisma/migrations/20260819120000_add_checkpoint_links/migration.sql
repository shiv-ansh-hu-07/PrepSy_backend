-- Attach quizzes and discussions to a StudySession (per-day/unit checkpoints).
ALTER TABLE "QuizAttempt" ADD COLUMN "studySessionId" TEXT;
ALTER TABLE "DiscussionPost" ADD COLUMN "studySessionId" TEXT;

CREATE INDEX "QuizAttempt_studySessionId_idx" ON "QuizAttempt"("studySessionId");
CREATE INDEX "DiscussionPost_studySessionId_idx" ON "DiscussionPost"("studySessionId");

ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_studySessionId_fkey"
  FOREIGN KEY ("studySessionId") REFERENCES "StudySession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DiscussionPost" ADD CONSTRAINT "DiscussionPost_studySessionId_fkey"
  FOREIGN KEY ("studySessionId") REFERENCES "StudySession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
