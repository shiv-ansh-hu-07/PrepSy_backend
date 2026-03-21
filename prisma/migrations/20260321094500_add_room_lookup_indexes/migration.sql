CREATE INDEX "Room_ownerId_createdAt_idx" ON "Room"("ownerId", "createdAt");

CREATE INDEX "RoomMember_userId_roomId_idx" ON "RoomMember"("userId", "roomId");
