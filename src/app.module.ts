import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { RoomsModule } from './rooms/rooms.module';
import { StatsModule } from './stats/stats.module';
import { LivekitController } from "./livekit/livekit.controller";

@Module({
  imports: [AuthModule, PrismaModule, RoomsModule, StatsModule,],
  controllers: [AppController, LivekitController],
  providers: [AppService],
})
export class AppModule {}
