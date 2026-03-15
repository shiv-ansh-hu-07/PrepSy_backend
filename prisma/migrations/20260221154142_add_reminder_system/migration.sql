-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "durationMinutes" INTEGER,
ADD COLUMN     "isRecurring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recurrenceEndDate" TIMESTAMP(3),
ADD COLUMN     "recurrenceType" TEXT,
ADD COLUMN     "startTime" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RoomAttendance" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "RoomAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomAttendance_roomId_idx" ON "RoomAttendance"("roomId");

-- AddForeignKey
ALTER TABLE "RoomAttendance" ADD CONSTRAINT "RoomAttendance_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("roomId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomAttendance" ADD CONSTRAINT "RoomAttendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
