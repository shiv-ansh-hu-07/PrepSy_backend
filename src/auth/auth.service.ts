import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';

type AuthUserRecord = Pick<
  User,
  'id' | 'email' | 'name' | 'password' | 'provider' | 'providerId' | 'loginStreak' | 'lastLoginAt'
> & {
  streakDisabled: boolean;
};

const authUserBaseSelect = {
  id: true,
  email: true,
  name: true,
  password: true,
  provider: true,
  providerId: true,
  loginStreak: true,
  lastLoginAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class AuthService {
  private streakDisabledColumnAvailable: boolean | null = null;

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

  private async hasStreakDisabledColumn() {
    if (this.streakDisabledColumnAvailable !== null) {
      return this.streakDisabledColumnAvailable;
    }

    const rows = await this.prisma.$queryRaw<{ exists: string | null }[]>(
      Prisma.sql`
        SELECT 1 AS "exists"
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'User'
          AND column_name = 'streakDisabled'
        LIMIT 1
      `,
    );

    this.streakDisabledColumnAvailable = rows.length > 0;
    return this.streakDisabledColumnAvailable;
  }

  private async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    const canReadStreakDisabled = await this.hasStreakDisabledColumn();

    if (canReadStreakDisabled) {
      return this.prisma.user.findUnique({ where: { email } });
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: authUserBaseSelect,
    });

    return user ? { ...user, streakDisabled: false } : null;
  }

  private async findUserById(userId: string): Promise<AuthUserRecord | null> {
    const canReadStreakDisabled = await this.hasStreakDisabledColumn();

    if (canReadStreakDisabled) {
      return this.prisma.user.findUnique({ where: { id: userId } });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: authUserBaseSelect,
    });

    return user ? { ...user, streakDisabled: false } : null;
  }

  private async findOauthUser(
    provider: 'google',
    profile: { email: string; providerId: string; name?: string },
  ): Promise<AuthUserRecord | null> {
    const canReadStreakDisabled = await this.hasStreakDisabledColumn();

    if (canReadStreakDisabled) {
      return this.prisma.user.findFirst({
        where: {
          OR: [
            { provider, providerId: profile.providerId },
            { email: profile.email },
          ],
        },
      });
    }

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { provider, providerId: profile.providerId },
          { email: profile.email },
        ],
      },
      select: authUserBaseSelect,
    });

    return user ? { ...user, streakDisabled: false } : null;
  }

  private getCurrentLoginStreak(user: Pick<AuthUserRecord, 'loginStreak' | 'lastLoginAt' | 'streakDisabled'>) {
    if (user.streakDisabled) {
      return 0;
    }

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

  private async recordDailyLogin(user: AuthUserRecord): Promise<AuthUserRecord> {
    if (user.streakDisabled) {
      return user;
    }

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

    const canReadStreakDisabled = await this.hasStreakDisabledColumn();

    if (canReadStreakDisabled) {
      return this.prisma.user.update({
        where: { id: user.id },
        data: {
          loginStreak: nextStreak,
          lastLoginAt: now,
        },
      });
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        loginStreak: nextStreak,
        lastLoginAt: now,
      },
      select: authUserBaseSelect,
    });

    return {
      ...updatedUser,
      streakDisabled: false,
    };
  }

  private async applyGuestStreakDisable(user: AuthUserRecord, disableStreak?: boolean) {
    if (
      !disableStreak ||
      user.streakDisabled ||
      !(await this.hasStreakDisabledColumn())
    ) {
      return user;
    }

    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        streakDisabled: true,
        loginStreak: 0,
        lastLoginAt: null,
      },
    });
  }

  // =========================
  // HELPER: SIGN JWT (STANDARD)
  // =========================
  private signJwt(user: Pick<AuthUserRecord, 'id' | 'email'>) {
    return this.jwt.sign({
      sub: user.id,
      email: user.email,
    });
  }

  // =========================
  // REGISTER (EMAIL/PASSWORD)
  // =========================
  async register(email: string, password: string, name?: string) {
    const exists = await this.findUserByEmail(email);
    if (exists) throw new BadRequestException('User already exists');

    const hashed = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashed,
        name: name ?? '',
        provider: 'local',
      },
      select: {
        id: true,
        email: true,
        name: true,
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
  async login(email: string, password: string, disableStreak = false) {
    const existingUser = await this.findUserByEmail(email);
    if (!existingUser || !existingUser.password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(password, existingUser.password);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    let user = await this.applyGuestStreakDisable(existingUser, disableStreak);
    user = await this.recordDailyLogin(user);

    const token = this.signJwt(user);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        streakDisabled: user.streakDisabled,
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

    const existingUser = await this.findUserById(userId);

    if (!existingUser) {
      throw new UnauthorizedException('User not found');
    }

    const user = await this.recordDailyLogin(existingUser);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      attendanceStreak: this.getCurrentLoginStreak(user),
      streakDisabled: user.streakDisabled,
    };
  }

  // =========================
  // GOOGLE OAUTH LOGIN
  // =========================
  async oauthLogin(
    provider: 'google',
    profile: { email: string; providerId: string; name?: string },
    disableStreak = false,
  ) {
    const foundUser = await this.findOauthUser(provider, profile);
    let user = foundUser;

    if (!user) {
      const canWriteStreakDisabled = await this.hasStreakDisabledColumn();
      user = await this.prisma.user.create({
        data: {
          email: profile.email,
          name: profile.name ?? '',
          provider,
          providerId: profile.providerId,
          password: null, // important for Google users
          ...(canWriteStreakDisabled ? { streakDisabled: disableStreak } : {}),
        },
        select: canWriteStreakDisabled
          ? undefined
          : authUserBaseSelect,
      });

      if (!canWriteStreakDisabled && user) {
        user = {
          ...user,
          streakDisabled: false,
        };
      }
    }

    if (!user) {
      throw new UnauthorizedException('Unable to create or load user');
    }

    const oauthUser = user;
    const guestAdjustedUser = await this.applyGuestStreakDisable(
      oauthUser,
      disableStreak,
    );
    const finalUser = await this.recordDailyLogin(guestAdjustedUser);

    const token = this.signJwt(finalUser);

    return {
      token,
      user: {
        id: finalUser.id,
        email: finalUser.email,
        name: finalUser.name,
        streakDisabled: finalUser.streakDisabled,
      },
    };
  }
}
