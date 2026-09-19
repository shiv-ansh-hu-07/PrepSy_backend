import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { Cron } from '@nestjs/schedule';
import { EmailService } from '../email/email.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const CHECKPOINT_PASS = 0.6; // fraction correct to count a checkpoint as passed
const COHORT_MAX_SIZE = 6; // a cohort is a small study crew, not a broadcast

export interface CreateCohortInput {
  playlistId: string;
  name: string;
  maxSize?: number;
  startMode?: 'NOW' | 'SCHEDULED';
  dailyTime?: string;
  startDate?: string;
  // When re-forming, carry the crew from a finished cohort into this new one.
  reformFromCohortId?: string;
  sessions?: {
    topic: string;
    description?: string;
    studyHours?: number;
    videoIds?: string[];
    startSec?: number;
    endSec?: number;
    part?: string;
  }[];
}

export interface UpdateCohortInput {
  name?: string;
  dailyTime?: string;
  startDate?: string;
}

export interface SetPlanInput {
  sessions?: {
    topic: string;
    description?: string;
    studyHours?: number;
    videoIds?: string[];
    startSec?: number;
    endSec?: number;
    part?: string;
  }[];
  dailyTime?: string;
  startDate?: string;
}

@Injectable()
export class CohortsService {
  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private s3: S3Service,
  ) {}

  // ── Cohorts ───────────────────────────────────────────────────────────────

  async createCohort(userId: string, input: CreateCohortInput) {
    const { playlistId, name, maxSize, startMode, dailyTime, startDate, sessions, reformFromCohortId } = input;
    // Small by design: a cohort is a study crew, not a broadcast. Cap at 6 so
    // synced watching + checkpoint discussion actually work (deck's number).
    const cappedMax = Math.min(Math.max(2, maxSize ?? COHORT_MAX_SIZE), COHORT_MAX_SIZE);

    const playlist = await this.prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!playlist) throw new NotFoundException('Playlist not found');
    if (!name?.trim()) throw new BadRequestException('Cohort name is required');

    const now = new Date();
    const firstStart =
      startMode === 'SCHEDULED' && startDate ? new Date(startDate) : now;
    if (Number.isNaN(firstStart.getTime())) {
      throw new BadRequestException('Invalid start date');
    }

    const cohort = await this.prisma.cohort.create({
      data: {
        playlistId,
        name: name.trim(),
        createdById: userId,
        maxSize: cappedMax,
        startMode: startMode ?? null,
        dailyTime: dailyTime ?? null,
        startDate: startMode ? firstStart : null,
        members: { create: { userId, progress: {} } },
      },
    });

    // Re-form: carry the crew from a finished cohort. Only the caller's own
    // cohorts, and only up to the size cap. Members re-commit by continuing.
    let reformCrew: string[] = [];
    if (reformFromCohortId) {
      const source = await this.prisma.cohort.findFirst({
        where: { id: reformFromCohortId, members: { some: { userId } } },
        include: { members: { select: { userId: true } } },
      });
      if (source) {
        reformCrew = source.members
          .map((m) => m.userId)
          .filter((uid) => uid !== userId)
          .slice(0, Math.max(0, cappedMax - 1));
        if (reformCrew.length) {
          await this.prisma.cohortMember.createMany({
            data: reformCrew.map((uid) => ({ cohortId: cohort.id, userId: uid, progress: {} })),
            skipDuplicates: true,
          });
        }
      }
    }

    // Scheduled cohorts get one shared recurring room + a daily session per plan-day.
    if (startMode === 'NOW' || startMode === 'SCHEDULED') {
      const roomId = randomUUID();
      await this.prisma.room.create({
        data: {
          name: name.trim(),
          roomId,
          description: `Study room for the "${name.trim()}" cohort`,
          tags: [],
          visibility: 'PUBLIC',
          ownerId: userId,
          startTime: firstStart,
          durationMinutes: 60,
          isRecurring: true,
          recurrenceType: 'DAILY',
          youtubePlaylistId: playlist.ytPlaylistId,
          remindersent: false,
        },
      });
      await this.prisma.roomMember.create({ data: { roomId, userId } });
      if (reformCrew.length) {
        await this.prisma.roomMember.createMany({
          data: reformCrew.map((uid) => ({ roomId, userId: uid })),
          skipDuplicates: true,
        });
      }
      await this.prisma.cohort.update({ where: { id: cohort.id }, data: { roomId } });

      const dayList = Array.isArray(sessions) ? sessions : [];
      if (dayList.length) {
        await this.prisma.studySession.createMany({
          data: dayList.map((s, i) => ({
            cohortId: cohort.id,
            topic: s.topic,
            description: s.description ?? null,
            studyHours: s.studyHours ?? null,
            videoIds: Array.isArray(s.videoIds) ? s.videoIds : [],
            startSec: s.startSec ?? null,
            endSec: s.endSec ?? null,
            part: s.part ?? null,
            scheduledAt: this.addDays(firstStart, i),
            roomId,
            orderIndex: i,
            status: 'SCHEDULED',
          })),
        });
      }
    }

    await this.syncCreationSkipped(cohort.id);
    return this.getCohort(cohort.id, userId);
  }

  async updateCohort(cohortId: string, userId: string, input: UpdateCohortInput) {
    const cohort = await this.prisma.cohort.findUnique({ where: { id: cohortId } });
    if (!cohort) throw new NotFoundException('Cohort not found');
    if (cohort.createdById !== userId) {
      throw new ForbiddenException('Only the creator can edit this cohort');
    }

    const data: {
      name?: string;
      dailyTime?: string;
      startDate?: Date;
    } = {};
    if (typeof input.name === 'string' && input.name.trim()) data.name = input.name.trim();
    if (typeof input.dailyTime === 'string') data.dailyTime = input.dailyTime;
    if (input.startDate) {
      const d = new Date(input.startDate);
      if (!Number.isNaN(d.getTime())) data.startDate = d;
    }

    await this.prisma.cohort.update({ where: { id: cohortId }, data });

    // Keep the shared room in sync with name / next start time.
    if (cohort.roomId) {
      const roomData: { name?: string; startTime?: Date } = {};
      if (data.name) roomData.name = data.name;
      if (data.startDate) roomData.startTime = data.startDate;
      if (Object.keys(roomData).length) {
        await this.prisma.room.update({ where: { roomId: cohort.roomId }, data: roomData });
      }
    }

    return this.getCohort(cohortId, userId);
  }

  // Save (or replace) the cohort's shared day-by-day plan. Works for any cohort,
  // including older ones that were created without a schedule — it creates the
  // shared recurring room if one doesn't exist yet.
  async setPlan(cohortId: string, userId: string, input: SetPlanInput) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: { playlist: true },
    });
    if (!cohort) throw new NotFoundException('Cohort not found');
    if (cohort.createdById !== userId) {
      throw new ForbiddenException('Only the creator can set the plan');
    }

    // The schedule is locked once a plan exists. Regenerating would delete and
    // recreate every StudySession, breaking the room schedule, the daily
    // reminder emails, and anything already tied to the current dates.
    const existingSessions = await this.prisma.studySession.count({
      where: { cohortId },
    });
    if (existingSessions > 0) {
      throw new ForbiddenException(
        'This cohort already has a schedule. The plan is locked once created and cannot be regenerated.',
      );
    }

    const firstStart = input.startDate
      ? new Date(input.startDate)
      : (cohort.startDate ?? new Date());
    if (Number.isNaN(firstStart.getTime())) {
      throw new BadRequestException('Invalid start date');
    }

    // Ensure the cohort has a shared room (create one if it never had scheduling).
    let roomId = cohort.roomId;
    if (!roomId) {
      roomId = randomUUID();
      await this.prisma.room.create({
        data: {
          name: cohort.name,
          roomId,
          description: `Study room for the "${cohort.name}" cohort`,
          tags: [],
          visibility: 'PUBLIC',
          ownerId: userId,
          startTime: firstStart,
          durationMinutes: 60,
          isRecurring: true,
          recurrenceType: 'DAILY',
          youtubePlaylistId: cohort.playlist.ytPlaylistId,
          remindersent: false,
        },
      });
      await this.prisma.roomMember.create({ data: { roomId, userId } });
    }

    await this.prisma.cohort.update({
      where: { id: cohortId },
      data: {
        roomId,
        startMode: cohort.startMode ?? 'SCHEDULED',
        startDate: firstStart,
        dailyTime: input.dailyTime ?? cohort.dailyTime,
      },
    });

    // Replace the day-by-day plan.
    await this.prisma.studySession.deleteMany({ where: { cohortId } });
    const dayList = Array.isArray(input.sessions) ? input.sessions : [];
    if (dayList.length) {
      await this.prisma.studySession.createMany({
        data: dayList.map((s, i) => ({
          cohortId,
          topic: s.topic,
          description: s.description ?? null,
          studyHours: s.studyHours ?? null,
          videoIds: Array.isArray(s.videoIds) ? s.videoIds : [],
          startSec: s.startSec ?? null,
          endSec: s.endSec ?? null,
          part: s.part ?? null,
          scheduledAt: this.addDays(firstStart, i),
          roomId,
          orderIndex: i,
          status: 'SCHEDULED',
        })),
      });
    }

    await this.syncCreationSkipped(cohortId);
    return this.getCohort(cohortId, userId);
  }

  // Record which playlist videos were left out of the plan at creation → they go
  // into the cohort's skipped set (excluded from the schedule, offered as catch-up).
  private async syncCreationSkipped(cohortId: string) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: { playlist: { include: { videos: { select: { ytVideoId: true } } } } },
    });
    if (!cohort?.playlist) return;
    const sessions = await this.prisma.studySession.findMany({
      where: { cohortId },
      select: { videoIds: true },
    });
    const planned = new Set<string>();
    for (const s of sessions) for (const v of s.videoIds ?? []) planned.add(v);
    // Only meaningful once there IS a plan; an empty plan means "not scheduled yet".
    if (!planned.size) return;
    const skipped = cohort.playlist.videos
      .map((v) => v.ytVideoId)
      .filter((id) => !planned.has(id));
    await this.prisma.cohort.update({
      where: { id: cohortId },
      data: { skippedVideoIds: skipped },
    });
  }

  private addDays(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  // Day boundaries for the IST calendar day containing `date`, returned as UTC
  // instants. The app targets Asia/Kolkata (UTC+5:30, no DST), so "today" must
  // be an IST day — not the server-local (UTC) day, which would be off by one
  // for evening-IST times.
  private dayBounds(date: Date) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const ist = new Date(date.getTime() + IST_OFFSET_MS);
    const y = ist.getUTCFullYear();
    const m = ist.getUTCMonth();
    const d = ist.getUTCDate();
    const start = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - IST_OFFSET_MS);
    const end = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - IST_OFFSET_MS);
    return { start, end };
  }

  // ── Cohort reminder engine ──────────────────────────────────────────────────
  // Two emails per session (see below): (1) ~15 min before to everyone, and
  // (2) ~10 min after start to no-shows. The old 8 AM "today's topic" blast was
  // removed so members get exactly those two, not three overlapping reminders.

  // Reminder 1 — 15 min before each session, to EVERY cohort member. Runs every
  // 5 min; the ~16-min window + reminderSent flag means each session fires once,
  // ~15 min out, regardless of when the cohort was created or room membership.
  @Cron('*/5 * * * *')
  async notifyUpcomingCohortSessions() {
    const now = new Date();
    const soon = new Date(now.getTime() + 16 * 60000);
    const sessions = await this.prisma.studySession.findMany({
      where: {
        status: 'SCHEDULED',
        reminderSent: false,
        scheduledAt: { gte: now, lte: soon },
      },
      include: {
        cohort: {
          include: {
            members: {
              include: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
      },
    });
    if (!sessions.length) return;

    const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    const memberIds = Array.from(
      new Set(
        sessions.flatMap((s) => s.cohort.members.map((m) => m.userId).filter(Boolean)),
      ),
    );
    const statsById = await this.computeReminderStats(memberIds);

    for (const session of sessions) {
      const roomId = session.roomId || session.cohort.roomId;
      if (!roomId) continue;

      const roomExists = await this.prisma.room.findUnique({
        where: { roomId },
        select: { roomId: true },
      });
      if (!roomExists) {
        await this.prisma.studySession
          .update({ where: { id: session.id }, data: { status: 'CANCELLED' } })
          .catch(() => undefined);
        continue;
      }

      // Mark first so overlapping ticks (the 20-min window spans ~4 ticks) never
      // double-send, even if the email loop is slow.
      await this.prisma.studySession
        .update({ where: { id: session.id }, data: { reminderSent: true } })
        .catch(() => undefined);

      const joinUrl = `${frontendUrl}/room/${roomId}`;
      for (const member of session.cohort.members) {
        if (!member.user?.email) continue;
        const st = statsById.get(member.userId) ?? {
          streakDays: 0,
          weekMinutes: 0,
          weekSessions: 0,
          goalMinutes: 0,
        };
        await this.emailService.sendSessionReminderEmail(member.user.email, {
          name: member.user.name,
          roomName: session.cohort.name,
          topic: session.topic,
          startLabel: 'in about 15 minutes',
          joinUrl,
          streakDays: st.streakDays,
          weekLabel: this.formatMins(st.weekMinutes),
          sessionsThisWeek: st.weekSessions,
          goalLabel: st.goalMinutes > 0 ? `${this.formatMins(st.goalMinutes)}/day` : null,
        });
      }
    }
  }

  // Reminder 2 — ~10 min after a session starts, email members who HAVEN'T
  // joined the room today: the topic, their streak, and what breaking it costs.
  // Runs every 5 min; a session is checked once (missedCheckSent) in the window
  // 8–20 min after its start, so it lands ~10 min in.
  @Cron('*/5 * * * *')
  async remindNoShowsAfterStart() {
    const now = new Date();
    const lo = new Date(now.getTime() - 20 * 60000);
    const hi = new Date(now.getTime() - 8 * 60000);
    const sessions = await this.prisma.studySession.findMany({
      where: {
        status: 'SCHEDULED',
        missedCheckSent: false,
        scheduledAt: { gte: lo, lte: hi },
      },
      include: {
        cohort: {
          include: {
            members: {
              include: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
      },
    });
    if (!sessions.length) return;

    const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    const memberIds = Array.from(
      new Set(
        sessions.flatMap((s) => s.cohort.members.map((m) => m.userId).filter(Boolean)),
      ),
    );
    const statsById = await this.computeReminderStats(memberIds);

    for (const session of sessions) {
      const roomId = session.roomId || session.cohort.roomId;
      if (!roomId) continue;

      const roomExists = await this.prisma.room.findUnique({
        where: { roomId },
        select: { roomId: true },
      });
      if (!roomExists) {
        await this.prisma.studySession
          .update({ where: { id: session.id }, data: { status: 'CANCELLED' } })
          .catch(() => undefined);
        continue;
      }

      await this.prisma.studySession
        .update({ where: { id: session.id }, data: { missedCheckSent: true } })
        .catch(() => undefined);

      // Who has already joined today's room? Only nudge the no-shows.
      const { start, end } = this.dayBounds(now);
      const attendance = await this.prisma.roomAttendance.findMany({
        where: { roomId, joinedAt: { gte: start, lte: end } },
        select: { userId: true },
      });
      const attended = new Set(attendance.map((a) => a.userId));

      const joinUrl = `${frontendUrl}/room/${roomId}`;
      for (const member of session.cohort.members) {
        if (!member.user?.email || attended.has(member.userId)) continue;
        const st = statsById.get(member.userId);
        await this.emailService.sendMissedSessionEmail(member.user.email, {
          name: member.user.name,
          cohortName: session.cohort.name,
          topic: session.topic,
          joinUrl,
          streakDays: st?.streakDays ?? 0,
        });
      }
    }
  }

  private formatMins(mins: number): string {
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  private istDayKey(d: Date): string {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  }

  private shiftDayKey(key: string, days: number): string {
    const d = new Date(key + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Streak + this-week study stats for a batch of users, for reminder emails.
  // One attendance query + one profile query, computed in memory.
  private async computeReminderStats(userIds: string[]) {
    const stats = new Map<
      string,
      {
        streakDays: number;
        weekMinutes: number;
        weekSessions: number;
        goalMinutes: number;
      }
    >();
    if (userIds.length === 0) return stats;

    const since = new Date(Date.now() - 45 * 86400000);
    const weekAgoMs = Date.now() - 7 * 86400000;
    const todayKey = this.istDayKey(new Date());

    const [attendance, profiles] = await Promise.all([
      this.prisma.roomAttendance.findMany({
        where: {
          userId: { in: userIds },
          leftAt: { not: null },
          joinedAt: { gte: since },
        },
        select: { userId: true, joinedAt: true, leftAt: true },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, dailyStudyGoalMinutes: true },
      }),
    ]);

    const goalById = new Map(
      profiles.map((p) => [p.userId, p.dailyStudyGoalMinutes ?? 0]),
    );

    const byUser = new Map<
      string,
      { days: Set<string>; weekMinutes: number; weekDays: Set<string> }
    >();
    for (const a of attendance) {
      if (!byUser.has(a.userId)) {
        byUser.set(a.userId, {
          days: new Set(),
          weekMinutes: 0,
          weekDays: new Set(),
        });
      }
      const row = byUser.get(a.userId)!;
      const key = this.istDayKey(a.joinedAt);
      row.days.add(key);
      if (a.joinedAt.getTime() >= weekAgoMs) {
        // Same 10h/session cap as analytics, so a stray long row can't skew it.
        const mins = Math.min(
          600,
          Math.max(
            0,
            Math.round((a.leftAt!.getTime() - a.joinedAt.getTime()) / 60000),
          ),
        );
        row.weekMinutes += mins;
        row.weekDays.add(key);
      }
    }

    for (const userId of userIds) {
      const row = byUser.get(userId);
      let streak = 0;
      if (row) {
        // Consecutive IST study days ending today (or yesterday if not today).
        let expected = row.days.has(todayKey)
          ? todayKey
          : this.shiftDayKey(todayKey, -1);
        while (row.days.has(expected)) {
          streak++;
          expected = this.shiftDayKey(expected, -1);
        }
      }
      stats.set(userId, {
        streakDays: streak,
        weekMinutes: row?.weekMinutes ?? 0,
        weekSessions: row?.weekDays.size ?? 0,
        goalMinutes: goalById.get(userId) ?? 0,
      });
    }
    return stats;
  }

  // Just after midnight IST: resolve yesterday's sessions on real learning
  // evidence, not attendance. A day is COMPLETED only if the cohort actually
  // finished its videos (every one of the day's videoIds is in the cohort-wide
  // watched set). A day that lapsed without finishing is marked POSTPONED and its
  // content is carried forward: recomputeScheduleFromProgress re-packs every
  // unwatched video into the upcoming days (creating extra days if needed), so
  // nothing watched-short is silently lost. (Legacy/empty sessions with no
  // videoIds fall back to attendance so they still resolve.)
  @Cron('5 0 * * *', { timeZone: 'Asia/Kolkata' })
  async resolveMissedCohortSessions() {
    const yesterday = this.addDays(new Date(), -1);
    const { start, end } = this.dayBounds(yesterday);

    const sessions = await this.prisma.studySession.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { gte: start, lte: end } },
    });
    if (!sessions.length) return;

    // Cohort-wide watched union for each cohort with a session yesterday.
    const cohortIds = [...new Set(sessions.map((s) => s.cohortId))];
    const members = await this.prisma.cohortMember.findMany({
      where: { cohortId: { in: cohortIds } },
      select: { cohortId: true, progress: true },
    });
    const watchedByCohort = new Map<string, Set<string>>();
    for (const m of members) {
      const set = watchedByCohort.get(m.cohortId) ?? new Set<string>();
      for (const v of this.getWatchedVideos(m.progress)) set.add(v);
      watchedByCohort.set(m.cohortId, set);
    }

    const lapsed = new Set<string>();
    for (const session of sessions) {
      const vids = session.videoIds ?? [];
      const watchedUnion = watchedByCohort.get(session.cohortId) ?? new Set<string>();
      const finishedContent = vids.length > 0 && vids.every((v) => watchedUnion.has(v));

      // Only sessions with no videos fall back to attendance (legacy/empty days).
      let attended = 0;
      if (!vids.length && session.roomId) {
        attended = await this.prisma.roomAttendance.count({
          where: { roomId: session.roomId, joinedAt: { gte: start, lte: end } },
        });
      }
      const done = finishedContent || (vids.length === 0 && attended > 0);

      if (done) {
        await this.prisma.studySession.update({
          where: { id: session.id },
          data: { status: 'COMPLETED' },
        });
      } else {
        // Lapsed: drop this day's content and carry it forward via the re-pack.
        await this.prisma.studySession.update({
          where: { id: session.id },
          data: { status: 'POSTPONED', videoIds: [] },
        });
        lapsed.add(session.cohortId);
      }
    }

    // Session-end checkpoint for every cohort that met yesterday: classify each
    // video (completed / started / skipped) from the shared pointer, drop the
    // skipped ones into catch-up, and re-pack the remaining plan. This also
    // covers the lapsed carry-forward (endCohortSession recomputes). Best-effort.
    for (const cohortId of cohortIds) {
      await this.endCohortSession(cohortId).catch(() => undefined);
    }
    void lapsed;
  }

  // Recommend cohorts the user isn't in, matched on how well the playlist topic
  // overlaps their study signals, with a boost for popular cohorts.
  async recommendedCohorts(userId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { goals: true, interests: true, examTargets: true, skills: true },
    });
    const words = (arr?: string[] | null) =>
      (arr ?? []).flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 3);
    const tokens = new Set([
      ...words(profile?.goals),
      ...words(profile?.interests),
      ...words(profile?.examTargets),
      ...words(profile?.skills),
    ]);

    const cohorts = await this.prisma.cohort.findMany({
      where: { members: { none: { userId } } },
      include: {
        playlist: { select: { title: true, channelTitle: true, thumbnailUrl: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });

    const now = Date.now();
    const DAY = 86400000;
    const scored = cohorts
      .map((c) => {
        const hay = new Set(
          `${c.name} ${c.playlist?.title ?? ''} ${c.playlist?.channelTitle ?? ''}`
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean),
        );
        const matched = [...tokens].filter((t) => hay.has(t)).length;
        const members = c._count.members;
        const spotsLeft = Math.max(0, c.maxSize - members);
        const startMs = c.startDate ? c.startDate.getTime() : null;
        // "forming" = hasn't started yet → the ideal cold-start entry: you join
        // before day 1 and begin with a full, live crew.
        const forming = startMs != null && startMs > now;
        const daysToStart = forming ? (startMs! - now) / DAY : null;
        // Rank: interest match > about-to-start > has social proof. Soonest
        // upcoming starts float up (join before it kicks off).
        const soonBoost = daysToStart != null ? Math.max(0, 6 - daysToStart) : 0;
        const score =
          matched * 6 + (forming ? 4 : 0) + soonBoost + Math.min(members, 4);
        return {
          id: c.id,
          name: c.name,
          playlistTitle: c.playlist?.title ?? null,
          thumbnailUrl: c.playlist?.thumbnailUrl ?? null,
          memberCount: members,
          maxSize: c.maxSize,
          spotsLeft,
          startDate: c.startDate ? c.startDate.toISOString() : null,
          dailyTime: c.dailyTime ?? null,
          status: forming ? 'forming' : 'active',
          matched,
          score,
        };
      })
      // Only show cohorts you can actually join.
      .filter((c) => c.spotsLeft > 0);

    const ranked = [...scored].sort((a, b) => b.score - a.score);

    return ranked.slice(0, 8).map((c) => ({
      id: c.id,
      name: c.name,
      playlistTitle: c.playlistTitle,
      thumbnailUrl: c.thumbnailUrl,
      memberCount: c.memberCount,
      maxSize: c.maxSize,
      spotsLeft: c.spotsLeft,
      startDate: c.startDate,
      dailyTime: c.dailyTime,
      status: c.status,
      reason:
        c.matched > 0
          ? 'Matches your goals'
          : c.status === 'forming'
            ? 'Starting soon'
            : 'Popular cohort',
    }));
  }

  async listUserCohorts(userId: string) {
    return this.prisma.cohort.findMany({
      where: { members: { some: { userId } } },
      include: {
        playlist: { select: { id: true, title: true, thumbnailUrl: true, channelTitle: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getCohort(cohortId: string, userId: string) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: {
        playlist: { include: { plan: true, videos: { orderBy: { position: 'asc' } } } },
        members: {
          include: { user: { select: { id: true, name: true } } },
          orderBy: { joinedAt: 'asc' },
        },
        _count: { select: { members: true, discussions: true } },
      },
    });
    if (!cohort) throw new NotFoundException('Cohort not found');

    const isMember = cohort.members.some((m) => m.userId === userId);
    return { ...cohort, isMember };
  }

  async joinCohort(cohortId: string, userId: string) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      select: { roomId: true, maxSize: true, _count: { select: { members: true } } },
    });
    if (!cohort) throw new NotFoundException('Cohort not found');
    if (cohort._count.members >= cohort.maxSize) {
      throw new BadRequestException('Cohort is full');
    }

    const member = await this.prisma.cohortMember.upsert({
      where: { cohortId_userId: { cohortId, userId } },
      create: { cohortId, userId, progress: {} },
      update: {},
    });

    // Also add them to the cohort's shared room so room-based features (the
    // 15-min room reminder, attendance context) reach joiners, not just the
    // creator. Idempotent.
    if (cohort.roomId) {
      await this.prisma.roomMember
        .createMany({
          data: [{ roomId: cohort.roomId, userId }],
          skipDuplicates: true,
        })
        .catch(() => undefined);
    }

    return member;
  }

  async leaveCohort(cohortId: string, userId: string) {
    const cohort = await this.prisma.cohort.findUnique({ where: { id: cohortId } });
    if (!cohort) throw new NotFoundException('Cohort not found');
    if (cohort.createdById === userId) {
      throw new BadRequestException('Creator cannot leave; delete the cohort instead');
    }

    await this.prisma.cohortMember.deleteMany({ where: { cohortId, userId } });
    return { ok: true };
  }

  async deleteCohort(cohortId: string, userId: string) {
    const cohort = await this.prisma.cohort.findUnique({ where: { id: cohortId } });
    if (!cohort) throw new NotFoundException('Cohort not found');
    if (cohort.createdById !== userId) {
      throw new ForbiddenException('Only the creator can delete this cohort');
    }

    // Cohort children (members, study sessions, discussions, quiz attempts)
    // cascade on delete. The shared Room does NOT cascade (it's a separate
    // record with no FK from Cohort), so tear it down explicitly — otherwise it
    // lingers on Home / My Rooms after the cohort is gone. RoomAttendance is
    // intentionally kept for analytics.
    const roomId = cohort.roomId;
    await this.prisma.$transaction([
      ...(roomId
        ? [
            this.prisma.roomMember.deleteMany({ where: { roomId } }),
            this.prisma.message.deleteMany({ where: { roomId } }),
            this.prisma.pomodoro.deleteMany({ where: { roomId } }),
          ]
        : []),
      this.prisma.cohort.delete({ where: { id: cohortId } }),
      ...(roomId ? [this.prisma.room.deleteMany({ where: { roomId } })] : []),
    ]);
    return { ok: true };
  }

  // ── Discussions ───────────────────────────────────────────────────────────

  // studySessionId scopes the thread list: a specific id returns that checkpoint's
  // threads; omitted (null) returns the general cohort board, keeping them separate.
  async getDiscussions(cohortId: string, studySessionId?: string) {
    return this.prisma.discussionPost.findMany({
      where: { cohortId, parentId: null, studySessionId: studySessionId ?? null },
      include: {
        author: { select: { id: true, name: true } },
        replies: {
          include: { author: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // A grounded AI opening question to seed a day's checkpoint discussion, so an
  // empty thread isn't a dead end. Generated once via the AI service and cached
  // on the StudySession; returns { question, followups }. Falls back to an empty
  // question (the client shows static starters) if the AI is unavailable.
  async getDiscussionPrompt(cohortId: string, userId: string, sessionId: string) {
    await this.assertMember(cohortId, userId);
    const session = await this.prisma.studySession.findFirst({
      where: { id: sessionId, cohortId },
      select: { id: true, topic: true, description: true, discussionPrompt: true },
    });
    if (!session) throw new NotFoundException('Session not found');

    if (session.discussionPrompt) {
      try {
        return JSON.parse(session.discussionPrompt) as {
          question: string;
          followups: string[];
        };
      } catch {
        // fall through and regenerate a malformed cache
      }
    }

    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      select: { playlist: { select: { title: true } } },
    });
    const videoTitles = (session.description ?? '')
      .split(' • ')
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const { data } = await axios.post(
        `${AI_URL}/discussion-prompt`,
        {
          topic: session.topic,
          videoTitles,
          playlistTitle: cohort?.playlist?.title ?? '',
        },
        { timeout: 30_000 },
      );
      const result = {
        question: typeof data?.question === 'string' ? data.question : '',
        followups: Array.isArray(data?.followups)
          ? (data.followups as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 3)
          : [],
      };
      if (result.question) {
        await this.prisma.studySession
          .update({ where: { id: session.id }, data: { discussionPrompt: JSON.stringify(result) } })
          .catch(() => undefined);
      }
      return result;
    } catch {
      return { question: '', followups: [] };
    }
  }

  async postDiscussion(
    cohortId: string,
    userId: string,
    content: string,
    parentId?: string,
    studySessionId?: string,
    attachment?: { url: string; name?: string; type?: string },
  ) {
    await this.assertMember(cohortId, userId);
    // Allow an attachment-only post (no text), but not a fully empty one.
    if (!content?.trim() && !attachment?.url) {
      throw new BadRequestException('Write something or attach a file.');
    }
    return this.prisma.discussionPost.create({
      data: {
        cohortId,
        authorId: userId,
        content: content ?? '',
        parentId: parentId ?? null,
        studySessionId: studySessionId ?? null,
        attachmentUrl: attachment?.url ?? null,
        attachmentName: attachment?.name ?? null,
        attachmentType: attachment?.type ?? null,
      },
      include: { author: { select: { id: true, name: true } } },
    });
  }

  // Upload a discussion attachment (image/document) to S3 and return its URL +
  // metadata; the client then includes it when posting the message.
  async uploadDiscussionMedia(
    cohortId: string,
    userId: string,
    file: Express.Multer.File,
  ) {
    await this.assertMember(cohortId, userId);
    const url = await this.s3.uploadChatMedia(
      userId,
      file.buffer,
      file.mimetype,
      file.originalname,
    );
    return { url, name: file.originalname, type: file.mimetype };
  }

  // ── Study Sessions ────────────────────────────────────────────────────────

  // Per-user, per-day view of the shared plan. Each day carries whether the
  // requesting user attended that day's room and how many distinct members did
  // (so the UI can show Joined / Missed / Starting soon, and we keep the group
  // schedule independent of any one member — one miss never shifts the cohort).
  async getSessions(cohortId: string, userId: string) {
    const [sessions, cohort, member] = await Promise.all([
      this.prisma.studySession.findMany({
        where: { cohortId },
        orderBy: { scheduledAt: 'asc' },
      }),
      this.prisma.cohort.findUnique({
        where: { id: cohortId },
        include: {
          playlist: {
            include: {
              videos: {
                select: { ytVideoId: true, title: true, thumbnailUrl: true, position: true },
                orderBy: { position: 'asc' },
              },
            },
          },
        },
      }),
      this.prisma.cohortMember.findUnique({
        where: { cohortId_userId: { cohortId, userId } },
        select: { progress: true },
      }),
    ]);

    // POSTPONED days lapsed without the cohort finishing them; their content has
    // been carried forward into upcoming days, so they no longer show as study days.
    const visible = sessions.filter((s) => s.status !== 'POSTPONED');

    const roomIds = [
      ...new Set(visible.map((s) => s.roomId).filter((r): r is string => Boolean(r))),
    ];
    const attendance = roomIds.length
      ? await this.prisma.roomAttendance.findMany({
          where: { roomId: { in: roomIds } },
          select: { roomId: true, userId: true, joinedAt: true },
        })
      : [];

    // Resolve each day's videos. Prefer the stored videoIds (the source of
    // truth); fall back to the legacy title strings in `description` for older
    // sessions created before videoIds were populated.
    const byId = new Map(
      (cohort?.playlist?.videos ?? []).map((v) => [v.ytVideoId, v]),
    );
    const byTitle = new Map(
      (cohort?.playlist?.videos ?? []).map((v) => [v.title.trim(), v]),
    );
    const caughtUp = this.getCaughtUpMap(member?.progress);
    const watchedSet = new Set(this.getWatchedVideos(member?.progress));

    return visible.map((s) => {
      const fromIds = (s.videoIds ?? [])
        .map((id) => byId.get(id))
        .filter((v): v is NonNullable<typeof v> => Boolean(v));
      const resolved = fromIds.length
        ? fromIds
        : (s.description ?? '')
            .split(' • ')
            .map((t) => byTitle.get(t.trim()))
            .filter((v): v is NonNullable<typeof v> => Boolean(v));
      const videos = resolved.map((v) => ({
        ytVideoId: v.ytVideoId,
        title: v.title,
        thumbnailUrl: v.thumbnailUrl,
      }));
      const caughtUpByMe = caughtUp[s.id] === true;
      // Did I actually watch this day's material (all its videos)? Real
      // completion evidence, unlike merely being in the room.
      const watchedByMe = videos.length > 0 && videos.every((v) => watchedSet.has(v.ytVideoId));

      if (!s.roomId) {
        return { ...s, attendedByMe: false, attendeeCount: 0, caughtUpByMe, watchedByMe, videos };
      }
      const { start, end } = this.dayBounds(s.scheduledAt);
      const dayRows = attendance.filter(
        (a) => a.roomId === s.roomId && a.joinedAt >= start && a.joinedAt <= end,
      );
      const attendeeCount = new Set(dayRows.map((a) => a.userId)).size;
      const attendedByMe = dayRows.some((a) => a.userId === userId);
      return { ...s, attendedByMe, attendeeCount, caughtUpByMe, watchedByMe, videos };
    });
  }

  // Per-member, per-day notes live in CohortMember.progress.notes (no schema
  // change). Shape: { [studySessionId]: string }. Revisitable per day.
  private getNotesMap(progress: unknown): Record<string, string> {
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      const n = (progress as Record<string, unknown>).notes;
      if (n && typeof n === 'object' && !Array.isArray(n)) {
        return n as Record<string, string>;
      }
    }
    return {};
  }

  async getSessionNote(cohortId: string, userId: string, sessionId: string) {
    await this.assertMember(cohortId, userId);
    const member = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId } },
      select: { progress: true },
    });
    return { text: this.getNotesMap(member?.progress)[sessionId] || '' };
  }

  async setSessionNote(
    cohortId: string,
    userId: string,
    sessionId: string,
    text: string,
  ) {
    await this.assertMember(cohortId, userId);
    const session = await this.prisma.studySession.findFirst({
      where: { id: sessionId, cohortId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('Session not found');

    const member = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId } },
      select: { progress: true },
    });
    const notes = this.getNotesMap(member?.progress);
    const t = (text || '').slice(0, 20000);
    if (t.trim()) notes[sessionId] = t;
    else delete notes[sessionId];

    const base =
      member?.progress && typeof member.progress === 'object' && !Array.isArray(member.progress)
        ? (member.progress as Record<string, unknown>)
        : {};
    await this.prisma.cohortMember.update({
      where: { cohortId_userId: { cohortId, userId } },
      data: { progress: { ...base, notes } },
    });
    return { ok: true };
  }

  // Per-member cohort intro lives in CohortMember.progress.intro (no schema
  // change). Shape: { goal?: string, blurb?: string }.
  private getIntro(progress: unknown): { goal?: string; blurb?: string } | null {
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      const i = (progress as Record<string, unknown>).intro;
      if (i && typeof i === 'object' && !Array.isArray(i)) {
        return i as { goal?: string; blurb?: string };
      }
    }
    return null;
  }

  // "Meet your crew": every member with their intro (goal + blurb) and, as a
  // fallback, what they're prepping for from their profile — so a new joiner
  // immediately sees who they're studying with, not anonymous rows.
  async getCrew(cohortId: string, userId: string) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true } } },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    if (!cohort) throw new NotFoundException('Cohort not found');

    const ids = cohort.members.map((m) => m.userId);
    const profiles = ids.length
      ? await this.prisma.userProfile.findMany({
          where: { userId: { in: ids } },
          select: { userId: true, examTargets: true, goals: true },
        })
      : [];
    const profById = new Map(profiles.map((p) => [p.userId, p]));

    const members = cohort.members.map((m) => {
      const intro = this.getIntro(m.progress);
      const prof = profById.get(m.userId);
      const prepFor = (prof?.examTargets?.length ? prof.examTargets : prof?.goals) ?? [];
      return {
        userId: m.userId,
        name: m.user?.name || 'Member',
        isCreator: cohort.createdById === m.userId,
        joinedAt: m.joinedAt,
        goal: intro?.goal || null,
        blurb: intro?.blurb || null,
        prepFor: prepFor.slice(0, 3),
      };
    });

    const meProf = profById.get(userId);
    const me = members.find((m) => m.userId === userId) || null;
    return {
      members,
      isMember: Boolean(me),
      hasIntro: Boolean(me?.goal || me?.blurb),
      // Prefill suggestion for the intro form.
      prepForSuggestion:
        meProf?.examTargets?.[0] || meProf?.goals?.[0] || '',
    };
  }

  // Set (or update) my intro for this cohort — a lightweight commitment + hello.
  async setCohortIntro(
    cohortId: string,
    userId: string,
    goal?: string,
    blurb?: string,
  ) {
    await this.assertMember(cohortId, userId);
    const member = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId } },
      select: { progress: true },
    });
    const base =
      member?.progress && typeof member.progress === 'object' && !Array.isArray(member.progress)
        ? (member.progress as Record<string, unknown>)
        : {};
    const intro = {
      goal: (goal || '').trim().slice(0, 80) || null,
      blurb: (blurb || '').trim().slice(0, 300) || null,
    };
    await this.prisma.cohortMember.update({
      where: { cohortId_userId: { cohortId, userId } },
      data: { progress: { ...base, intro } },
    });
    return { ok: true, intro };
  }

  // Personal catch-up lives in the per-user CohortMember.progress JSON — no
  // schema change needed. Shape: { caughtUp: { [studySessionId]: true } }.
  private getCaughtUpMap(progress: unknown): Record<string, boolean> {
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      const cu = (progress as Record<string, unknown>).caughtUp;
      if (cu && typeof cu === 'object' && !Array.isArray(cu)) {
        return cu as Record<string, boolean>;
      }
    }
    return {};
  }

  // Mark (or unmark) a missed day as personally caught up. Does not touch the
  // shared cohort schedule — this is purely the requesting member's progress.
  async markCatchup(
    cohortId: string,
    userId: string,
    sessionId: string,
    done: boolean,
  ) {
    await this.assertMember(cohortId, userId);
    const session = await this.prisma.studySession.findFirst({
      where: { id: sessionId, cohortId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('Session not found');

    const member = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId } },
      select: { progress: true },
    });
    const caughtUp = this.getCaughtUpMap(member?.progress);
    if (done) {
      caughtUp[sessionId] = true;
    } else {
      delete caughtUp[sessionId];
    }
    const baseProgress =
      member?.progress && typeof member.progress === 'object' && !Array.isArray(member.progress)
        ? (member.progress as Record<string, unknown>)
        : {};

    await this.prisma.cohortMember.update({
      where: { cohortId_userId: { cohortId, userId } },
      data: { progress: { ...baseProgress, caughtUp } },
    });
    return { sessionId, caughtUpByMe: done };
  }

  // Playback for a cohort room's current day: today's session if there is one,
  // else the next upcoming, else the first. Returns null when the room isn't a
  // cohort room. Drives the in-room player so it plays just that day's content.
  async getRoomCurrentSession(roomId: string) {
    const cohort = await this.prisma.cohort.findFirst({
      where: { roomId },
      select: { id: true },
    });
    if (!cohort) return null;

    const { start, end } = this.dayBounds(new Date());
    const session =
      (await this.prisma.studySession.findFirst({
        where: { cohortId: cohort.id, scheduledAt: { gte: start, lte: end } },
        orderBy: { orderIndex: 'asc' },
      })) ??
      (await this.prisma.studySession.findFirst({
        where: { cohortId: cohort.id, status: 'SCHEDULED', scheduledAt: { gt: end } },
        orderBy: { scheduledAt: 'asc' },
      })) ??
      (await this.prisma.studySession.findFirst({
        where: { cohortId: cohort.id },
        orderBy: { orderIndex: 'asc' },
      }));
    if (!session) return null;

    return {
      id: session.id,
      cohortId: cohort.id,
      topic: session.topic,
      videoIds: session.videoIds,
      startSec: session.startSec,
      endSec: session.endSec,
      part: session.part,
    };
  }

  // Full playlist for a cohort room's in-room browser: every video (ordered)
  // plus the caller's watched set, so the Playlist panel can render the whole
  // list with watched marks and let anyone jump to any video. Returns null for
  // non-cohort rooms. `currentVideoId` is the day's suggested starting video.
  async getRoomPlaylist(roomId: string, userId: string) {
    void userId; // status is cohort-wide (synced for everyone), not per-viewer
    const cohort = await this.prisma.cohort.findFirst({
      where: { roomId },
      include: {
        members: { select: { progress: true } },
        playlist: {
          include: {
            videos: {
              select: {
                ytVideoId: true,
                title: true,
                thumbnailUrl: true,
                position: true,
                durationSec: true,
              },
              orderBy: { position: 'asc' },
            },
          },
        },
      },
    });
    if (!cohort) return null;

    const allVideos = cohort.playlist?.videos ?? [];

    // Cohort-wide "done" set — a synced cohort shows the SAME playlist status to
    // everyone (what the cohort has watched together), not a per-viewer set.
    const cohortWatched = new Set<string>();
    for (const m of cohort.members) {
      for (const v of this.getWatchedVideos(m.progress)) cohortWatched.add(v);
    }

    // The cohort's PLAN = the playlist MINUS the skipped set (the authoritative
    // "not in the plan" list — skipped at creation OR jumped past in a session).
    // Skipped videos stay out of the player and pace, and are offered as catch-up.
    const sessions = await this.prisma.studySession.findMany({
      where: { cohortId: cohort.id },
      select: { studyHours: true },
      orderBy: { scheduledAt: 'asc' },
    });
    const skippedSet = new Set(cohort.skippedVideoIds ?? []);
    const videos = allVideos
      .filter((v) => !skippedSet.has(v.ytVideoId))
      .map((v) => ({ ...v, watched: cohortWatched.has(v.ytVideoId) }));
    const skipped = allVideos
      .filter((v) => skippedSet.has(v.ytVideoId))
      .map((v) => ({ ytVideoId: v.ytVideoId, title: v.title }));

    // Derived pace/ETA — pure arithmetic on durations, no LLM. "Continue from the
    // shared pointer": remaining unwatched plan duration ÷ the daily budget.
    const DEFAULT_VIDEO_SEC = 12 * 60;
    const dur = (v: { durationSec: number | null }) =>
      v.durationSec && v.durationSec > 0 ? v.durationSec : DEFAULT_VIDEO_SEC;
    const totalCount = videos.length;
    const completedCount = videos.filter((v) => v.watched).length;
    const remainingSec = videos.filter((v) => !v.watched).reduce((a, v) => a + dur(v), 0);
    const dailyBudgetSec = (sessions.find((s) => s.studyHours)?.studyHours ?? 2) * 3600 || 2 * 3600;
    const etaDays = remainingSec > 0 ? Math.ceil(remainingSec / dailyBudgetSec) : 0;

    const current = await this.getRoomCurrentSession(roomId);

    return {
      videos,
      watchedVideoIds: [...cohortWatched].filter((id) => !skippedSet.has(id)),
      currentVideoId: current?.videoIds?.[0] ?? null,
      // The cohort creator is the default host (drives playback in the live
      // room); the frontend uses this to gate controls + the handoff protocol.
      hostUserId: cohort.createdById,
      // Videos not in the plan (skipped at creation or during a session) — shown
      // as an optional catch-up list, never played on the shared stage.
      skipped,
      skippedCount: skipped.length,
      // Shared course progress derived from the pointer — drives the pace/ETA bar.
      progress: {
        completedCount,
        totalCount,
        percent: totalCount ? Math.round((completedCount / totalCount) * 100) : 0,
        remainingSec,
        etaDays,
      },
    };
  }

  async createSession(cohortId: string, userId: string, topic: string, scheduledAt: Date) {
    await this.assertMember(cohortId, userId);
    return this.prisma.studySession.create({
      data: { cohortId, topic, scheduledAt },
    });
  }

  // ── Quizzes ───────────────────────────────────────────────────────────────

  async generateQuiz(cohortId: string, userId: string, numQuestions = 5, sessionId?: string) {
    await this.assertMember(cohortId, userId);

    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: { playlist: { include: { plan: true } } },
    });
    if (!cohort?.playlist?.plan) {
      throw new BadRequestException('No AI plan generated for this cohort yet');
    }

    let topics: string[];
    let quizTitle = cohort.playlist.title;

    if (sessionId) {
      // Checkpoint quiz — scope to just this day's topic (+ its video titles).
      const session = await this.prisma.studySession.findFirst({
        where: { id: sessionId, cohortId },
        select: { topic: true, description: true },
      });
      if (!session) throw new NotFoundException('Session not found');
      const videoTitles = (session.description ?? '')
        .split(' • ')
        .map((t) => t.trim())
        .filter(Boolean);
      topics = [session.topic, ...videoTitles].filter(Boolean);
      quizTitle = `${cohort.playlist.title} — ${session.topic}`;
    } else {
      const curriculum = cohort.playlist.plan.curriculum as Array<{ title: string }>;
      topics = curriculum.map((t) => t.title);
    }

    try {
      const { data } = await axios.post(`${AI_URL}/quiz`, {
        playlistTitle: quizTitle,
        topics,
        numQuestions,
      }, { timeout: 60_000 });
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI service unavailable';
      throw new InternalServerErrorException(`Quiz generation failed: ${msg}`);
    }
  }

  async submitAttempt(
    cohortId: string,
    userId: string,
    questions: unknown[],
    answers: unknown[],
    studySessionId?: string,
  ) {
    await this.assertMember(cohortId, userId);

    // Simple scoring: count answers that match question.answer
    let score = 0;
    const qs = questions as Array<{ answer: string }>;
    const ans = answers as string[];
    qs.forEach((q, i) => { if (ans[i] === q.answer) score++; });

    return this.prisma.quizAttempt.create({
      data: {
        cohortId,
        userId,
        studySessionId: studySessionId ?? null,
        questions: questions as object,
        answers: answers as object,
        score,
      },
    });
  }

  async getAttempts(cohortId: string, userId: string) {
    return this.prisma.quizAttempt.findMany({
      where: { cohortId, userId },
      orderBy: { completedAt: 'desc' },
    });
  }

  // Live in-room "pop quiz": any member can fire it, and it's scoped to the video
  // currently on the stage. Returns questions to broadcast to the whole room — a
  // quick, shared, eventful break. Not persisted (it's a live moment, not a grade).
  async generatePopQuiz(
    roomId: string,
    userId: string,
    videoId?: string,
    numQuestions = 4,
  ) {
    const cohort = await this.prisma.cohort.findFirst({
      where: { roomId },
      include: {
        playlist: { include: { videos: { select: { ytVideoId: true, title: true } } } },
      },
    });
    if (!cohort?.playlist) throw new NotFoundException('Cohort not found');
    await this.assertMember(cohort.id, userId);

    const findTitle = (vid?: string | null) =>
      vid ? cohort.playlist!.videos.find((v) => v.ytVideoId === vid)?.title ?? null : null;
    let topic = findTitle(videoId);
    if (!topic) {
      const current = await this.getRoomCurrentSession(roomId);
      topic = findTitle(current?.videoIds?.[0]) || current?.topic || cohort.playlist.title;
    }

    try {
      const { data } = await axios.post(
        `${AI_URL}/quiz`,
        {
          playlistTitle: `${cohort.playlist.title} — ${topic}`,
          topics: [topic].filter(Boolean),
          numQuestions,
        },
        { timeout: 60_000 },
      );
      return { questions: data.questions, topic };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI service unavailable';
      throw new InternalServerErrorException(`Quiz generation failed: ${msg}`);
    }
  }

  // ── Topic checkpoints (hard-gated) ──────────────────────────────────────────

  // Per-member topic quiz results live in progress.topicQuizzes
  // ({ [topicIndex]: { score, total, passed, at } }) — same JSON bag as
  // watchedVideos, so no schema change.
  private getTopicQuizzes(
    progress: unknown,
  ): Record<string, { score: number; total: number; passed: boolean; at: string }> {
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      const tq = (progress as Record<string, unknown>).topicQuizzes;
      if (tq && typeof tq === 'object' && !Array.isArray(tq)) {
        return tq as Record<
          string,
          { score: number; total: number; passed: boolean; at: string }
        >;
      }
    }
    return {};
  }

  // Build the per-member topic gate from the curriculum: for each topic, its
  // videos + the caller's watched/complete/passed state, and whether it's
  // unlocked. HARD GATE: topic N unlocks only once topic N-1's checkpoint quiz
  // is passed (>= CHECKPOINT_PASS). Topics with no mapped videos pass through so
  // they can't dead-lock the cohort.
  private buildTopicGate(
    curriculum: Array<{ title?: string; description?: string; videoPositions?: number[] }>,
    videos: Array<{
      ytVideoId: string;
      title: string;
      thumbnailUrl?: string | null;
      position: number;
    }>,
    progress: unknown,
  ) {
    const watched = new Set(this.getWatchedVideos(progress));
    const quizzes = this.getTopicQuizzes(progress);
    const byPosition = new Map(videos.map((v) => [v.position, v]));

    const topics = curriculum.map((t, index) => {
      const vids = (t.videoPositions ?? [])
        .map((p) => byPosition.get(p))
        .filter((v): v is NonNullable<typeof v> => Boolean(v));
      const videoIds = vids.map((v) => v.ytVideoId);
      const watchedCount = videoIds.filter((v) => watched.has(v)).length;
      const complete = videoIds.length > 0 ? watchedCount === videoIds.length : true;
      const rec = quizzes[String(index)] ?? null;
      const passed = Boolean(rec?.passed) || videoIds.length === 0;
      return {
        index,
        title: t.title ?? `Topic ${index + 1}`,
        description: t.description ?? '',
        videos: vids.map((v) => ({
          ytVideoId: v.ytVideoId,
          title: v.title,
          thumbnailUrl: v.thumbnailUrl ?? null,
        })),
        videoIds,
        videoCount: videoIds.length,
        watchedCount,
        complete,
        passed,
        quiz: rec,
        unlocked: false,
      };
    });

    // No hard gate: every topic is always accessible. The checkpoint quiz is an
    // optional way to prove a topic, never a lock on the next one or on playback.
    for (const t of topics) t.unlocked = true;

    const topicOf = new Map<string, number>();
    for (const t of topics) {
      for (const v of t.videoIds) if (!topicOf.has(v)) topicOf.set(v, t.index);
    }
    return { topics, topicOf };
  }

  private async loadCurriculumAndVideos(cohortId: string) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: {
        playlist: {
          include: {
            plan: { select: { curriculum: true } },
            videos: {
              orderBy: { position: 'asc' },
              select: { ytVideoId: true, title: true, thumbnailUrl: true, position: true },
            },
          },
        },
      },
    });
    const curriculum =
      (cohort?.playlist?.plan?.curriculum as
        | Array<{ title?: string; description?: string; videoPositions?: number[] }>
        | undefined) ?? [];
    const videos = cohort?.playlist?.videos ?? [];
    return { cohort, curriculum, videos };
  }

  // Public: the caller's topic progression (drives the Topics tab + hard gate).
  async getTopics(cohortId: string, userId: string) {
    await this.assertMember(cohortId, userId);
    const { curriculum, videos } = await this.loadCurriculumAndVideos(cohortId);
    const member = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId } },
      select: { progress: true },
    });
    const { topics } = this.buildTopicGate(curriculum, videos, member?.progress);
    return {
      passRatio: CHECKPOINT_PASS,
      topics: topics.map((t) => ({
        index: t.index,
        title: t.title,
        description: t.description,
        videos: t.videos,
        videoCount: t.videoCount,
        watchedCount: t.watchedCount,
        complete: t.complete,
        passed: t.passed,
        unlocked: t.unlocked,
        quiz: t.quiz,
        canTakeQuiz: t.unlocked && t.complete && t.videoCount > 0,
      })),
    };
  }

  // Generate a checkpoint quiz scoped to one curriculum topic. Refused while the
  // topic is still locked (hard gate).
  async generateTopicQuiz(
    cohortId: string,
    userId: string,
    topicIndex: number,
    numQuestions = 5,
  ) {
    await this.assertMember(cohortId, userId);
    const { cohort, curriculum, videos } = await this.loadCurriculumAndVideos(cohortId);
    const topicDef = curriculum[topicIndex];
    if (!cohort?.playlist || !topicDef) throw new NotFoundException('Topic not found');

    const member = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId } },
      select: { progress: true },
    });
    const { topics } = this.buildTopicGate(curriculum, videos, member?.progress);
    if (!topics[topicIndex]?.unlocked) {
      throw new ForbiddenException('Pass the previous topic to unlock this checkpoint');
    }

    const quizTopics = [topicDef.title, ...topics[topicIndex].videos.map((v) => v.title)].filter(
      (x): x is string => Boolean(x),
    );
    try {
      const { data } = await axios.post(
        `${AI_URL}/quiz`,
        {
          playlistTitle: `${cohort.playlist.title} — ${topicDef.title ?? ''}`.trim(),
          topics: quizTopics,
          numQuestions,
        },
        { timeout: 60_000 },
      );
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI service unavailable';
      throw new InternalServerErrorException(`Quiz generation failed: ${msg}`);
    }
  }

  // Submit a topic checkpoint: score it, record the pass in progress.topicQuizzes
  // (sticky — once passed, stays passed, which unlocks the next topic), and keep
  // a QuizAttempt row for history/mastery.
  async submitTopicAttempt(
    cohortId: string,
    userId: string,
    topicIndex: number,
    questions: unknown[],
    answers: unknown[],
  ) {
    await this.assertMember(cohortId, userId);
    const qs = questions as Array<{ answer: string }>;
    const ans = answers as string[];
    let score = 0;
    qs.forEach((q, i) => { if (ans[i] === q.answer) score++; });
    const total = qs.length;
    const passedNow = total > 0 && score / total >= CHECKPOINT_PASS;

    const member = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId } },
      select: { progress: true },
    });
    const base =
      member?.progress && typeof member.progress === 'object' && !Array.isArray(member.progress)
        ? (member.progress as Record<string, unknown>)
        : {};
    const tq = { ...this.getTopicQuizzes(member?.progress) };
    const prev = tq[String(topicIndex)];
    const passed = Boolean(prev?.passed) || passedNow;
    tq[String(topicIndex)] = { score, total, passed, at: new Date().toISOString() };

    await this.prisma.cohortMember.update({
      where: { cohortId_userId: { cohortId, userId } },
      data: { progress: { ...base, topicQuizzes: tq } },
    });
    await this.prisma.quizAttempt.create({
      data: {
        cohortId,
        userId,
        studySessionId: null,
        questions: questions as object,
        answers: answers as object,
        score,
      },
    });
    return { score, total, passed };
  }

  // ── Progress / leaderboard ──────────────────────────────────────────────────

  // A cohort "holds" a day (keeps its shared streak) when at least half the crew
  // completed it — enough to feel like a group effort without being impossible.
  private cohortStreakQuorum(memberCount: number) {
    return Math.max(1, Math.ceil(memberCount / 2));
  }

  // Core per-member + cohort-wide progress, shared by the API and the email
  // nudges so both use the exact same "completed" definition. Rows include email
  // (for the cron) — the public API strips it.
  private async buildCohortProgress(cohortId: string) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { joinedAt: 'asc' },
        },
        playlist: { select: { title: true, _count: { select: { videos: true } } } },
      },
    });
    if (!cohort) return null;
    const totalVideos = cohort.playlist?._count.videos ?? 0;

    const allSessions = await this.prisma.studySession.findMany({
      where: { cohortId },
      orderBy: { orderIndex: 'asc' },
      select: { id: true, topic: true, scheduledAt: true, roomId: true, videoIds: true, status: true },
    });
    // POSTPONED days lapsed without completion and had their content carried
    // forward, so they don't count toward the plan's day total or completion.
    const sessions = allSessions.filter((s) => s.status !== 'POSTPONED');

    const now = new Date();
    const elapsed = sessions.filter((s) => s.scheduledAt <= now);
    const totalDays = sessions.length;

    const roomIds = [
      ...new Set(sessions.map((s) => s.roomId).filter((r): r is string => Boolean(r))),
    ];
    const [attendance, attempts] = await Promise.all([
      roomIds.length
        ? this.prisma.roomAttendance.findMany({
            where: { roomId: { in: roomIds } },
            select: { roomId: true, userId: true, joinedAt: true },
          })
        : Promise.resolve(
            [] as { roomId: string; userId: string; joinedAt: Date }[],
          ),
      this.prisma.quizAttempt.findMany({
        where: { cohortId, studySessionId: { not: null } },
        select: { userId: true, studySessionId: true, score: true, questions: true },
      }),
    ]);

    const passed = new Set<string>();
    const scoreByUser = new Map<string, { sum: number; n: number }>();
    for (const a of attempts) {
      const qCount = Array.isArray(a.questions) ? (a.questions as unknown[]).length : 5;
      const ratio = qCount > 0 ? a.score / qCount : 0;
      if (ratio >= CHECKPOINT_PASS && a.studySessionId) {
        passed.add(`${a.userId}::${a.studySessionId}`);
      }
      const cur = scoreByUser.get(a.userId) || { sum: 0, n: 0 };
      cur.sum += ratio;
      cur.n += 1;
      scoreByUser.set(a.userId, cur);
    }

    // Which elapsed day (if any) is today's session (IST day).
    const { start: tStart, end: tEnd } = this.dayBounds(now);
    const todayIdx = elapsed.findIndex(
      (s) => s.scheduledAt >= tStart && s.scheduledAt <= tEnd,
    );
    const perDayCompleted = new Array<number>(elapsed.length).fill(0);

    const rows = cohort.members.map((m) => {
      const caughtUp = this.getCaughtUpMap(m.progress);
      const watchedSet = new Set(this.getWatchedVideos(m.progress));
      let checkpointBackedDays = 0;
      let attendedDays = 0;
      // COMPLETED = real evidence of learning (passed checkpoint / watched all /
      // caught up). Attendance is participation only, tracked separately.
      const flags: boolean[] = elapsed.map((s, i) => {
        const didPass = passed.has(`${m.userId}::${s.id}`);
        const vids = s.videoIds ?? [];
        const watchedAll = vids.length > 0 && vids.every((v) => watchedSet.has(v));
        let attended = false;
        if (s.roomId) {
          const { start, end } = this.dayBounds(s.scheduledAt);
          attended = attendance.some(
            (a) => a.roomId === s.roomId && a.userId === m.userId && a.joinedAt >= start && a.joinedAt <= end,
          );
        }
        if (attended) attendedDays++;
        if (didPass) checkpointBackedDays++;
        const done = didPass || watchedAll || caughtUp[s.id] === true;
        if (done) perDayCompleted[i]++;
        return done;
      });

      const completed = flags.filter(Boolean).length;
      let streak = 0;
      for (let i = flags.length - 1; i >= 0 && flags[i]; i--) streak++;

      const sc = scoreByUser.get(m.userId);
      const behind = Math.max(0, elapsed.length - completed);
      return {
        userId: m.userId,
        name: m.user?.name || 'Member',
        email: m.user?.email || null,
        completed,
        totalDays,
        elapsed: elapsed.length,
        progressPct: totalDays ? Math.round((completed / totalDays) * 100) : 0,
        streak,
        behind,
        onTrack: behind === 0,
        videosWatched: watchedSet.size,
        avgCheckpointScore: sc && sc.n ? Math.round((sc.sum / sc.n) * 100) : null,
        checkpointBackedDays,
        attendedDays,
        completedToday: todayIdx >= 0 ? flags[todayIdx] : false,
      };
    });

    const quorum = this.cohortStreakQuorum(cohort.members.length);
    let cohortStreak = 0;
    for (let i = perDayCompleted.length - 1; i >= 0 && perDayCompleted[i] >= quorum; i--) {
      cohortStreak++;
    }

    return {
      cohortName: cohort.name,
      playlistTitle: cohort.playlist?.title ?? '',
      roomId: cohort.roomId,
      memberCount: cohort.members.length,
      totalDays,
      totalVideos,
      elapsedDays: elapsed.length,
      rows,
      cohortStreak,
      todaySession: todayIdx >= 0 ? elapsed[todayIdx] : null,
      todayCompletedCount: todayIdx >= 0 ? perDayCompleted[todayIdx] : 0,
    };
  }

  // Public progress view: per-member rows + leaderboard + the shared cohort
  // streak and today's crew completion (drives the "you're the missing one" UI).
  async getProgress(cohortId: string, userId: string) {
    const p = await this.buildCohortProgress(cohortId);
    if (!p) throw new NotFoundException('Cohort not found');

    // Strip email before it leaves the API.
    const strip = (r: (typeof p.rows)[number]) => {
      const { email: _email, ...rest } = r;
      return rest;
    };
    const leaderboard = [...p.rows]
      .sort((a, b) => b.completed - a.completed || (b.avgCheckpointScore ?? -1) - (a.avgCheckpointScore ?? -1))
      .map(strip);

    const me = p.rows.find((r) => r.userId === userId);
    return {
      totalDays: p.totalDays,
      totalVideos: p.totalVideos,
      elapsed: p.elapsedDays,
      cohortStreak: p.cohortStreak,
      memberCount: p.memberCount,
      todayCompletedCount: p.todayCompletedCount,
      hasTodaySession: Boolean(p.todaySession),
      // The cohort has reached its finish line once every planned day has
      // elapsed — drives the graduation moment + "re-form for the next course".
      finished: p.totalDays > 0 && p.elapsedDays >= p.totalDays,
      playlistTitle: p.playlistTitle,
      me: me ? strip(me) : null,
      leaderboard,
    };
  }

  // Evening (8 PM IST) "you're the missing one" nudge: for each cohort with a
  // session today, email the members who haven't completed it yet — but only
  // when there are real stakes (crewmates already studied today, or a shared
  // streak is on the line). This is the personal, social, loss-framed reminder.
  @Cron('0 20 * * *', { timeZone: 'Asia/Kolkata' })
  async sendCohortStreakNudges() {
    const { start, end } = this.dayBounds(new Date());
    const todays = await this.prisma.studySession.findMany({
      where: { scheduledAt: { gte: start, lte: end } },
      select: { cohortId: true },
      distinct: ['cohortId'],
    });

    const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');

    for (const t of todays) {
      const p = await this.buildCohortProgress(t.cohortId).catch(() => null);
      if (!p || !p.todaySession || !p.roomId) continue;

      // Only nudge when it stings: someone already did today, or a streak lives.
      if (p.todayCompletedCount === 0 && p.cohortStreak === 0) continue;

      const completedNames = p.rows.filter((r) => r.completedToday).map((r) => r.name);
      const missing = p.rows.filter((r) => !r.completedToday && r.email);
      if (missing.length === 0) continue;

      const joinUrl = `${frontendUrl}/room/${p.roomId}`;
      for (const m of missing) {
        await this.emailService.sendCohortStreakEmail(m.email!, {
          name: m.name,
          cohortName: p.cohortName,
          topic: p.todaySession.topic,
          joinUrl,
          personalStreak: m.streak,
          cohortStreak: p.cohortStreak,
          completedNames,
          memberCount: p.memberCount,
          behind: m.behind,
        });
      }
    }
  }

  // ── Video progress (per-member) ─────────────────────────────────────────────

  private getWatchedVideos(progress: unknown): string[] {
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      const w = (progress as Record<string, unknown>).watchedVideos;
      if (Array.isArray(w)) return w.filter((x): x is string => typeof x === 'string');
    }
    return [];
  }

  // Mark a video the member actually finished (live session OR self-paced
  // catch-up). Per-member only — never touches the shared schedule, so a synced
  // room stays in sync. No-ops if the room isn't a cohort or the user isn't a member.
  async markVideoWatched(roomId: string, userId: string, videoId: string) {
    if (!videoId) return { ok: false };
    const cohort = await this.prisma.cohort.findFirst({
      where: { roomId },
      select: { id: true, createdById: true },
    });
    if (!cohort) return { ok: false };
    const member = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId: cohort.id, userId } },
      select: { progress: true },
    });
    if (!member) return { ok: false };

    const watched = new Set(this.getWatchedVideos(member.progress));
    if (watched.has(videoId)) return { ok: true, videosWatched: watched.size };
    watched.add(videoId);

    const base =
      member.progress && typeof member.progress === 'object' && !Array.isArray(member.progress)
        ? (member.progress as Record<string, unknown>)
        : {};
    await this.prisma.cohortMember.update({
      where: { cohortId_userId: { cohortId: cohort.id, userId } },
      data: { progress: { ...base, watchedVideos: [...watched] } },
    });

    // Whole-cohort adaptive scheduling: only the cohort CREATOR (the de-facto
    // host) racing ahead moves the shared schedule — otherwise any one eager
    // member would silently rewrite everyone's plan and break the "we're all on
    // the same day" discipline. Others still race ahead in their own progress.
    // Best-effort — never blocks the write.
    if (userId === cohort.createdById) {
      void this.recomputeScheduleFromProgress(cohort.id).catch(() => undefined);
    }

    return { ok: true, videosWatched: watched.size };
  }

  // ── Adaptive scheduling (whole-cohort, both directions) ─────────────────────

  // Rebuild the FUTURE schedule from what the cohort has actually watched, in
  // BOTH directions:
  //   • AHEAD  — a video that belongs to a future day is already watched → it's
  //     dropped, the rest re-pack into fewer days, and now-empty trailing days
  //     are deleted (the cohort finishes sooner, nobody re-watches).
  //   • BEHIND — a video that was planned for a PAST day was never finished →
  //     it's carried forward into the upcoming days, creating extra days if the
  //     leftover no longer fits the remaining slots (nothing is silently lost).
  // Past days stay as historical records and TODAY's live content stays pinned
  // to today (never pulled forward), so the synced live spine is untouched; only
  // future sessions are rewritten / created / deleted. Idempotent: if the desired
  // future layout already matches, it no-ops — safe to call after any watch event
  // or nightly resolve.
  async recomputeScheduleFromProgress(cohortId: string) {
    const DEFAULT_DAILY_SEC = 2 * 3600;
    const DEFAULT_VIDEO_SEC = 12 * 60;

    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: {
        members: { select: { progress: true } },
        playlist: {
          include: {
            videos: {
              orderBy: { position: 'asc' },
              select: { ytVideoId: true, title: true, durationSec: true },
            },
          },
        },
      },
    });
    const videos = cohort?.playlist?.videos ?? [];
    if (!cohort || !videos.length) return { ok: false, changed: false };

    // Cohort-wide watched union.
    const watched = new Set<string>();
    for (const m of cohort.members) {
      for (const v of this.getWatchedVideos(m.progress)) watched.add(v);
    }

    const sessions = await this.prisma.studySession.findMany({
      where: { cohortId },
      orderBy: { scheduledAt: 'asc' },
    });
    if (!sessions.length) return { ok: false, changed: false };

    const now = new Date();
    const { end: endToday } = this.dayBounds(now);
    const { start: todayStart } = this.dayBounds(now);
    const futureSessions = sessions.filter((s) => s.scheduledAt > endToday);

    // TODAY's scheduled videos are the live content — pin them to today, never
    // pull them forward (the group is watching them now). Past days' videos are
    // NOT auto-covered: if they weren't watched they belong in `remaining` so the
    // behind case carries them forward.
    const covered = new Set<string>(watched);
    for (const s of sessions) {
      if (s.scheduledAt >= todayStart && s.scheduledAt <= endToday) {
        for (const vid of s.videoIds ?? []) covered.add(vid);
      }
    }
    // Skipped videos are excluded from the plan entirely — never re-scheduled, so
    // they don't affect the room's pace/ETA (they live in the catch-up list).
    for (const vid of cohort.skippedVideoIds ?? []) covered.add(vid);
    const remaining = videos.filter((v) => !covered.has(v.ytVideoId));

    const durSec = (v: { durationSec: number | null }) =>
      v.durationSec && v.durationSec > 0 ? v.durationSec : DEFAULT_VIDEO_SEC;
    const dailySec =
      (futureSessions[0]?.studyHours
        ? futureSessions[0].studyHours * 3600
        : sessions[0]?.studyHours
          ? sessions[0].studyHours * 3600
          : DEFAULT_DAILY_SEC) || DEFAULT_DAILY_SEC;

    // Pack the remaining videos into consecutive days by duration (>=1/day).
    const days: { videos: typeof remaining }[] = [];
    let cur: typeof remaining = [];
    let curSec = 0;
    for (const v of remaining) {
      const d = durSec(v);
      if (cur.length && curSec + d > dailySec) {
        days.push({ videos: cur });
        cur = [];
        curSec = 0;
      }
      cur.push(v);
      curSec += d;
    }
    if (cur.length) days.push({ videos: cur });

    // Change detection: if the future layout already equals the desired one,
    // do nothing (avoids pointless writes when called on every watch event).
    const sameIds = (a: string[], b: string[]) =>
      a.length === b.length && a.every((x, i) => x === b[i]);
    const desired = days.map((d) => d.videos.map((v) => v.ytVideoId));
    const currentFuture = futureSessions.map((s) => s.videoIds ?? []);
    if (
      desired.length === currentFuture.length &&
      desired.every((d, i) => sameIds(d, currentFuture[i]))
    ) {
      return { ok: true, changed: false };
    }

    // Anchor for any NEW days: strictly after both the last existing session and
    // today, so created sessions never land in the past.
    const lastAt = sessions[sessions.length - 1].scheduledAt;
    const anchor = new Date(Math.max(lastAt.getTime(), endToday.getTime()));
    let maxOrder = sessions.reduce((mx, s) => Math.max(mx, s.orderIndex), -1);

    const dataFor = (
      vids: typeof remaining,
      orderIndex: number,
    ) => {
      const totalSec = vids.reduce((a, v) => a + durSec(v), 0);
      return {
        videoIds: vids.map((v) => v.ytVideoId),
        topic: `Day ${orderIndex + 1}: ${vids[0].title}${vids.length > 1 ? ` +${vids.length - 1} more` : ''}`,
        description: vids.map((v) => v.title).join(' • '),
        studyHours: Math.round((totalSec / 3600) * 10) / 10,
        status: 'SCHEDULED' as const,
      };
    };

    // Rewrite existing future days, delete the ones no longer needed, and create
    // extra days when the carried-forward backlog needs more room than remains.
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    futureSessions.forEach((s, i) => {
      const day = days[i];
      if (day) {
        ops.push(
          this.prisma.studySession.update({
            where: { id: s.id },
            data: dataFor(day.videos, s.orderIndex),
          }),
        );
      } else {
        // No videos left for this slot — the cohort finished early.
        ops.push(this.prisma.studySession.delete({ where: { id: s.id } }));
      }
    });
    for (let i = futureSessions.length; i < days.length; i++) {
      maxOrder += 1;
      const scheduledAt = this.addDays(anchor, i - futureSessions.length + 1);
      ops.push(
        this.prisma.studySession.create({
          data: {
            cohortId,
            roomId: cohort.roomId,
            orderIndex: maxOrder,
            scheduledAt,
            ...dataFor(days[i].videos, maxOrder),
          },
        }),
      );
    }
    await this.prisma.$transaction(ops);

    return {
      ok: true,
      changed: true,
      remainingDays: days.length,
      removedDays: Math.max(0, futureSessions.length - days.length),
      addedDays: Math.max(0, days.length - futureSessions.length),
    };
  }

  // Creator-triggered recompute (a manual "recalculate" button), same engine.
  async recomputeScheduleManual(cohortId: string, userId: string) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      select: { createdById: true },
    });
    if (!cohort) throw new NotFoundException('Cohort not found');
    if (cohort.createdById !== userId) {
      throw new ForbiddenException('Only the creator can recompute the schedule');
    }
    return this.recomputeScheduleFromProgress(cohortId);
  }

  // ── Session-end checkpoint ──────────────────────────────────────────────────

  // Classify each video from what actually happened on the shared stage, then
  // move the schedule. Cohort-level states drive the ONE shared plan:
  //   • completed — in the cohort-watched set → dropped by the recompute.
  //   • started   — the resume point (RoomVideoState pointer) → stays in the plan.
  //   • skipped   — a video the cohort jumped PAST (before the furthest-reached
  //                 point, unwatched, not the resume point) → dropped from the
  //                 plan into the catch-up set, so it never affects pace.
  // (missed is per-user — handled by attendance + the nudge email, never the
  // shared schedule.) Idempotent; safe to call on host "end session" and nightly.
  async endCohortSession(cohortId: string) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: {
        members: { select: { progress: true } },
        playlist: {
          include: {
            videos: { select: { ytVideoId: true }, orderBy: { position: 'asc' } },
          },
        },
      },
    });
    if (!cohort?.roomId || !cohort.playlist) return { ok: false, skipped: 0 };

    const videos = cohort.playlist.videos ?? [];
    const indexOf = new Map(videos.map((v, i) => [v.ytVideoId, i]));

    const watched = new Set<string>();
    for (const m of cohort.members) {
      for (const v of this.getWatchedVideos(m.progress)) watched.add(v);
    }
    const already = new Set(cohort.skippedVideoIds ?? []);

    const state = await this.prisma.roomVideoState.findUnique({
      where: { roomId: cohort.roomId },
      select: { videoId: true },
    });
    const reachedId = state?.videoId ?? null;

    // Furthest point the cohort reached = the max index across watched videos and
    // the current pointer (handles back-jumps too).
    let furthest = reachedId != null ? indexOf.get(reachedId) ?? -1 : -1;
    for (const w of watched) {
      const i = indexOf.get(w);
      if (i != null && i > furthest) furthest = i;
    }
    if (furthest < 0) return { ok: true, skipped: 0 };

    const newlySkipped: string[] = [];
    for (const v of videos) {
      const i = indexOf.get(v.ytVideoId) ?? -1;
      if (
        i > -1 &&
        i < furthest &&
        !watched.has(v.ytVideoId) &&
        v.ytVideoId !== reachedId &&
        !already.has(v.ytVideoId)
      ) {
        newlySkipped.push(v.ytVideoId);
      }
    }

    if (newlySkipped.length) {
      await this.prisma.cohort.update({
        where: { id: cohortId },
        data: { skippedVideoIds: [...already, ...newlySkipped] },
      });
    }
    // Recompute the remaining plan (drops completed + skipped, keeps the started
    // resume point, re-packs the rest) — pure arithmetic, no LLM.
    await this.recomputeScheduleFromProgress(cohortId).catch(() => undefined);
    return { ok: true, skipped: newlySkipped.length };
  }

  // Host-triggered "end today's session" (creator only), same engine as nightly.
  async endCohortSessionByRoom(roomId: string, userId: string) {
    const cohort = await this.prisma.cohort.findFirst({
      where: { roomId },
      select: { id: true, createdById: true },
    });
    if (!cohort) throw new NotFoundException('Cohort not found');
    if (cohort.createdById !== userId) {
      throw new ForbiddenException('Only the host can end the session');
    }
    return this.endCohortSession(cohort.id);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async assertMember(cohortId: string, userId: string) {
    const m = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId } },
    });
    if (!m) throw new ForbiddenException('You are not a member of this cohort');
  }
}
