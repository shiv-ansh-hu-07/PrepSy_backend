import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TrackEventInput } from './analytics.dto';

const MAX_BATCH = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async track(userId: string | null, e: TrackEventInput) {
    const row = this.toRow(userId, e);
    if (!row) return { ok: false };
    await this.prisma.event.create({ data: row });
    return { ok: true };
  }

  async trackBatch(userId: string | null, events: TrackEventInput[]) {
    const rows = (events || [])
      .slice(0, MAX_BATCH)
      .map((e) => this.toRow(userId, e))
      .filter((r): r is Prisma.EventCreateManyInput => r !== null);
    if (rows.length) {
      await this.prisma.event.createMany({ data: rows });
    }
    return { ok: true, count: rows.length };
  }

  /** Sanitize + shape a single event; returns null if invalid (no name). */
  private toRow(
    userId: string | null,
    e: TrackEventInput,
  ): Prisma.EventCreateManyInput | null {
    if (!e || typeof e.name !== 'string' || !e.name.trim()) return null;
    return {
      name: e.name.trim().slice(0, 80),
      userId: userId ?? null,
      anonId: e.anonId ? String(e.anonId).slice(0, 64) : null,
      sessionId: e.sessionId ? String(e.sessionId).slice(0, 64) : null,
      path: e.path ? String(e.path).slice(0, 300) : null,
      props: this.boundedProps(e.props),
    };
  }

  // Anonymous callers can post events, so keep each props blob small — enough
  // for real event metadata, not enough to bloat the table.
  private boundedProps(props: unknown): Prisma.InputJsonValue {
    if (!props || typeof props !== 'object') return {};
    try {
      return JSON.stringify(props).length <= 2000
        ? (props as Prisma.InputJsonValue)
        : { truncated: true };
    } catch {
      return {};
    }
  }

  /** Founder-facing snapshot: active users, signups, sessions, basic retention. */
  async getSummary() {
    const now = Date.now();
    const d1 = new Date(now - 1 * DAY_MS);
    const d7 = new Date(now - 7 * DAY_MS);
    const d30 = new Date(now - 30 * DAY_MS);

    const distinctUsers = async (since: Date) => {
      const rows = await this.prisma.event.findMany({
        where: { createdAt: { gte: since }, userId: { not: null } },
        distinct: ['userId'],
        select: { userId: true },
      });
      return rows.length;
    };

    const [dau, wau, mau, signups7, signups30, sessions7, totalEvents] =
      await Promise.all([
        distinctUsers(d1),
        distinctUsers(d7),
        distinctUsers(d30),
        this.prisma.event.count({
          where: { name: 'signup_completed', createdAt: { gte: d7 } },
        }),
        this.prisma.event.count({
          where: { name: 'signup_completed', createdAt: { gte: d30 } },
        }),
        this.prisma.event.count({
          where: { name: 'session_completed', createdAt: { gte: d7 } },
        }),
        this.prisma.event.count(),
      ]);

    const byName = await this.prisma.event.groupBy({
      by: ['name'],
      where: { createdAt: { gte: d7 } },
      _count: { name: true },
      orderBy: { _count: { name: 'desc' } },
      take: 20,
    });

    // Returning users: signed-in users active on 2+ distinct days in the last 30.
    const retRows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM (
        SELECT "userId" FROM "Event"
        WHERE "userId" IS NOT NULL AND "createdAt" >= ${d30}
        GROUP BY "userId"
        HAVING COUNT(DISTINCT DATE("createdAt")) >= 2
      ) t;
    `;
    const returningUsers30 = Number(retRows?.[0]?.count ?? 0);

    return {
      generatedAt: new Date().toISOString(),
      active: { dau, wau, mau },
      signups: { last7Days: signups7, last30Days: signups30 },
      sessionsCompletedLast7Days: sessions7,
      returningUsers30,
      totalEvents,
      topEventsLast7Days: byName.map((r) => ({
        name: r.name,
        count: r._count.name,
      })),
    };
  }

  // Per-tester activity — the September view. For each signed-in user seen in the
  // event stream: their funnel milestones, distinct active days, first/last seen.
  async getTesters() {
    const events = await this.prisma.event.findMany({
      where: { userId: { not: null } },
      select: { userId: true, name: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const dayKey = (d: Date) => d.toISOString().slice(0, 10); // UTC day
    type Row = {
      userId: string;
      events: number;
      firstSeen: Date;
      lastSeen: Date;
      days: Set<string>;
      signedUp: boolean;
      joinedRoom: boolean;
      completedSession: boolean;
    };
    const map = new Map<string, Row>();
    for (const e of events) {
      const uid = e.userId as string;
      let r = map.get(uid);
      if (!r) {
        r = {
          userId: uid,
          events: 0,
          firstSeen: e.createdAt,
          lastSeen: e.createdAt,
          days: new Set(),
          signedUp: false,
          joinedRoom: false,
          completedSession: false,
        };
        map.set(uid, r);
      }
      r.events += 1;
      r.lastSeen = e.createdAt;
      r.days.add(dayKey(e.createdAt));
      if (e.name === 'signup_completed') r.signedUp = true;
      if (e.name === 'room_joined') r.joinedRoom = true;
      if (e.name === 'session_completed') r.completedSession = true;
    }

    const ids = [...map.keys()];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    return [...map.values()]
      .map((r) => ({
        userId: r.userId,
        name: userById.get(r.userId)?.name ?? null,
        email: userById.get(r.userId)?.email ?? null,
        events: r.events,
        activeDays: r.days.size,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        signedUp: r.signedUp,
        joinedRoom: r.joinedRoom,
        completedSession: r.completedSession,
      }))
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
  }

  // Cohort retention — the investability view. From the per-day study log
  // (CohortStudyDay, from the room heartbeat): for each cohort, week by week
  // (IST, Monday start) how many members studied, total minutes, how many hit
  // 3+ days, plus a per-member grid with this week's day-by-day minutes.
  // A day "counts" at >= 5 minutes so a quick peek isn't an active day.
  async getCohortRetention(weeks = 6) {
    const ACTIVE_DAY_SEC = 300;
    const IST_MS = 5.5 * 3600 * 1000;
    const dayKey = (d: Date) =>
      new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
    const shift = (key: string, n: number) => {
      const d = new Date(key + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const today = dayKey(new Date());
    const dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;
    const thisWeek = shift(today, -dow);
    const weekStarts = Array.from({ length: weeks }, (_, i) =>
      shift(thisWeek, -7 * (weeks - 1 - i)),
    );
    const from = weekStarts[0];
    const weekOf = (day: string) =>
      weekStarts.filter((w) => w <= day).pop() ?? null;

    const rows = await this.prisma.cohortStudyDay.findMany({
      where: { day: { gte: from } },
      select: { cohortId: true, userId: true, day: true, seconds: true },
    });
    const cohortIds = [...new Set(rows.map((r) => r.cohortId))];
    if (!cohortIds.length) return { weekStarts, thisWeek, today, cohorts: [] };

    const cohorts = await this.prisma.cohort.findMany({
      where: { id: { in: cohortIds } },
      select: {
        id: true,
        name: true,
        syncMode: true,
        visibility: true,
        createdAt: true,
        members: {
          select: {
            userId: true,
            joinedAt: true,
            user: { select: { name: true, email: true } },
          },
        },
      },
    });

    const thisWeekDays = Array.from({ length: 7 }, (_, i) =>
      shift(thisWeek, i),
    );
    const result = cohorts.map((c) => {
      const mine = rows.filter((r) => r.cohortId === c.id);
      const members = c.members.map((m) => {
        const my = mine.filter((r) => r.userId === m.userId);
        const perWeek = weekStarts.map((w) => {
          const inWeek = my.filter((r) => weekOf(r.day) === w);
          return {
            days: inWeek.filter((r) => r.seconds >= ACTIVE_DAY_SEC).length,
            minutes: Math.round(inWeek.reduce((a, r) => a + r.seconds, 0) / 60),
          };
        });
        const daily = thisWeekDays.map((d) => {
          const r = my.find((x) => x.day === d);
          return { day: d, minutes: r ? Math.round(r.seconds / 60) : 0 };
        });
        const lastDay =
          my
            .filter((r) => r.seconds >= ACTIVE_DAY_SEC)
            .map((r) => r.day)
            .sort()
            .pop() ?? null;
        return {
          userId: m.userId,
          name: m.user?.name || m.user?.email || 'Member',
          joinedAt: m.joinedAt,
          perWeek,
          daily,
          lastActiveDay: lastDay,
        };
      });
      const perWeek = weekStarts.map((w, i) => ({
        weekStart: w,
        partial: w === thisWeek,
        activeMembers: members.filter((m) => m.perWeek[i].days > 0).length,
        threePlusDays: members.filter((m) => m.perWeek[i].days >= 3).length,
        minutes: members.reduce((a, m) => a + m.perWeek[i].minutes, 0),
      }));
      return {
        id: c.id,
        name: c.name,
        syncMode: c.syncMode,
        visibility: c.visibility,
        memberCount: c.members.length,
        perWeek,
        members: members.sort(
          (a, b) => b.perWeek[weeks - 1].minutes - a.perWeek[weeks - 1].minutes,
        ),
      };
    });
    result.sort(
      (a, b) =>
        b.perWeek[weeks - 1].activeMembers -
          a.perWeek[weeks - 1].activeMembers ||
        b.perWeek[weeks - 1].minutes - a.perWeek[weeks - 1].minutes,
    );
    return { weekStarts, thisWeek, today, cohorts: result };
  }
}
