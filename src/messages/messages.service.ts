import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto } from './message.dto';

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  async create(data: CreateMessageDto) {
    return this.prisma.message.create({
      data: {
        roomId: data.roomId,
        text: data.text,
        senderId: data.senderId,
        senderName: data.senderName,
        replyToText: data.replyToText ? data.replyToText.slice(0, 300) : null,
        replyToSender: data.replyToSender ? data.replyToSender.slice(0, 120) : null,
      },
    });
  }

  async findByRoom(roomId: string) {
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
