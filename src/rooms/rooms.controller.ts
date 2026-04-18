import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  UseGuards,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { Delete, Param } from '@nestjs/common';
import type { RequestWithUser } from '../auth/auth-user.interface';

@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private roomsService: RoomsService) {}

  private getUserId(req: RequestWithUser) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Invalid user token');
    }
    return userId;
  }

  @Post('create')
  createRoom(
    @Body('name') name: string,
    @Body('roomId') roomId: string,
    @Body('description') description: string,
    @Body('tags') tags: string[],
    @Body('visibility') visibility: 'PUBLIC' | 'PRIVATE',
    @Req() req: RequestWithUser,
    @Body('startTime') startTime?: string,
    @Body('durationMinutes') durationMinutes?: number,
    @Body('isRecurring') isRecurring?: boolean,
    @Body('recurrenceType') recurrenceType?: string,
    @Body('recurrenceEndDate') recurrenceEndDate?: string,
    @Body('scheduleTime') scheduleTime?: string,
    @Body('timezone') timezone?: string,
  ) {
    return this.roomsService.createRoom(
      name,
      roomId,
      description,
      tags,
      visibility,
      this.getUserId(req),
      startTime,
      durationMinutes,
      isRecurring,
      recurrenceType,
      recurrenceEndDate,
      scheduleTime,
      timezone,
    );
  }

  @Get()
  getRooms() {
    return this.roomsService.getRooms();
  }

  @Get('public')
  getPublicRooms() {
    return this.roomsService.getPublicRooms();
  }

  @Get('my')
  getMyRooms(@Req() req: RequestWithUser) {
    return this.roomsService.getMyRooms(this.getUserId(req));
  }

  @Post('join')
  joinRoom(@Body('roomId') roomId: string, @Req() req: RequestWithUser) {
    return this.roomsService.joinRoom(roomId, this.getUserId(req));
  }

  @Post(':roomId/leave')
  leaveRoom(@Param('roomId') roomId: string, @Req() req: RequestWithUser) {
    return this.roomsService.leaveRoom(roomId, this.getUserId(req));
  }

  @Get('search')
  searchRoomsByTags(@Query('tags') tags: string) {
    const tagArray = tags
      ? tags.split(',').map((t) => t.trim().toLowerCase())
      : [];

    return this.roomsService.searchRoomsByTags(tagArray);
  }

  @Delete(':roomId')
  deleteRoom(@Param('roomId') roomId: string, @Req() req: RequestWithUser) {
    return this.roomsService.deleteRoom(roomId, this.getUserId(req));
  }

  @Get(':roomId/messages')
  getRoomMessages(@Param('roomId') roomId: string) {
    return this.roomsService.getRoomMessages(roomId);
  }
}
