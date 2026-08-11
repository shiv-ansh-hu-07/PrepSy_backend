import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
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
