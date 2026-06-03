import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
@UseGuards(JwtAuthGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  private getUserId(req: RequestWithUser) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Invalid user token');
    }
    return userId;
  }

  @Get('me')
  getMyProfile(@Req() req: RequestWithUser) {
    return this.profilesService.getMyProfile(this.getUserId(req));
  }

  @Put('me')
  updateMyProfile(@Req() req: RequestWithUser, @Body() body: unknown) {
    return this.profilesService.updateMyProfile(this.getUserId(req), body);
  }
}
