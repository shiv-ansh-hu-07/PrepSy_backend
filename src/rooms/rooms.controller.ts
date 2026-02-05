import { Controller, Get, Post, Body, Req, UseGuards, Query } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { Delete, Param } from '@nestjs/common';


@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private roomsService: RoomsService) { }

  @Post('create')
  createRoom(
    @Body('name') name: string,
    @Body('roomId') roomId: string,
    @Body('description') description: string,
    @Body('tags') tags: string[],
    @Body('visibility') visibility: 'PUBLIC' | 'PRIVATE',
    @Req() req: any
  ) {
    return this.roomsService.createRoom(
      name,
      roomId,
      description,
      tags,
      visibility,
      req.user.id
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
  getMyRooms(@Req() req: any) {
    return this.roomsService.getMyRooms(req.user.id);
  }

  @Post('join')
  joinRoom(@Body('roomId') roomId: string, @Req() req: any) {
    return this.roomsService.joinRoom(roomId, req.user.id);
  }

  @Get('search')
  searchRoomsByTags(@Query('tags') tags: string) {
    const tagArray = tags
      ? tags.split(',').map(t => t.trim().toLowerCase())
      : [];

    return this.roomsService.searchRoomsByTags(tagArray);
  }

  @Delete(':roomId')
  deleteRoom(
    @Param('roomId') roomId: string,
    @Req() req: any
  ) {
    return this.roomsService.deleteRoom(roomId, req.user.id);
  }

  @Get(':roomId/messages')
  getRoomMessages(@Param('roomId') roomId: string) {
    return this.roomsService.getRoomMessages(roomId);
  }
}
