-- CreateTable Playlist
CREATE TABLE "Playlist" (
    "id" TEXT NOT NULL,
    "ytPlaylistId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "channelTitle" TEXT,
    "thumbnailUrl" TEXT,
    "videoCount" INTEGER NOT NULL DEFAULT 0,
    "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Playlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable PlaylistVideo
CREATE TABLE "PlaylistVideo" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "ytVideoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "thumbnailUrl" TEXT,
    "position" INTEGER NOT NULL,
    "durationSec" INTEGER,
    CONSTRAINT "PlaylistVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable PlaylistPlan
CREATE TABLE "PlaylistPlan" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "estimatedHours" DOUBLE PRECISION NOT NULL,
    "curriculum" JSONB NOT NULL,
    "roadmap" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlaylistPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable Cohort
CREATE TABLE "Cohort" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "maxSize" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Cohort_pkey" PRIMARY KEY ("id")
);

-- CreateTable CohortMember
CREATE TABLE "CohortMember" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "progress" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "CohortMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable StudySession
CREATE TABLE "StudySession" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "roomId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StudySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable DiscussionPost
CREATE TABLE "DiscussionPost" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable QuizAttempt
CREATE TABLE "QuizAttempt" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "answers" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuizAttempt_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "Playlist_ytPlaylistId_key" ON "Playlist"("ytPlaylistId");
CREATE UNIQUE INDEX "PlaylistPlan_playlistId_key" ON "PlaylistPlan"("playlistId");
CREATE UNIQUE INDEX "CohortMember_cohortId_userId_key" ON "CohortMember"("cohortId", "userId");

-- Indexes
CREATE INDEX "PlaylistVideo_playlistId_idx" ON "PlaylistVideo"("playlistId");
CREATE INDEX "Cohort_playlistId_idx" ON "Cohort"("playlistId");
CREATE INDEX "StudySession_cohortId_idx" ON "StudySession"("cohortId");
CREATE INDEX "DiscussionPost_cohortId_createdAt_idx" ON "DiscussionPost"("cohortId", "createdAt");
CREATE INDEX "QuizAttempt_cohortId_userId_idx" ON "QuizAttempt"("cohortId", "userId");

-- Foreign Keys
ALTER TABLE "PlaylistVideo" ADD CONSTRAINT "PlaylistVideo_playlistId_fkey"
    FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaylistPlan" ADD CONSTRAINT "PlaylistPlan_playlistId_fkey"
    FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_playlistId_fkey"
    FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CohortMember" ADD CONSTRAINT "CohortMember_cohortId_fkey"
    FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CohortMember" ADD CONSTRAINT "CohortMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_cohortId_fkey"
    FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscussionPost" ADD CONSTRAINT "DiscussionPost_cohortId_fkey"
    FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscussionPost" ADD CONSTRAINT "DiscussionPost_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DiscussionPost" ADD CONSTRAINT "DiscussionPost_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "DiscussionPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_cohortId_fkey"
    FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
