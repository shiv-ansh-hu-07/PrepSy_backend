import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { RoomsModule } from './rooms/rooms.module';
import { StatsModule } from './stats/stats.module';
import { LivekitController } from "./livekit/livekit.controller";
import { MessagesModule } from './messages/messages.module';
import { ScheduleModule } from '@nestjs/schedule';
import { CommunityModule } from './community/community.module';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    RoomsModule,
    StatsModule,
    MessagesModule,
    CommunityModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController, LivekitController],
  providers: [AppService],
})
export class AppModule {}
