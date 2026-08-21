import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';
import { FocusAnalyticsService } from './focus-analytics.service';

@Controller('focus-analytics')
@UseGuards(JwtAuthGuard)
export class FocusAnalyticsController {
  constructor(private readonly svc: FocusAnalyticsService) {}

  private uid(req: RequestWithUser) {
    const id = req?.user?.id || req?.user?.sub;
    if (!id) throw new UnauthorizedException('Invalid token');
    return id;
  }

  @Post()
  save(@Req() req: RequestWithUser, @Body() body: any) {
    return this.svc.save(this.uid(req), body);
  }

  @Get('summary')
  summary(@Req() req: RequestWithUser) {
    return this.svc.getSummary(this.uid(req));
  }

  @Get('insight')
  insight(@Req() req: RequestWithUser) {
    return this.svc.getInsight(this.uid(req));
  }

  @Get('room/:roomId')
  byRoom(@Req() req: RequestWithUser, @Param('roomId') roomId: string) {
    return this.svc.getLatestForRoom(this.uid(req), roomId);
  }
}
