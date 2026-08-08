import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { Cron } from '@nestjs/schedule';
import { EmailService } from '../email/email.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

export interface CreateCohortInput {
  playlistId: string;
  name: string;
  maxSize?: number;
  startMode?: 'NOW' | 'SCHEDULED';
  dailyTime?: string;
  startDate?: string;
  sessions?: { topic: string; description?: string; studyHours?: number }[];
}

export interface UpdateCohortInput {
  name?: string;
  dailyTime?: string;
  startDate?: string;
}

export interface SetPlanInput {
  sessions?: { topic: string; description?: string; studyHours?: number }[];
  dailyTime?: string;
  startDate?: string;
}

@Injectable()
export class CohortsService {
  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  // ── Cohorts ───────────────────────────────────────────────────────────────

  async createCohort(userId: string, input: CreateCohortInput) {
    const { playlistId, name, maxSize = 10, startMode, dailyTime, startDate, sessions } = input;

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
        maxSize,
        startMode: startMode ?? null,
        dailyTime: dailyTime ?? null,
        startDate: startMode ? firstStart : null,
        members: { create: { userId, progress: {} } },
      },
    });

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
      await this.prisma.cohort.update({ where: { id: cohort.id }, data: { roomId } });

      const dayList = Array.isArray(sessions) ? sessions : [];
      if (dayList.length) {
        await this.prisma.studySession.createMany({
          data: dayList.map((s, i) => ({
            cohortId: cohort.id,
            topic: s.topic,
            description: s.description ?? null,
            studyHours: s.studyHours ?? null,
            scheduledAt: this.addDays(firstStart, i),
            roomId,
            orderIndex: i,
            status: 'SCHEDULED',
          })),
        });
      }
    }

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
          scheduledAt: this.addDays(firstStart, i),
          roomId,
          orderIndex: i,
          status: 'SCHEDULED',
        })),
      });
    }

    return this.getCohort(cohortId, userId);
  }

  private addDays(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  private dayBounds(date: Date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  // ── Daily cohort session engine ─────────────────────────────────────────────

  // Each morning: email members today's topic + room link, and arm the existing
  // 15-minute room reminder for today's occurrence.
  @Cron('0 8 * * *')
  async notifyTodaysCohortSessions() {
    const { start, end } = this.dayBounds(new Date());
    const sessions = await this.prisma.studySession.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { gte: start, lte: end } },
      include: {
        cohort: {
          include: { members: { include: { user: { select: { email: true } } } } },
        },
      },
    });

    const frontendUrl = process.env.FRONTEND_URL || '';
    for (const session of sessions) {
      const roomId = session.roomId || session.cohort.roomId;
      if (!roomId) continue;
      const joinUrl = `${frontendUrl}/room/${roomId}`;

      await this.prisma.room
        .update({
          where: { roomId },
          data: { startTime: session.scheduledAt, remindersent: false },
        })
        .catch(() => undefined);

      for (const member of session.cohort.members) {
        if (member.user?.email) {
          await this.emailService.sendCohortSessionEmail(
            member.user.email,
            session.cohort.name,
            session.topic,
            joinUrl,
          );
        }
      }
    }
  }

  // Just after midnight: resolve yesterday's sessions. If anyone attended the
  // room that day, mark it COMPLETED; otherwise POSTPONE it and shift every later
  // scheduled session one day forward (nothing gets skipped).
  @Cron('5 0 * * *')
  async resolveMissedCohortSessions() {
    const yesterday = this.addDays(new Date(), -1);
    const { start, end } = this.dayBounds(yesterday);

    const sessions = await this.prisma.studySession.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { gte: start, lte: end } },
    });

    for (const session of sessions) {
      const attended = session.roomId
        ? await this.prisma.roomAttendance.count({
            where: { roomId: session.roomId, joinedAt: { gte: start, lte: end } },
          })
        : 0;

      if (attended > 0) {
        await this.prisma.studySession.update({
          where: { id: session.id },
          data: { status: 'COMPLETED' },
        });
      } else {
        const later = await this.prisma.studySession.findMany({
          where: {
            cohortId: session.cohortId,
            status: 'SCHEDULED',
            orderIndex: { gte: session.orderIndex },
          },
        });
        for (const s of later) {
          await this.prisma.studySession.update({
            where: { id: s.id },
            data: { scheduledAt: this.addDays(s.scheduledAt, 1) },
          });
        }
      }
    }
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
      include: { _count: { select: { members: true } } },
    });
    if (!cohort) throw new NotFoundException('Cohort not found');
    if (cohort._count.members >= cohort.maxSize) {
      throw new BadRequestException('Cohort is full');
    }

    return this.prisma.cohortMember.upsert({
      where: { cohortId_userId: { cohortId, userId } },
      create: { cohortId, userId, progress: {} },
      update: {},
    });
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
    // Members, study sessions, discussions and quiz attempts cascade on delete.
    await this.prisma.cohort.delete({ where: { id: cohortId } });
    return { ok: true };
  }

  // ── Discussions ───────────────────────────────────────────────────────────

  async getDiscussions(cohortId: string) {
    return this.prisma.discussionPost.findMany({
      where: { cohortId, parentId: null },
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

  async postDiscussion(cohortId: string, userId: string, content: string, parentId?: string) {
    await this.assertMember(cohortId, userId);
    return this.prisma.discussionPost.create({
      data: { cohortId, authorId: userId, content, parentId: parentId ?? null },
      include: { author: { select: { id: true, name: true } } },
    });
  }

  // ── Study Sessions ────────────────────────────────────────────────────────

  async getSessions(cohortId: string) {
    return this.prisma.studySession.findMany({
      where: { cohortId },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async createSession(cohortId: string, userId: string, topic: string, scheduledAt: Date) {
    await this.assertMember(cohortId, userId);
    return this.prisma.studySession.create({
      data: { cohortId, topic, scheduledAt },
    });
  }

  // ── Quizzes ───────────────────────────────────────────────────────────────

  async generateQuiz(cohortId: string, userId: string, numQuestions = 5) {
    await this.assertMember(cohortId, userId);

    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      include: { playlist: { include: { plan: true } } },
    });
    if (!cohort?.playlist?.plan) {
      throw new BadRequestException('No AI plan generated for this cohort yet');
    }

    const curriculum = cohort.playlist.plan.curriculum as Array<{ title: string }>;
    const topics = curriculum.map((t) => t.title);

    try {
      const { data } = await axios.post(`${AI_URL}/quiz`, {
        playlistTitle: cohort.playlist.title,
        topics,
        numQuestions,
      }, { timeout: 60_000 });
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI service unavailable';
      throw new InternalServerErrorException(`Quiz generation failed: ${msg}`);
    }
  }

  async submitAttempt(cohortId: string, userId: string, questions: unknown[], answers: unknown[]) {
    await this.assertMember(cohortId, userId);

    // Simple scoring: count answers that match question.answer
    let score = 0;
    const qs = questions as Array<{ answer: string }>;
    const ans = answers as string[];
    qs.forEach((q, i) => { if (ans[i] === q.answer) score++; });

    return this.prisma.quizAttempt.create({
      data: { cohortId, userId, questions: questions as object, answers: answers as object, score },
    });
  }

  async getAttempts(cohortId: string, userId: string) {
    return this.prisma.quizAttempt.findMany({
      where: { cohortId, userId },
      orderBy: { completedAt: 'desc' },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async assertMember(cohortId: string, userId: string) {
    const m = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId } },
    });
    if (!m) throw new ForbiddenException('You are not a member of this cohort');
  }
}
