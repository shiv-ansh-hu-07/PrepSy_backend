import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const MAX_PLANS_PER_USER = 20;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// AI study planner: a chat that collects what the student studies, their
// goal, deadline and weekly time, then a generated week-by-week schedule
// they can tick off. The AI service does the talking/planning; this stores
// plans and progress per user.
@Injectable()
export class PlannerService {
  constructor(private readonly prisma: PrismaService) {}

  private todayIst() {
    return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  }

  private aiError(err: unknown, what: string) {
    const detail =
      axios.isAxiosError(err) && typeof err.response?.data?.detail === 'string'
        ? err.response.data.detail
        : err instanceof Error
          ? err.message
          : 'AI service unavailable';
    // The AI service already prefixes its own errors ("Plan generation failed: …").
    return new InternalServerErrorException(
      detail.startsWith(what) ? detail : `${what}: ${detail}`,
    );
  }

  private cleanChat(messages: unknown): ChatTurn[] {
    if (!Array.isArray(messages)) return [];
    return messages
      .filter(
        (m): m is ChatTurn =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatTurn).role === 'user' ||
            (m as ChatTurn).role === 'assistant') &&
          typeof (m as ChatTurn).content === 'string',
      )
      .slice(-40)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  }

  // What the profile already tells us, so the coach confirms instead of asking.
  private async knownAbout(userId: string) {
    const p = await this.prisma.userProfile.findUnique({ where: { userId } });
    if (!p) return {};
    const list = (a?: string[] | null) => (a && a.length ? a.join(', ') : null);
    return {
      examTargets: list(p.examTargets),
      goals: list(p.goals),
      skills: list(p.skills),
      interests: list(p.interests),
      education:
        [
          p.degree,
          p.branch,
          p.semester && `semester ${p.semester}`,
          p.institutionName,
        ]
          .filter(Boolean)
          .join(', ') || null,
      experienceLevel: p.experienceLevel,
      dailyStudyGoal: p.dailyStudyGoalMinutes
        ? `${p.dailyStudyGoalMinutes} minutes/day`
        : null,
    };
  }

  async chat(userId: string, messages: unknown) {
    const turns = this.cleanChat(messages);
    try {
      const { data } = await axios.post(
        `${AI_URL}/planner/chat`,
        {
          messages: turns,
          known: await this.knownAbout(userId),
          today: this.todayIst(),
        },
        { timeout: 60_000 },
      );
      return data;
    } catch (err) {
      throw this.aiError(err, 'Planner chat failed');
    }
  }

  async createPlan(userId: string, profile: unknown, messages: unknown) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new BadRequestException('Missing plan details');
    }
    const count = await this.prisma.studyPlan.count({ where: { userId } });
    if (count >= MAX_PLANS_PER_USER) {
      throw new BadRequestException(
        `You can keep up to ${MAX_PLANS_PER_USER} plans. Delete an old one first.`,
      );
    }
    let plan: { title?: string } & Record<string, unknown>;
    try {
      const { data } = await axios.post(
        `${AI_URL}/planner/plan`,
        { profile, today: this.todayIst() },
        { timeout: 150_000 },
      );
      plan = data;
    } catch (err) {
      throw this.aiError(err, 'Plan generation failed');
    }
    return this.prisma.studyPlan.create({
      data: {
        userId,
        title: String(plan.title || 'My study plan').slice(0, 160),
        profile: profile as Prisma.InputJsonValue,
        plan: plan as Prisma.InputJsonValue,
        chat: this.cleanChat(messages) as unknown as Prisma.InputJsonValue,
        progress: {},
      },
    });
  }

  listPlans(userId: string) {
    return this.prisma.studyPlan.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        plan: true,
        progress: true,
        createdAt: true,
      },
    });
  }

  private async own(userId: string, id: string) {
    const plan = await this.prisma.studyPlan.findUnique({ where: { id } });
    if (!plan || plan.userId !== userId)
      throw new NotFoundException('Plan not found');
    return plan;
  }

  getPlan(userId: string, id: string) {
    return this.own(userId, id);
  }

  async setTopicDone(
    userId: string,
    id: string,
    topicId: string,
    done: boolean,
  ) {
    const plan = await this.own(userId, id);
    if (typeof topicId !== 'string' || !/^w\d+t\d+$/.test(topicId)) {
      throw new BadRequestException('Invalid topic');
    }
    const progress = {
      ...((plan.progress &&
      typeof plan.progress === 'object' &&
      !Array.isArray(plan.progress)
        ? plan.progress
        : {}) as Record<string, boolean>),
    };
    if (done) progress[topicId] = true;
    else delete progress[topicId];
    const updated = await this.prisma.studyPlan.update({
      where: { id },
      data: { progress },
      select: { id: true, progress: true },
    });
    return updated;
  }

  // The plan a room follows (rooms created via "Create a room for this
  // plan"). Anyone in the room sees it; only the owner ticks topics.
  async getRoomPlan(userId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({
      where: { roomId },
      select: { studyPlanId: true },
    });
    if (!room?.studyPlanId) return null;
    const plan = await this.prisma.studyPlan.findUnique({
      where: { id: room.studyPlanId },
      select: {
        id: true,
        userId: true,
        title: true,
        plan: true,
        progress: true,
      },
    });
    if (!plan) return null;
    return {
      id: plan.id,
      title: plan.title,
      plan: plan.plan,
      progress: plan.progress,
      isOwner: plan.userId === userId,
    };
  }

  // Copy a plan into my planner, re-dated to start today. Allowed for my own
  // plans and for any plan a room follows (that's how room members get it).
  async copyPlan(userId: string, id: string) {
    const src = await this.prisma.studyPlan.findUnique({ where: { id } });
    if (!src) throw new NotFoundException('Plan not found');
    if (src.userId !== userId) {
      const shared = await this.prisma.room.findFirst({
        where: { studyPlanId: id },
        select: { id: true },
      });
      if (!shared) throw new NotFoundException('Plan not found');
    }
    const count = await this.prisma.studyPlan.count({ where: { userId } });
    if (count >= MAX_PLANS_PER_USER) {
      throw new BadRequestException(
        `You can keep up to ${MAX_PLANS_PER_USER} plans. Delete an old one first.`,
      );
    }
    return this.prisma.studyPlan.create({
      data: {
        userId,
        title: src.title,
        profile: src.profile as Prisma.InputJsonValue,
        plan: this.redate(src.plan, this.todayIst()) as Prisma.InputJsonValue,
        chat: [],
        progress: {},
      },
      select: { id: true },
    });
  }

  // Shift every date in a plan so it starts on `today` (same length).
  private redate(plan: unknown, today: string) {
    const p = (plan && typeof plan === 'object' ? plan : {}) as {
      meta?: Record<string, unknown>;
      weeks?: Record<string, unknown>[];
    };
    const start =
      typeof p.meta?.startDate === 'string' ? p.meta.startDate : null;
    if (!start) return p;
    const DAY = 86_400_000;
    const delta = Math.round(
      (new Date(today + 'T12:00:00Z').getTime() -
        new Date(start + 'T12:00:00Z').getTime()) /
        DAY,
    );
    const shift = (d: unknown) =>
      typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
        ? new Date(new Date(d + 'T12:00:00Z').getTime() + delta * DAY)
            .toISOString()
            .slice(0, 10)
        : d;
    return {
      ...p,
      meta: {
        ...p.meta,
        startDate: shift(p.meta?.startDate),
        deadline: shift(p.meta?.deadline),
      },
      weeks: (p.weeks || []).map((w) => ({
        ...w,
        startDate: shift(w.startDate),
        endDate: shift(w.endDate),
      })),
    };
  }

  async deletePlan(userId: string, id: string) {
    await this.own(userId, id);
    await this.prisma.studyPlan.delete({ where: { id } });
    return { ok: true };
  }
}
