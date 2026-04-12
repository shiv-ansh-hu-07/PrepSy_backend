import { Controller, Get } from '@nestjs/common';
import { StatsService } from './stats.service';

@Controller('api')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('stats')
  getStats() {
    return this.statsService.getStats();
  }
}
