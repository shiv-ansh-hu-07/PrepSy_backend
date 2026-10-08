import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto } from './message.dto';

const GUEST_PREFIX = 'guest-';

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  async create(data: CreateMessageDto, userId: string | null) {
    const roomId = (data?.roomId || '').trim();
    // Keep indentation (pasted code): only drop blank edge lines + trailing space.
    const text = (data?.text || '').replace(/^\s*\n/, '').trimEnd();
    if (!roomId || !text.trim()) {
      throw new BadRequestException('roomId and text are required');
    }

    const room = await this.prisma.room.findUnique({
      where: { roomId },
      select: { roomId: true },
    });
    if (!room) throw new NotFoundException('Room not found');

    let senderId: string;
    let senderName: string;
    if (userId) {
      // Logged in: identity + display name come from the account, not the body.
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });
      if (!user) throw new BadRequestException('Unknown user');
      senderId = user.id;
      senderName = user.name || user.email.split('@')[0] || 'User';
    } else {
      // Anonymous: always a guest id, so nobody can post as a real account.
      const claimed = (data?.senderId || '').trim();
      senderId = claimed.startsWith(GUEST_PREFIX)
        ? claimed.slice(0, 64)
        : `${GUEST_PREFIX}${claimed.slice(0, 40) || 'anon'}`;
      senderName = (data?.senderName || 'Guest').trim().slice(0, 60) || 'Guest';
    }

    return this.prisma.message.create({
      data: {
        roomId,
        text: text.slice(0, 4000),
        senderId,
        senderName,
        replyToText: data.replyToText ? data.replyToText.slice(0, 300) : null,
        replyToSender: data.replyToSender ? data.replyToSender.slice(0, 120) : null,
      },
    });
  }

  async findByRoom(roomId: string) {
    if (!roomId) return [];
    // Return the MOST RECENT 100 messages (newest first from the DB), then
    // reverse to chronological order for display. The old `asc + take: 100`
    // returned the OLDEST 100, so once a room passed 100 messages, newer/today's
    // messages were never fetched and the chat looked like it got flushed.
    const messages = await this.prisma.message.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return messages.reverse();
  }
}
