import { Test, TestingModule } from '@nestjs/testing';
import { RoomsService } from './rooms.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

describe('RoomsService', () => {
  let service: RoomsService;
  let prisma: {
    room: {
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
    user: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    roomMember: {
      findFirst: jest.Mock;
      create: jest.Mock;
      deleteMany: jest.Mock;
    };
    message: {
      deleteMany: jest.Mock;
    };
    pomodoro: {
      deleteMany: jest.Mock;
    };
    roomAttendance: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      room: {
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      roomMember: {
        findFirst: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      message: {
        deleteMany: jest.fn(),
      },
      pomodoro: {
        deleteMany: jest.fn(),
      },
      roomAttendance: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomsService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: EmailService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<RoomsService>(RoomsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('deletes room attendance before deleting an owned room', async () => {
    prisma.room.findUnique.mockResolvedValue({
      roomId: 'focus-room',
      ownerId: 'user-1',
    });
    prisma.roomMember.deleteMany.mockReturnValue('delete members');
    prisma.message.deleteMany.mockReturnValue('delete messages');
    prisma.pomodoro.deleteMany.mockReturnValue('delete pomodoro');
    prisma.roomAttendance.deleteMany.mockReturnValue('delete attendance');
    prisma.room.delete.mockReturnValue('delete room');
    prisma.$transaction.mockResolvedValue([]);

    await expect(service.deleteRoom('focus-room', 'user-1')).resolves.toEqual({
      success: true,
    });

    expect(prisma.roomAttendance.deleteMany).toHaveBeenCalledWith({
      where: { roomId: 'focus-room' },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith([
      'delete members',
      'delete messages',
      'delete pomodoro',
      'delete attendance',
      'delete room',
    ]);
  });

  it('records a new attendance row when there is no open session today', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-10T10:00:00.000Z'));

    prisma.room.findUnique.mockResolvedValue({
      roomId: 'focus-room',
      name: 'Focus Room',
    });
    prisma.roomMember.findFirst.mockResolvedValue({
      roomId: 'focus-room',
      userId: 'user-1',
    });
    prisma.roomAttendance.findFirst.mockResolvedValue(null);
    prisma.roomAttendance.create.mockResolvedValue({});

    await expect(service.joinRoom('focus-room', 'user-1')).resolves.toEqual({
      success: true,
    });

    expect(prisma.roomAttendance.findFirst).toHaveBeenCalledWith({
      where: {
        roomId: 'focus-room',
        userId: 'user-1',
        joinedAt: expect.objectContaining({
          gte: expect.any(Date),
          lt: expect.any(Date),
        }),
        leftAt: null,
      },
      orderBy: {
        joinedAt: 'desc',
      },
    });
    expect(prisma.roomAttendance.create).toHaveBeenCalledWith({
      data: {
        roomId: 'focus-room',
        userId: 'user-1',
      },
    });

    jest.useRealTimers();
  });

  it('records leave time and returns room session analytics', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-10T10:00:00.000Z'));

    prisma.room.findUnique.mockResolvedValue({
      roomId: 'focus-room',
      name: 'Focus Room',
    });
    prisma.roomAttendance.findFirst.mockResolvedValue({
      id: 'attendance-1',
      roomId: 'focus-room',
      userId: 'user-1',
      joinedAt: new Date('2026-04-10T09:00:00.000Z'),
      leftAt: null,
    });
    prisma.roomAttendance.update.mockResolvedValue({});
    prisma.roomAttendance.findMany
      .mockResolvedValueOnce([
        {
          joinedAt: new Date('2026-04-10T09:00:00.000Z'),
          leftAt: null,
        },
      ])
      .mockResolvedValueOnce([{ userId: 'user-2' }, { userId: 'user-3' }]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      loginStreak: 4,
      lastLoginAt: new Date('2026-04-09T08:30:00.000Z'),
      streakDisabled: false,
    });
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      loginStreak: 5,
      lastLoginAt: new Date('2026-04-10T10:00:00.000Z'),
      streakDisabled: false,
    });

    await expect(service.leaveRoom('focus-room', 'user-1')).resolves.toEqual({
      roomId: 'focus-room',
      roomName: 'Focus Room',
      totalMinutes: 60,
      totalTimeLabel: '1h',
      studiedWithCount: 2,
      streak: 5,
      streakDisabled: false,
      message:
        'Great work today. Rest up, keep the rhythm alive, and come back tomorrow for the next focused session.',
    });
    expect(prisma.roomAttendance.update).toHaveBeenCalledWith({
      where: { id: 'attendance-1' },
      data: { leftAt: new Date('2026-04-10T10:00:00.000Z') },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        loginStreak: 5,
        lastLoginAt: new Date('2026-04-10T10:00:00.000Z'),
      },
      select: {
        id: true,
        loginStreak: true,
        lastLoginAt: true,
        streakDisabled: true,
      },
    });

    jest.useRealTimers();
  });
});
