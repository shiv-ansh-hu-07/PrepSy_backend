import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';
import { OptionalJwtAuthGuard } from './optional-jwt.guard';
import { AnalyticsService } from './analytics.service';
import type { TrackEventInput } from './analytics.dto';

@Controller('events')
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  private uid(req: RequestWithUser): string | null {
    return req?.user?.id || req?.user?.sub || null;
  }

  // Accepts anonymous requests (pre-signup) and attributes to the user when a
  // valid token is present. 202 = accepted, fire-and-forget from the client.
  @Post()
  @HttpCode(202)
  @UseGuards(OptionalJwtAuthGuard)
  track(@Req() req: RequestWithUser, @Body() body: TrackEventInput) {
    return this.svc.track(this.uid(req), body);
  }

  @Post('batch')
  @HttpCode(202)
  @UseGuards(OptionalJwtAuthGuard)
  trackBatch(
    @Req() req: RequestWithUser,
    @Body() body: { events: TrackEventInput[] },
  ) {
    return this.svc.trackBatch(this.uid(req), body?.events || []);
  }

  // Founder-only metrics. Fail-closed: access is granted ONLY to emails listed
  // in ANALYTICS_ADMIN_EMAILS (comma-separated). If the env is unset/empty, or
  // the caller's email isn't listed, access is denied — nobody gets in by default.
  @Get('summary')
  @UseGuards(JwtAuthGuard)
  summary(@Req() req: RequestWithUser) {
    const allow = (process.env.ANALYTICS_ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const email = (req?.user?.email || '').toLowerCase();
    if (!allow.length || !email || !allow.includes(email)) {
      throw new ForbiddenException('Not authorized for analytics');
    }
    return this.svc.getSummary();
  }
}
