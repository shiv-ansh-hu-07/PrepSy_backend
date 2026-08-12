import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FriendsController } from './friends.controller';
import { FriendsService } from './friends.service';
import { DmGateway } from './dm.gateway';
import { PrismaModule } from '../prisma/prisma.module';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [PrismaModule, S3Module],
  controllers: [FriendsController],
  providers: [FriendsService, DmGateway, JwtService],
  exports: [FriendsService],
})
export class FriendsModule {}
