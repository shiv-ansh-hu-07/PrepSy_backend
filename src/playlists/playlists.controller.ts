import { Throttle } from '@nestjs/throttler';
import { Controller, Post, Get, Param, Body, UseGuards } from '@nestjs/common';
import { PlaylistsService } from './playlists.service';
import type { ScheduleDto } from './playlists.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

@Controller('playlists')
@UseGuards(JwtAuthGuard)
export class PlaylistsController {
  constructor(private playlists: PlaylistsService) {}

  // Calls YouTube + the LLM: tighter limit protects both quotas.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('analyze')
  analyze(@Body('url') url: string) {
    return this.playlists.analyze(url);
  }

  // Calls YouTube + the LLM: tighter limit protects both quotas.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/schedule')
  schedule(@Param('id') id: string, @Body() body: ScheduleDto) {
    return this.playlists.schedule(id, body);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.playlists.getById(id);
  }
}
