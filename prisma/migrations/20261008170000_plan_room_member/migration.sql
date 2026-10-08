-- Per-member progress in plan-linked rooms
CREATE TABLE "PlanRoomMember" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanRoomMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlanRoomMember_roomId_userId_key" ON "PlanRoomMember"("roomId", "userId");
CREATE INDEX "PlanRoomMember_roomId_idx" ON "PlanRoomMember"("roomId");
