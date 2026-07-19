import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { S3Module } from '../s3/s3.module';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [PrismaModule, S3Module],
  controllers: [ProfilesController],
  providers: [ProfilesService],
})
export class ProfilesModule {}
