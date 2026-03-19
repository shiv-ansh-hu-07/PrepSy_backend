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

  private getCurrentLoginStreak(user: Pick<User, 'loginStreak' | 'lastLoginAt'>) {
    if (!user.lastLoginAt) {
      return 0;
    }

    const todayKey = this.getDateKeyInTimeZone(new Date());
    const lastLoginKey = this.getDateKeyInTimeZone(user.lastLoginAt);

    if (lastLoginKey !== todayKey) {
      return 0;
    }

    return user.loginStreak;
  }

  private async recordDailyLogin(user: User) {
    const now = new Date();
    const todayKey = this.getDateKeyInTimeZone(now);
    const lastLoginKey = user.lastLoginAt
      ? this.getDateKeyInTimeZone(user.lastLoginAt)
      : null;

    if (lastLoginKey === todayKey) {
      return user;
    }

    const yesterdayKey = this.shiftDateKey(todayKey, -1);
    const nextStreak = lastLoginKey === yesterdayKey ? user.loginStreak + 1 : 1;

    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        loginStreak: nextStreak,
        lastLoginAt: now,
      },
    });
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
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    user = await this.recordDailyLogin(user);

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

    let user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    user = await this.recordDailyLogin(user);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      attendanceStreak: this.getCurrentLoginStreak(user),
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

    user = await this.recordDailyLogin(user);

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
