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
    return this.prisma.message.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  }
}
