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
      props: (e.props ?? {}) as Prisma.InputJsonValue,
    };
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
}
