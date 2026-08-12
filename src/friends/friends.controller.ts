import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';
import { FriendsService } from './friends.service';

@Controller('friends')
@UseGuards(JwtAuthGuard)
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  private uid(req: RequestWithUser) {
    const id = req?.user?.id || req?.user?.sub;
    if (!id) throw new UnauthorizedException('Invalid user token');
    return id;
  }

  @Get()
  list(@Req() req: RequestWithUser) {
    return this.friends.listFriends(this.uid(req));
  }

  @Get('requests')
  requests(@Req() req: RequestWithUser) {
    return this.friends.listIncomingRequests(this.uid(req));
  }

  @Get('counts')
  counts(@Req() req: RequestWithUser) {
    return this.friends.counts(this.uid(req));
  }

  @Get('status/:userId')
  status(@Param('userId') userId: string, @Req() req: RequestWithUser) {
    return this.friends
      .statusWith(this.uid(req), userId)
      .then((status) => ({ status }));
  }

  @Get('threads')
  threads(@Req() req: RequestWithUser) {
    return this.friends.listThreads(this.uid(req));
  }

  @Get(':userId/messages')
  conversation(@Param('userId') userId: string, @Req() req: RequestWithUser) {
    return this.friends.getConversation(this.uid(req), userId);
  }

  @Post(':userId/messages')
  sendMessage(
    @Param('userId') userId: string,
    @Body('text') text: string,
    @Body('roomId') roomId: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    return this.friends.sendMessage(this.uid(req), userId, text, roomId);
  }

  @Post(':userId/media')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    }),
  )
  sendMedia(
    @Param('userId') userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: RequestWithUser,
  ) {
    if (!file) throw new BadRequestException('No file provided.');
    return this.friends.sendMedia(this.uid(req), userId, file);
  }

  @Post(':userId/typing')
  typing(@Param('userId') userId: string, @Req() req: RequestWithUser) {
    return this.friends.setTyping(this.uid(req), userId);
  }

  @Get(':userId/typing')
  typingState(@Param('userId') userId: string, @Req() req: RequestWithUser) {
    return this.friends.isTyping(this.uid(req), userId);
  }

  @Post('request')
  request(@Body('userId') userId: string, @Req() req: RequestWithUser) {
    return this.friends.sendRequest(this.uid(req), userId);
  }

  @Post('respond')
  respond(
    @Body('userId') userId: string,
    @Body('accept') accept: boolean,
    @Req() req: RequestWithUser,
  ) {
    return this.friends.respond(this.uid(req), userId, accept !== false);
  }

  @Delete(':userId')
  remove(@Param('userId') userId: string, @Req() req: RequestWithUser) {
    return this.friends.remove(this.uid(req), userId);
  }
}
