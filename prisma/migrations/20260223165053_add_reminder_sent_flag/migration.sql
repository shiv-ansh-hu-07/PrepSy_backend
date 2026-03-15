/*
  Warnings:

  - You are about to drop the column `reminderSent` on the `Room` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Room" DROP COLUMN "reminderSent",
ADD COLUMN     "remindersent" BOOLEAN NOT NULL DEFAULT false;
