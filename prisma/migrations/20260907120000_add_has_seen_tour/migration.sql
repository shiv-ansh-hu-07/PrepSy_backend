-- Whether the user has completed/dismissed the first-login product tour.
-- Account-scoped (follows the user across devices). Defaults off so new users see it once.
ALTER TABLE "UserProfile" ADD COLUMN "hasSeenTour" BOOLEAN NOT NULL DEFAULT false;
