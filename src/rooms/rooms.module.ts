import { Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RoomsGateway } from './rooms.gateway';
import { JwtService } from '@nestjs/jwt';
import { EmailService } from '../email/email.service';

@Module({
  imports: [PrismaModule],
  controllers: [RoomsController],
  providers: [RoomsService, RoomsGateway, JwtService, EmailService],
})
export class RoomsModule {}
