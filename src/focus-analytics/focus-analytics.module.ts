import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FocusAnalyticsController } from './focus-analytics.controller';
import { FocusAnalyticsService } from './focus-analytics.service';

@Module({
  imports: [PrismaModule],
  controllers: [FocusAnalyticsController],
  providers: [FocusAnalyticsService],
  exports: [FocusAnalyticsService],
})
export class FocusAnalyticsModule {}
