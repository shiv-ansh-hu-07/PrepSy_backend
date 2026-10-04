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
  | 'id'
  | 'email'
  | 'name'
  | 'password'
  | 'provider'
  | 'providerId'
  | 'loginStreak'
  | 'lastLoginAt'
> & {
  streakDisabled: boolean;
  profile?: {
    avatarUrl: string | null;
    hasSeenTour?: boolean;
  } | null;
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

  // Case-insensitive so "A@x.com" and "a@x.com" are one account (older rows
  // may have been stored with mixed case).
  private async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    const clean = (email || '').trim();
    if (!clean) return null;
    return this.findUserWithProfile({
      where: { email: { equals: clean, mode: 'insensitive' } },
      multiple: true,
    });
  }

  private async findUserById(userId: string): Promise<AuthUserRecord | null> {
    return this.findUserWithProfile({ where: { id: userId } });
  }

  private async findOauthUser(
    provider: 'google',
    profile: { email: string; providerId: string; name?: string },
  ): Promise<AuthUserRecord | null> {
    return this.findUserWithProfile({
      where: {
        OR: [
          { provider, providerId: profile.providerId },
          { email: { equals: profile.email.trim(), mode: 'insensitive' } },
        ],
      },
      multiple: true,
    });
  }

  // Fetches the user and their avatar in a single round trip (a join)
  // instead of two sequential queries — this sits on the login and
  // /auth/me hot paths, so the extra round trip was pure added latency.
  private async findUserWithProfile(options: {
    where: Prisma.UserWhereUniqueInput | Prisma.UserWhereInput;
    multiple?: boolean;
  }): Promise<AuthUserRecord | null> {
    const { where, multiple } = options;
    const include = {
      profile: { select: { avatarUrl: true, hasSeenTour: true } },
    } as const;

    try {
      return multiple
        ? await this.prisma.user.findFirst({ where, include })
        : await this.prisma.user.findUnique({
            where: where as Prisma.UserWhereUniqueInput,
            include,
          });
    } catch (error) {
      if (!this.isProfileStorageUnavailable(error)) {
        throw error;
      }

      const user = multiple
        ? await this.prisma.user.findFirst({ where })
        : await this.prisma.user.findUnique({
            where: where as Prisma.UserWhereUniqueInput,
          });
      return user ? { ...user, profile: null } : null;
    }
  }

  private isProfileStorageUnavailable(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2021', 'P2022'].includes(error.code)
    );
  }

  // Returns 0 if the last completed session was 2+ days ago (streak expired).
  private getEffectiveStreak(user: {
    loginStreak: number;
    lastLoginAt: Date | null;
  }): number {
    if (!user.lastLoginAt) return 0;
    const now = new Date();
    const todayKey = this.getDateKeyInTimeZone(now);
    const yesterdayKey = this.shiftDateKey(todayKey, -1);
    const lastKey = this.getDateKeyInTimeZone(user.lastLoginAt);
    return lastKey === todayKey || lastKey === yesterdayKey
      ? user.loginStreak
      : 0;
  }

  private async recordDailyLogin(
    user: AuthUserRecord,
  ): Promise<AuthUserRecord> {
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

    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        loginStreak: nextStreak,
        lastLoginAt: now,
      },
    });
  }

  private async applyGuestStreakDisable(
    user: AuthUserRecord,
    disableStreak?: boolean,
  ) {
    if (!disableStreak || user.streakDisabled) {
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

  private async createLocalUser(
    email: string,
    hashedPassword: string,
    name?: string,
  ) {
    return this.prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name ?? '',
        provider: 'local',
      },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });
  }

  private async createOauthUser(
    provider: 'google',
    profile: { email: string; providerId: string; name?: string },
  ): Promise<AuthUserRecord> {
    const user = await this.prisma.user.create({
      data: {
        email: profile.email,
        name: profile.name ?? '',
        provider,
        providerId: profile.providerId,
        password: null,
      },
    });
    return { ...user, profile: null };
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
    email = (typeof email === 'string' ? email : '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new BadRequestException('Please enter a valid email address');
    }
    // bcrypt only uses the first 72 bytes, so cap there rather than silently truncate.
    if (
      typeof password !== 'string' ||
      password.length < 8 ||
      Buffer.byteLength(password) > 72
    ) {
      throw new BadRequestException('Password must be 8-72 characters');
    }
    name = typeof name === 'string' ? name.trim().slice(0, 80) : undefined;
    const exists = await this.findUserByEmail(email);
    if (exists) throw new BadRequestException('User already exists');

    const hashed = await bcrypt.hash(password, 10);

    const user = await this.createLocalUser(email, hashed, name);

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
    void disableStreak;
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new UnauthorizedException('Invalid email or password');
    }
    const existingUser = await this.findUserByEmail(email);
    if (!existingUser || !existingUser.password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(password, existingUser.password);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    const user = existingUser;

    const token = this.signJwt(user);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        attendanceStreak: this.getEffectiveStreak(user),
        avatarUrl: user.profile?.avatarUrl || null,
        hasSeenTour: user.profile?.hasSeenTour ?? false,
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

    return {
      id: existingUser.id,
      email: existingUser.email,
      name: existingUser.name,
      attendanceStreak: this.getEffectiveStreak(existingUser),
      avatarUrl: existingUser.profile?.avatarUrl || null,
      hasSeenTour: existingUser.profile?.hasSeenTour ?? false,
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
    void disableStreak;
    let user = await this.findOauthUser(provider, profile);

    if (!user) {
      user = await this.createOauthUser(provider, profile);
    }

    if (!user) {
      throw new UnauthorizedException('Unable to create or load user');
    }

    const token = this.signJwt(user);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        attendanceStreak: this.getEffectiveStreak(user),
        avatarUrl: user.profile?.avatarUrl || null,
        hasSeenTour: user.profile?.hasSeenTour ?? false,
      },
    };
  }
}
