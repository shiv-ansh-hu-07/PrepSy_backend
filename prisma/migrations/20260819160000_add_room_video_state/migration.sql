-- Persistent playback memory per room (resume where the video was left off).
CREATE TABLE "RoomVideoState" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "videoId" TEXT,
    "positionSec" INTEGER NOT NULL DEFAULT 0,
    "playing" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomVideoState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoomVideoState_roomId_key" ON "RoomVideoState"("roomId");

ALTER TABLE "RoomVideoState" ADD CONSTRAINT "RoomVideoState_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "Room"("roomId") ON DELETE CASCADE ON UPDATE CASCADE;
