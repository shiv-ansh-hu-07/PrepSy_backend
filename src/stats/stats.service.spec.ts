import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { StatsService } from './stats.service';

describe('StatsService', () => {
  let service: StatsService;
  let prisma: {
    room: { findMany: jest.Mock };
    roomAttendance: { findMany: jest.Mock };
    pomodoro: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-10T10:00:00.000Z'));

    prisma = {
      room: { findMany: jest.fn() },
      roomAttendance: { findMany: jest.fn() },
      pomodoro: { findMany: jest.fn() },
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
    jest.useRealTimers();
  });

  it('returns real aggregated stats from rooms, attendance, and pomodoro state', async () => {
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
      { userId: 'user-1' },
      { userId: 'user-2' },
      { userId: 'user-1' },
    ]);
    prisma.pomodoro.findMany.mockResolvedValue([
      { roomId: 'live-room', running: true, mode: 'work' },
      { roomId: 'upcoming-room', running: false, mode: 'break' },
    ]);

    const result = await service.getStats();

    expect(result).toEqual({
      stats: {
        activeRooms: 1,
        activeUsers: 2,
        avgFocus: 100,
      },
    });
  });
});
