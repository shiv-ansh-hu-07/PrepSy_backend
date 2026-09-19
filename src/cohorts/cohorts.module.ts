import { Module } from '@nestjs/common';
import { CohortsController } from './cohorts.controller';
import { CohortsService } from './cohorts.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailService } from '../email/email.service';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [PrismaModule, S3Module],
  controllers: [CohortsController],
  providers: [CohortsService, EmailService],
})
export class CohortsModule {}
