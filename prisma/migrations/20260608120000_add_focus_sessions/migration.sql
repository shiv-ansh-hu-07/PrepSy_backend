CREATE TABLE "FocusSession" (
  "id"               TEXT         NOT NULL,
  "userId"           TEXT         NOT NULL,
  "roomId"           TEXT         NOT NULL,
  "roomName"         TEXT,
  "sessionDate"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "durationMinutes"  INTEGER      NOT NULL DEFAULT 0,
  "focusScore"       INTEGER      NOT NULL DEFAULT 0,
  "engagementScore"  INTEGER      NOT NULL DEFAULT 0,
  "distractionCount" INTEGER      NOT NULL DEFAULT 0,
  "offScreenSeconds" INTEGER      NOT NULL DEFAULT 0,
  "highFocusPercent" INTEGER      NOT NULL DEFAULT 0,
  "medFocusPercent"  INTEGER      NOT NULL DEFAULT 0,
  "lowFocusPercent"  INTEGER      NOT NULL DEFAULT 0,
  "totalSamples"     INTEGER      NOT NULL DEFAULT 0,
  CONSTRAINT "FocusSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FocusSession_userId_sessionDate_idx" ON "FocusSession"("userId", "sessionDate" DESC);
CREATE INDEX "FocusSession_roomId_sessionDate_idx" ON "FocusSession"("roomId", "sessionDate" DESC);

ALTER TABLE "FocusSession"
  ADD CONSTRAINT "FocusSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
