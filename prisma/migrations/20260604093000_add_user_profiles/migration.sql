-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT,
    "phone" TEXT,
    "avatarUrl" TEXT,
    "bio" TEXT,
    "age" INTEGER,
    "gender" TEXT,
    "goals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "interests" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "skills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "examTargets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lookingFor" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "availability" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "timezone" TEXT,
    "institutionType" TEXT,
    "institutionName" TEXT,
    "degree" TEXT,
    "branch" TEXT,
    "semester" TEXT,
    "expectedGraduation" TEXT,
    "company" TEXT,
    "role" TEXT,
    "experienceLevel" TEXT,
    "workMode" TEXT,
    "collaborationPreference" TEXT,
    "portfolioUrl" TEXT,
    "linkedinUrl" TEXT,
    "githubUrl" TEXT,
    "isDiscoverable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_username_key" ON "UserProfile"("username");

-- CreateIndex
CREATE INDEX "UserProfile_city_idx" ON "UserProfile"("city");

-- CreateIndex
CREATE INDEX "UserProfile_institutionType_idx" ON "UserProfile"("institutionType");

-- CreateIndex
CREATE INDEX "UserProfile_institutionName_idx" ON "UserProfile"("institutionName");

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
