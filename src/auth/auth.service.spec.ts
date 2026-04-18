import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    $queryRaw: jest.Mock;
    user: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let jwt: {
    sign: jest.Mock;
  };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-10T10:00:00.000Z'));

    prisma = {
      $queryRaw: jest.fn(),
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    jwt = {
      sign: jest.fn().mockReturnValue('signed-token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: JwtService,
          useValue: jwt,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('registers a local user without touching streak state', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-1',
      email: 'test@prepsy.in',
      name: 'Test User',
    });

    const result = await service.register(
      'test@prepsy.in',
      'super-secret',
      'Test User',
    );

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'test@prepsy.in' },
    });
    expect(prisma.user.create).toHaveBeenCalled();
    expect(result).toEqual({
      message: 'User registered successfully',
      user: {
        id: 'user-1',
        email: 'test@prepsy.in',
        name: 'Test User',
      },
    });
  });

  it('creates and logs in an oauth user without incrementing session streak', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'oauth-1',
      email: 'google@prepsy.in',
      name: 'Google User',
      password: null,
      provider: 'google',
      providerId: 'google-sub',
      loginStreak: 0,
      lastLoginAt: null,
      streakDisabled: false,
    });

    const result = await service.oauthLogin('google', {
      email: 'google@prepsy.in',
      providerId: 'google-sub',
      name: 'Google User',
    });

    expect(prisma.user.findFirst).toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        email: 'google@prepsy.in',
        name: 'Google User',
        provider: 'google',
        providerId: 'google-sub',
        password: null,
      },
    });
    expect(jwt.sign).toHaveBeenCalledWith({
      sub: 'oauth-1',
      email: 'google@prepsy.in',
    });
    expect(result).toEqual({
      token: 'signed-token',
      user: {
        id: 'oauth-1',
        email: 'google@prepsy.in',
        name: 'Google User',
        attendanceStreak: 0,
        streakDisabled: false,
      },
    });
  });
});
