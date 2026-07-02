import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

@Injectable()
export class CohortsService {
  constructor(private prisma: PrismaService) {}

  // ── Cohorts ───────────────────────────────────────────────────────────────

  async createCohort(userId: string, playlistId: string, name: string, maxSize = 10) {
    const playlist = await this.prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!playlist) throw new NotFoundException('Playlist not found');

    const cohort = await this.prisma.cohort.create({
      data: {
        playlistId,
        name,
        createdById: userId,
        maxSize,
        members: { create: { userId, progress: {} } },
      },
      include: { playlist: { include: { plan: true } }, members: true },
    });
    return cohort;
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
