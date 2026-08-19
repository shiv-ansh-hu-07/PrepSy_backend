-- Product analytics event stream (activation / WAU / retention).
-- FK-less on purpose: events survive user deletion and anonymous events have no user.
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "anonId" TEXT,
    "sessionId" TEXT,
    "path" TEXT,
    "props" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Event_name_createdAt_idx" ON "Event"("name", "createdAt");
CREATE INDEX "Event_userId_createdAt_idx" ON "Event"("userId", "createdAt");
CREATE INDEX "Event_anonId_createdAt_idx" ON "Event"("anonId", "createdAt");
CREATE INDEX "Event_createdAt_idx" ON "Event"("createdAt");
