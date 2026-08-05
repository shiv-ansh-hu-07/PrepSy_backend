-- Decouple RoomAttendance from Room so deleting a room no longer erases a user's
-- analytics. Room info is denormalized onto each attendance row (like FocusSession),
-- and the foreign key is dropped so attendance records survive room deletion.

-- 1. Add denormalized room columns.
ALTER TABLE "RoomAttendance" ADD COLUMN "roomName" TEXT;
ALTER TABLE "RoomAttendance" ADD COLUMN "roomTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "RoomAttendance" ADD COLUMN "roomDurationMinutes" INTEGER;

-- 2. Backfill from the currently-associated room so historical analytics are preserved.
UPDATE "RoomAttendance" ra
SET "roomName" = r."name",
    "roomTags" = COALESCE(r."tags", ARRAY[]::TEXT[]),
    "roomDurationMinutes" = r."durationMinutes"
FROM "Room" r
WHERE ra."roomId" = r."roomId";

-- 3. Drop the foreign key so room deletion no longer blocks or cascades to attendance.
ALTER TABLE "RoomAttendance" DROP CONSTRAINT IF EXISTS "RoomAttendance_roomId_fkey";
