import { Room, RoomMember, Message, Pomodoro } from '@prisma/client';

export type RoomWithRelations = Room & {
  members: RoomMember[];
  messages: Message[];
  pomodoro: Pomodoro | null;
};
