import {
  Controller,
  Get,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { StatsService } from './stats.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';

@Controller('api')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  private getUserId(req: RequestWithUser) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Invalid user token');
    }
    return userId;
  }

  @Get('stats')
  getStats() {
    return this.statsService.getStats();
  }

  @Get('analytics/me')
  @UseGuards(JwtAuthGuard)
  getMyAnalytics(@Req() req: RequestWithUser) {
    return this.statsService.getUserAnalytics(this.getUserId(req));
  }
}
