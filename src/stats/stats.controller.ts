import { Controller, Get } from '@nestjs/common';

@Controller('api')
export class StatsController {

  @Get('stats')
  getStats() {
    return {
      stats: {
        activeRooms: Math.floor(10 + Math.random() * 40),
        activeUsers: Math.floor(50 + Math.random() * 500),
        avgFocus: Math.floor(50 + Math.random() * 40)
      },
      room: {
        focus: Math.floor(60 + Math.random() * 30),
        participants: Math.floor(2 + Math.random() * 10)
      }
    };
  }
}
