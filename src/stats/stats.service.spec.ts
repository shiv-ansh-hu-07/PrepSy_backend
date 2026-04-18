import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { StatsService } from './stats.service';

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
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatsService,
        {
          provide: PrismaService,
          useValue: prisma,
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

  it('returns real aggregated stats from rooms and attendance timing', async () => {
    prisma.room.findMany.mockResolvedValue([
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
    prisma.roomAttendance.findMany.mockResolvedValue([
      {
        roomId: 'live-room',
        userId: 'user-1',
        joinedAt: new Date('2026-04-10T09:30:00.000Z'),
        leftAt: null,
      },
      {
        roomId: 'live-room',
        userId: 'user-2',
        joinedAt: new Date('2026-04-10T09:00:00.000Z'),
        leftAt: null,
      },
      {
        roomId: 'live-room',
        userId: 'user-1',
        joinedAt: new Date('2026-04-10T09:45:00.000Z'),
        leftAt: new Date('2026-04-10T10:00:00.000Z'),
      },
    ]);

    const result = await service.getStats();

    expect(result).toEqual({
      stats: {
        activeRooms: 1,
        activeUsers: 2,
        avgFocus: 35,
        avgFocusLabel: '35m',
      },
    });
  });
});
