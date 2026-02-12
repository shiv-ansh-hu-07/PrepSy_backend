import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { MessagesService } from './messages.service';

@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post()
  async create(@Body() body: any) {
    return this.messagesService.create(body);
  }

  @Get()
  async findAll(@Query('roomId') roomId: string) {
    return this.messagesService.findByRoom(roomId);
  }
}