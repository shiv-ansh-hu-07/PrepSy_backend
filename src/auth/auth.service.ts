import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  private readonly attendanceTimeZone = 'Asia/Kolkata';

  private getDateKeyInTimeZone(date: Date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.attendanceTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private shiftDateKey(dateKey: string, days: number) {
    const [yearText, monthText, dayText] = dateKey.split('-');
    const shifted = new Date(
      Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + days),
    );
    return shifted.toISOString().slice(0, 10);
  }

  private async getAttendanceStreak(userId: string) {
    const attendance = await this.prisma.roomAttendance.findMany({
      where: { userId },
      select: { joinedAt: true },
      orderBy: { joinedAt: 'desc' },
    });

    if (attendance.length === 0) {
      return 0;
    }

    const attendanceDays = new Set(
      attendance.map(({ joinedAt }) => this.getDateKeyInTimeZone(joinedAt)),
    );
    const todayKey = this.getDateKeyInTimeZone(new Date());

    let streak = 0;
    let cursor = todayKey;

    while (attendanceDays.has(cursor)) {
      streak += 1;
      cursor = this.shiftDateKey(cursor, -1);
    }

    return streak;
  }

  // =========================
  // HELPER: SIGN JWT (STANDARD)
  // =========================
  private signJwt(user: User) {
    return this.jwt.sign({
      sub: user.id,
      email: user.email,
    });
  }

  // =========================
  // REGISTER (EMAIL/PASSWORD)
  // =========================
  async register(email: string, password: string, name?: string) {
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new BadRequestException('User already exists');

    const hashed = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashed,
        name: name ?? '',
        provider: 'local',
      },
    });

    return {
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
  }

  // =========================
  // LOGIN (EMAIL/PASSWORD)
  // =========================
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    const token = this.signJwt(user);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
  }

  // =========================
  // CURRENT USER
  // =========================
  async me(userId: string) {
    if (!userId) {
      throw new UnauthorizedException('Invalid token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const attendanceStreak = await this.getAttendanceStreak(user.id);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      attendanceStreak,
    };
  }

  // =========================
  // GOOGLE OAUTH LOGIN
  // =========================
  async oauthLogin(
    provider: 'google',
    profile: { email: string; providerId: string; name?: string },
  ) {
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { provider, providerId: profile.providerId },
          { email: profile.email },
        ],
      },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: profile.email,
          name: profile.name ?? '',
          provider,
          providerId: profile.providerId,
          password: null, // important for Google users
        },
      });
    }

    const token = this.signJwt(user);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
  }
}
