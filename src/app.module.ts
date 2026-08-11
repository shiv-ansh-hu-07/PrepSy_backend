import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { RoomsModule } from './rooms/rooms.module';
import { StatsModule } from './stats/stats.module';
import { LivekitController } from './livekit/livekit.controller';
import { MessagesModule } from './messages/messages.module';
import { ScheduleModule } from '@nestjs/schedule';
import { CommunityModule } from './community/community.module';
import { PresenceModule } from './presence/presence.module';
import { ProfilesModule } from './profiles/profiles.module';
import { FocusAnalyticsModule } from './focus-analytics/focus-analytics.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PlaylistsModule } from './playlists/playlists.module';
import { CohortsModule } from './cohorts/cohorts.module';
import { FriendsModule } from './friends/friends.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    RoomsModule,
    StatsModule,
    MessagesModule,
    CommunityModule,
    PresenceModule,
    ProfilesModule,
    FocusAnalyticsModule,
    NotificationsModule,
    PlaylistsModule,
    CohortsModule,
    FriendsModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController, LivekitController, HealthController],
  providers: [AppService],
})
export class AppModule {}
