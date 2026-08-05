import { Module } from '@nestjs/common';
import { CohortsController } from './cohorts.controller';
import { CohortsService } from './cohorts.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailService } from '../email/email.service';

@Module({
  imports: [PrismaModule],
  controllers: [CohortsController],
  providers: [CohortsService, EmailService],
})
export class CohortsModule {}
