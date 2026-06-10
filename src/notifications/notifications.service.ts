import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function todayISTKey(): string {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  return now.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function yesterdayISTKey(): string {
  const now = new Date(Date.now() + IST_OFFSET_MS - 86400000);
  return now.toISOString().slice(0, 10);
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function dayLabel(dateKey: string): string {
  return new Date(dateKey + 'T12:00:00Z').toLocaleDateString('en-IN', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  // 8:00 PM IST = 14:30 UTC
  @Cron('30 14 * * *')
  async sendStreakRescueEmails() {
    this.logger.log('Running streak rescue cron');
    const today = todayISTKey();
    const yesterday = yesterdayISTKey();

    // Users who completed a session yesterday but not today
    const [studiedYesterday, studiedToday] = await Promise.all([
      this.prisma.roomAttendance.findMany({
        where: {
          leftAt: { not: null },
          joinedAt: {
            gte: new Date(yesterday + 'T00:00:00+05:30'),
            lt: new Date(today + 'T00:00:00+05:30'),
          },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prisma.roomAttendance.findMany({
        where: {
          leftAt: { not: null },
          joinedAt: {
            gte: new Date(today + 'T00:00:00+05:30'),
          },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ]);

    const studiedTodaySet = new Set(studiedToday.map((r) => r.userId));
    const atRiskIds = studiedYesterday
      .map((r) => r.userId)
      .filter((id) => !studiedTodaySet.has(id));

    if (atRiskIds.length === 0) return;

    const users = await this.prisma.user.findMany({
      where: { id: { in: atRiskIds } },
      select: { id: true, name: true, email: true },
    });

    for (const u of users) {
      // Compute streak length
      const attendance = await this.prisma.roomAttendance.findMany({
        where: { userId: u.id, leftAt: { not: null } },
        select: { joinedAt: true },
        orderBy: { joinedAt: 'desc' },
      });
      const dateKeys = Array.from(
        new Set(
          attendance.map((a) =>
            new Date(a.joinedAt.getTime() + IST_OFFSET_MS)
              .toISOString()
              .slice(0, 10),
          ),
        ),
      ).sort((a, b) => b.localeCompare(a));

      let streak = 0;
      let expected = yesterday;
      for (const key of dateKeys) {
        if (key === expected) {
          streak++;
          const d = new Date(expected + 'T12:00:00Z');
          d.setUTCDate(d.getUTCDate() - 1);
          expected = d.toISOString().slice(0, 10);
        } else {
          break;
        }
      }

      if (streak > 0) {
        await this.emailService.sendStreakRescueEmail(u.email, u.name ?? '', streak);
      }
    }

    this.logger.log(`Streak rescue: emailed ${users.length} users`);
  }

  // 6:00 PM IST every Sunday = 12:30 UTC Sunday
  @Cron('30 12 * * 0')
  async sendWeeklyReportEmails() {
    this.logger.log('Running weekly report cron');
    const today = todayISTKey();
    const weekAgo = new Date(Date.now() + IST_OFFSET_MS - 7 * 86400000)
      .toISOString()
      .slice(0, 10);

    const weekAttendance = await this.prisma.roomAttendance.findMany({
      where: {
        leftAt: { not: null },
        joinedAt: { gte: new Date(weekAgo + 'T00:00:00+05:30') },
      },
      include: {
        room: { select: { durationMinutes: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    });

    // Group by userId
    const byUser = new Map<
      string,
      { minutes: number; days: Map<string, number>; user: { name: string | null; email: string } }
    >();

    for (const entry of weekAttendance) {
      if (!entry.user.email) continue;
      const userId = entry.userId;
      const dateKey = new Date(entry.joinedAt.getTime() + IST_OFFSET_MS)
        .toISOString()
        .slice(0, 10);
      const mins = Math.round(
        (entry.leftAt!.getTime() - entry.joinedAt.getTime()) / 60000,
      );

      if (!byUser.has(userId)) {
        byUser.set(userId, {
          minutes: 0,
          days: new Map(),
          user: { name: entry.user.name, email: entry.user.email },
        });
      }
      const row = byUser.get(userId)!;
      row.minutes += mins;
      row.days.set(dateKey, (row.days.get(dateKey) ?? 0) + mins);
    }

    // Fetch focus scores for the week
    const focusMap = new Map<string, number>();
    const focusSessions = await this.prisma.focusSession.findMany({
      where: {
        userId: { in: Array.from(byUser.keys()) },
        sessionDate: { gte: new Date(weekAgo + 'T00:00:00+05:30') },
      },
      select: { userId: true, focusScore: true },
    });
    const focusByUser = new Map<string, number[]>();
    for (const fs of focusSessions) {
      if (!focusByUser.has(fs.userId)) focusByUser.set(fs.userId, []);
      focusByUser.get(fs.userId)!.push(fs.focusScore);
    }
    for (const [uid, scores] of focusByUser) {
      focusMap.set(uid, Math.round(scores.reduce((a, b) => a + b, 0) / scores.length));
    }

    // Compute streaks
    const allAttendance = await this.prisma.roomAttendance.findMany({
      where: {
        userId: { in: Array.from(byUser.keys()) },
        leftAt: { not: null },
      },
      select: { userId: true, joinedAt: true },
      orderBy: { joinedAt: 'desc' },
    });
    const streakMap = new Map<string, number>();
    const attendanceByUser = new Map<string, string[]>();
    for (const a of allAttendance) {
      const key = new Date(a.joinedAt.getTime() + IST_OFFSET_MS)
        .toISOString()
        .slice(0, 10);
      if (!attendanceByUser.has(a.userId)) attendanceByUser.set(a.userId, []);
      attendanceByUser.get(a.userId)!.push(key);
    }
    for (const [uid, keys] of attendanceByUser) {
      const unique = Array.from(new Set(keys)).sort((a, b) => b.localeCompare(a));
      let streak = 0;
      let expected = today;
      for (const k of unique) {
        if (k === expected) {
          streak++;
          const d = new Date(expected + 'T12:00:00Z');
          d.setUTCDate(d.getUTCDate() - 1);
          expected = d.toISOString().slice(0, 10);
        } else if (k < expected) {
          break;
        }
      }
      streakMap.set(uid, streak);
    }

    for (const [userId, data] of byUser) {
      if (data.minutes < 5) continue; // skip users who barely studied

      const bestDay = Array.from(data.days.entries()).sort((a, b) => b[1] - a[1])[0];
      const report = {
        totalMinutes: data.minutes,
        totalLabel: formatMinutes(data.minutes),
        sessionsCompleted: data.days.size, // days with sessions
        bestDayLabel: bestDay ? dayLabel(bestDay[0]) : 'N/A',
        avgFocusScore: focusMap.get(userId) ?? null,
        streakDays: streakMap.get(userId) ?? 0,
      };

      await this.emailService.sendWeeklyReportEmail(
        data.user.email,
        data.user.name ?? '',
        report,
      );
    }

    this.logger.log(`Weekly report: emailed ${byUser.size} users`);
  }
}
