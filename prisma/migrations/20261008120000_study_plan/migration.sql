-- AI study planner: saved plans
CREATE TABLE "StudyPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "profile" JSONB NOT NULL DEFAULT '{}',
    "plan" JSONB NOT NULL DEFAULT '{}',
    "chat" JSONB NOT NULL DEFAULT '[]',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StudyPlan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StudyPlan_userId_createdAt_idx" ON "StudyPlan"("userId", "createdAt");
