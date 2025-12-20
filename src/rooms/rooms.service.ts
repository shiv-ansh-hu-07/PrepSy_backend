// src/rooms/rooms.service.ts
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { v4 as uuid } from 'uuid';
import { RoomWithRelations } from './room.types';

@Injectable()
export class RoomsService {
  constructor(private prisma: PrismaService) {}

  // -------------------------------
  // CREATE ROOM (PUBLIC / PRIVATE)
  // -------------------------------
  async createRoom(
    name: string,
    roomId: string,
    description: string,
    tags: string[],
    visibility: 'PUBLIC' | 'PRIVATE',
    userId: string
  ) {
    const finalRoomId = roomId || uuid();

    const room = await this.prisma.room.create({
      data: {
        name,
        roomId: finalRoomId,
        description,
        tags: tags || [],
        visibility,
        ownerId: userId,
      },
    });

    return {
      success: true,
      roomId: room.roomId,
      name: room.name,
    };
  }

  // -------------------------------
  // GET ALL ROOMS (ADMIN / DEBUG)
  // -------------------------------
  async getRooms() {
    const rooms = await this.prisma.room.findMany();
    return { rooms };
  }

  // -------------------------------
  // GET PUBLIC ROOMS (DASHBOARD)
  // -------------------------------
  async getPublicRooms() {
    const rooms = await this.prisma.room.findMany({
      where: {
        visibility: 'PUBLIC',
      },
      select: {
        id: true,
        roomId: true,
        name: true,
        description: true,
        tags: true,
        ownerId: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return { rooms };
  }

  // -------------------------------
  // SEARCH ROOMS BY TAGS
  // -------------------------------
  async searchRoomsByTags(tags: string[]) {
    if (!tags || tags.length === 0) {
      return { rooms: [] };
    }

    const rooms = await this.prisma.room.findMany({
      where: {
        tags: {
          hasSome: tags,
        },
      },
      select: {
        id: true,
        roomId: true,
        name: true,
        description: true,
        tags: true,
        ownerId: true,
        createdAt: true,
      },
    });

    return { rooms };
  }

  // -------------------------------
  // GET ROOMS CREATED / JOINED BY USER
  // -------------------------------
  async getMyRooms(userId: string) {
    const createdRooms = await this.prisma.room.findMany({
      where: { ownerId: userId },
      select: {
        id: true,
        roomId: true,
        name: true,
        description: true,
        tags: true,
        ownerId: true,
        createdAt: true,
      },
    });

    const joinedEntries = await this.prisma.roomMember.findMany({
      where: { userId },
      include: {
        room: {
          select: {
            id: true,
            roomId: true,
            name: true,
            description: true,
            tags: true,
            ownerId: true,
            createdAt: true,
          },
        },
      },
    });

    const joinedRooms = joinedEntries.map((entry) => entry.room);

    return {
      createdRooms,
      joinedRooms,
    };
  }

  // -------------------------------
  // JOIN ROOM
  // -------------------------------
  async joinRoom(roomId: string, userId: string) {
    const room = await this.prisma.room.findUnique({
      where: { roomId },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const exists = await this.prisma.roomMember.findFirst({
      where: { roomId, userId },
    });

    if (!exists) {
      await this.prisma.roomMember.create({
        data: { roomId, userId },
      });
    }

    return { success: true };
  }

  // -------------------------------
  // DELETE ROOM (OWNER ONLY)
  // -------------------------------
  async deleteRoom(roomId: string, userId: string) {
    const room = await this.prisma.room.findUnique({
      where: { roomId },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.ownerId !== userId) {
      throw new ForbiddenException(
        'You are not allowed to delete this room'
      );
    }

    await this.prisma.roomMember.deleteMany({
      where: { roomId },
    });

    await this.prisma.message.deleteMany({
      where: { roomId },
    });

    await this.prisma.pomodoro.deleteMany({
      where: { roomId },
    });

    await this.prisma.room.delete({
      where: { roomId },
    });

    return { success: true };
  }

  // -------------------------------
  // GET ROOM DETAILS
  // -------------------------------
  async getRoomDetails(roomId: string): Promise<RoomWithRelations> {
    const room = await this.prisma.room.findUnique({
      where: { roomId },
      include: {
        members: true,
        messages: { orderBy: { createdAt: 'asc' } },
        pomodoro: true,
      },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    return room;
  }

  // -------------------------------
  // SAVE CHAT MESSAGE
  // -------------------------------
  // -------------------------------
// SAVE CHAT MESSAGE (PERSISTENT)
// -------------------------------
async saveMessage(
  roomId: string,
  senderId: string,
  text: string,
  senderName?: string
) {
  return this.prisma.message.create({
    data: {
      roomId,
      senderId,
      senderName,
      text,
    },
  });
}



async getRoomMessages(roomId: string) {
  return this.prisma.message.findMany({
    where: { roomId },
    orderBy: { createdAt: 'asc' },
  });
}



  // -------------------------------
  // SAVE / UPDATE POMODORO
  // -------------------------------
  async savePomodoro(
    roomId: string,
    pomodoro: {
      running: boolean;
      mode: string;
      remaining: number;
    }
  ) {
    return this.prisma.pomodoro.upsert({
      where: { roomId },
      create: {
        roomId,
        running: pomodoro.running,
        mode: pomodoro.mode,
        remaining: pomodoro.remaining,
      },
      update: {
        running: pomodoro.running,
        mode: pomodoro.mode,
        remaining: pomodoro.remaining,
      },
    });
  }
}
