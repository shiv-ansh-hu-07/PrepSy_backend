-- Per-user email notification preference (opt-out). Defaults on.
ALTER TABLE "UserProfile" ADD COLUMN "emailNotifications" BOOLEAN NOT NULL DEFAULT true;
