import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  async create(data: any) {
    return this.prisma.message.create({
      data: {
        roomId: data.roomId,
        text: data.text,
        senderId: data.senderId,
        senderName: data.senderName,
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