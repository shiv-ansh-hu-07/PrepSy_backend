import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
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
import { AnalyticsModule } from './analytics/analytics.module';
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
    AnalyticsModule,
    ScheduleModule.forRoot(),
    // Global rate limiting. The default is deliberately generous so normal
    // browsing (and a whole cohort behind one campus NAT) is never throttled;
    // auth routes tighten this with their own @Throttle for brute-force defence.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
  ],
  controllers: [AppController, LivekitController, HealthController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
