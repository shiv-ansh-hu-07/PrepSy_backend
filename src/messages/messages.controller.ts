import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { MessagesService } from './messages.service';
import type { CreateMessageDto } from './message.dto';

@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post()
  async create(@Body() body: CreateMessageDto) {
    return this.messagesService.create(body);
  }

  @Get()
  async findAll(@Query('roomId') roomId: string) {
    return this.messagesService.findByRoom(roomId);
  }
}
