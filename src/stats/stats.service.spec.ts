import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { StatsService } from './stats.service';
import { PresenceService } from '../presence/presence.service';

function restoreEnvValue(key: string, value?: string) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

describe('StatsService', () => {
  let service: StatsService;
  let liveKitEnv: {
    apiKey?: string;
    apiSecret?: string;
    wsUrl?: string;
  };
  let prisma: {
    room: { findMany: jest.Mock };
    roomAttendance: { findMany: jest.Mock };
    roomMember: { findMany: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let presenceService: {
    getActiveUserIds: jest.Mock;
  };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-10T10:00:00.000Z'));
    liveKitEnv = {
      apiKey: process.env.LIVEKIT_API_KEY,
      apiSecret: process.env.LIVEKIT_API_SECRET,
      wsUrl: process.env.LIVEKIT_WS_URL,
    };
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_WS_URL;

    prisma = {
      room: { findMany: jest.fn() },
      roomAttendance: { findMany: jest.fn() },
      roomMember: { findMany: jest.fn() },
      user: { findUnique: jest.fn() },
    };
    presenceService = {
      getActiveUserIds: jest.fn().mockReturnValue(new Set()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatsService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: PresenceService,
          useValue: presenceService,
        },
      ],
    }).compile();

    service = module.get<StatsService>(StatsService);
  });

  afterEach(() => {
    restoreEnvValue('LIVEKIT_API_KEY', liveKitEnv.apiKey);
    restoreEnvValue('LIVEKIT_API_SECRET', liveKitEnv.apiSecret);
    restoreEnvValue('LIVEKIT_WS_URL', liveKitEnv.wsUrl);
    jest.useRealTimers();
  });

  it('returns real aggregated stats with historical average room timing', async () => {
    prisma.room.findMany.mockResolvedValueOnce([
      {
        roomId: 'live-room',
        startTime: new Date('2026-04-10T09:30:00.000Z'),
        durationMinutes: 90,
        isRecurring: false,
        recurrenceType: null,
        recurrenceEndDate: null,
      },
      {
        roomId: 'upcoming-room',
        startTime: new Date('2026-04-10T11:30:00.000Z'),
        durationMinutes: 60,
        isRecurring: false,
        recurrenceType: null,
        recurrenceEndDate: null,
      },
    ]);
    prisma.roomAttendance.findMany.mockResolvedValueOnce([
      {
        roomId: 'live-room',
        userId: 'user-1',
      },
      {
        roomId: 'live-room',
        userId: 'user-2',
      },
      {
        roomId: 'live-room',
        userId: 'user-1',
      },
    ]);
    prisma.room.findMany.mockResolvedValueOnce([
      { roomId: 'past-room-1', durationMinutes: 120 },
      { roomId: 'past-room-2', durationMinutes: 150 },
      { roomId: 'unused-room', durationMinutes: 60 },
    ]);
    prisma.roomAttendance.findMany.mockResolvedValueOnce([
      { roomId: 'past-room-1' },
      { roomId: 'past-room-2' },
    ]);

    const result = await service.getStats();

    expect(result).toEqual({
      stats: {
        activeRooms: 1,
        activeUsers: 2,
        avgFocus: 135,
        avgFocusLabel: '2h 15m',
      },
    });
  });

  it('returns real user analytics from attendance, room, and topic records', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Ariun',
      email: 'ariun@example.com',
    });
    prisma.roomAttendance.findMany.mockResolvedValue([
      {
        id: 'attendance-1',
        roomId: 'algebra-room',
        joinedAt: new Date('2026-04-08T04:00:00.000Z'),
        leftAt: new Date('2026-04-08T05:30:00.000Z'),
        room: {
          roomId: 'algebra-room',
          name: 'Algebra Focus',
          tags: ['math', 'dsa'],
          durationMinutes: 30,
        },
      },
      {
        id: 'attendance-2',
        roomId: 'web-room',
        joinedAt: new Date('2026-04-09T04:00:00.000Z'),
        leftAt: new Date('2026-04-09T05:00:00.000Z'),
        room: {
          roomId: 'web-room',
          name: 'React Prep',
          tags: ['react'],
          durationMinutes: 40,
        },
      },
      {
        id: 'attendance-3',
        roomId: 'web-room',
        joinedAt: new Date('2026-04-10T04:00:00.000Z'),
        leftAt: null,
        room: {
          roomId: 'web-room',
          name: 'React Prep',
          tags: ['react'],
          durationMinutes: 120,
        },
      },
    ]);
    prisma.roomMember.findMany.mockResolvedValue([
      {
        joinedAt: new Date('2026-04-09T03:30:00.000Z'),
        room: {
          roomId: 'web-room',
          name: 'React Prep',
          tags: ['react'],
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
        },
      },
      {
        joinedAt: new Date('2026-04-08T03:30:00.000Z'),
        room: {
          roomId: 'algebra-room',
          name: 'Algebra Focus',
          tags: ['math', 'dsa'],
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
        },
      },
    ]);

    const result = await service.getUserAnalytics('user-1');

    expect(result.analytics.summary).toMatchObject({
      totalFocusMinutes: 150,
      totalFocusLabel: '2h 30m',
      liveFocusMinutes: 360,
      liveFocusLabel: '6h',
      sessionsJoined: 3,
      sessionsCompleted: 2,
      roomsJoined: 2,
      topicsStudied: 3,
      completedStudyDays: 2,
      currentStreakDays: 2,
      bestStreakDays: 2,
      studiedDaysThisWeek: 2,
      consistencyScore: 29,
    });
    expect(result.analytics.weeklyFocus).toEqual([
      { date: '2026-04-06', minutes: 0 },
      { date: '2026-04-07', minutes: 0 },
      { date: '2026-04-08', minutes: 90 },
      { date: '2026-04-09', minutes: 60 },
      { date: '2026-04-10', minutes: 0 },
      { date: '2026-04-11', minutes: 0 },
      { date: '2026-04-12', minutes: 0 },
    ]);
    expect(result.analytics.rooms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roomId: 'web-room',
          minutes: 60,
          liveMinutes: 360,
          sessions: 2,
          completedSessions: 1,
        }),
      ]),
    );
    expect(result.analytics.topics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'react',
          minutes: 60,
          sessions: 1,
        }),
      ]),
    );
    expect(result.analytics.achievements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'first-session',
          achieved: true,
        }),
        expect.objectContaining({
          id: 'seven-day-streak',
          achieved: false,
          progress: 2,
        }),
      ]),
    );
  });
});
