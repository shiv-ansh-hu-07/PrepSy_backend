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
    roomMember: {
      deleteMany: jest.Mock;
    };
    message: {
      deleteMany: jest.Mock;
    };
    pomodoro: {
      deleteMany: jest.Mock;
    };
    roomAttendance: {
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
      roomMember: {
        deleteMany: jest.fn(),
      },
      message: {
        deleteMany: jest.fn(),
      },
      pomodoro: {
        deleteMany: jest.fn(),
      },
      roomAttendance: {
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

    await expect(
      service.deleteRoom('focus-room', 'user-1'),
    ).resolves.toEqual({ success: true });

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
});
