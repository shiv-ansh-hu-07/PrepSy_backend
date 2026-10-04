import { Controller, Post, Body, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MessagesService } from './messages.service';
import type { CreateMessageDto } from './message.dto';
import { OptionalJwtAuthGuard } from '../analytics/optional-jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';

// Room chat persistence. Guests can chat in rooms, so these stay reachable
// without a token — but the sender identity is decided server-side: a logged-in
// caller is always stored as themselves, and an anonymous caller can only ever
// be stored as a guest (never as a real user's id).
@Controller('messages')
@UseGuards(OptionalJwtAuthGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post()
  async create(@Req() req: RequestWithUser, @Body() body: CreateMessageDto) {
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.messagesService.create(body, userId);
  }

  @Get()
  async findAll(@Query('roomId') roomId: string) {
    return this.messagesService.findByRoom(roomId);
  }
}
