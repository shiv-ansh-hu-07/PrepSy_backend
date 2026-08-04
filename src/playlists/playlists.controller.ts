import { Controller, Post, Get, Param, Body, UseGuards } from '@nestjs/common';
import { PlaylistsService } from './playlists.service';
import type { ScheduleDto } from './playlists.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

@Controller('playlists')
@UseGuards(JwtAuthGuard)
export class PlaylistsController {
  constructor(private playlists: PlaylistsService) {}

  @Post('analyze')
  analyze(@Body('url') url: string) {
    return this.playlists.analyze(url);
  }

  @Post(':id/schedule')
  schedule(@Param('id') id: string, @Body() body: ScheduleDto) {
    return this.playlists.schedule(id, body);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.playlists.getById(id);
  }
}
