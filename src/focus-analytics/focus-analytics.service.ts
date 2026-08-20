import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface SaveFocusDto {
  roomId: string;
  roomName?: string;
  durationMinutes: number;
  focusScore: number;
  engagementScore: number;
  distractionCount: number;
  offScreenSeconds: number;
  highFocusPercent: number;
  medFocusPercent: number;
  lowFocusPercent: number;
  totalSamples: number;
  noteTakingPercent?: number;
  phonePercent?: number;
  drowsinessPercent?: number;
  lookAwayPercent?: number;
  longestFocusStreakSec?: number;
}

const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));

@Injectable()
export class FocusAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async save(userId: string, dto: SaveFocusDto) {
    return this.prisma.focusSession.create({
      data: {
        userId,
        roomId: dto.roomId,
        roomName: dto.roomName ?? null,
        durationMinutes: Math.max(0, Math.round(dto.durationMinutes)),
        focusScore: clamp(dto.focusScore),
        engagementScore: clamp(dto.engagementScore),
        distractionCount: Math.max(0, dto.distractionCount),
        offScreenSeconds: Math.max(0, dto.offScreenSeconds),
        highFocusPercent: clamp(dto.highFocusPercent),
        medFocusPercent: clamp(dto.medFocusPercent),
        lowFocusPercent: clamp(dto.lowFocusPercent),
        totalSamples: Math.max(0, dto.totalSamples),
        noteTakingPercent: clamp(dto.noteTakingPercent ?? 0),
        phonePercent: clamp(dto.phonePercent ?? 0),
        drowsinessPercent: clamp(dto.drowsinessPercent ?? 0),
        lookAwayPercent: clamp(dto.lookAwayPercent ?? 0),
        longestFocusStreakSec: Math.max(0, Math.round(dto.longestFocusStreakSec ?? 0)),
      },
    });
  }

  async getSummary(userId: string) {
    const sessions = await this.prisma.focusSession.findMany({
      where: { userId },
      orderBy: { sessionDate: 'desc' },
      take: 100,
    });

    if (sessions.length === 0) {
      return {
        avgFocusScore: 0,
        avgEngagementScore: 0,
        totalAnalyzedSessions: 0,
        trend: 'none',
        bestFocusScore: 0,
        recentSessions: [],
      };
    }

    const avg = (arr: number[]) =>
      arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    const avgFocusScore = avg(sessions.map((s) => s.focusScore));
    const avgEngagementScore = avg(sessions.map((s) => s.engagementScore));
    const bestFocusScore = Math.max(...sessions.map((s) => s.focusScore));

    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const recent = sessions.filter(
      (s) => now - s.sessionDate.getTime() < sevenDays,
    );
    const previous = sessions.filter((s) => {
      const age = now - s.sessionDate.getTime();
      return age >= sevenDays && age < 2 * sevenDays;
    });

    let trend: 'improving' | 'declining' | 'stable' | 'none' = 'none';
    if (recent.length > 0 && previous.length > 0) {
      const recentAvg = avg(recent.map((s) => s.focusScore));
      const prevAvg = avg(previous.map((s) => s.focusScore));
      if (recentAvg - prevAvg > 5) trend = 'improving';
      else if (prevAvg - recentAvg > 5) trend = 'declining';
      else trend = 'stable';
    } else if (recent.length > 0) {
      trend = 'stable';
    }

    return {
      avgFocusScore,
      avgEngagementScore,
      bestFocusScore,
      totalAnalyzedSessions: sessions.length,
      trend,
      recentSessions: sessions.slice(0, 15).map((s) => ({
        id: s.id,
        roomId: s.roomId,
        roomName: s.roomName,
        sessionDate: s.sessionDate,
        durationMinutes: s.durationMinutes,
        focusScore: s.focusScore,
        engagementScore: s.engagementScore,
        distractionCount: s.distractionCount,
        offScreenSeconds: s.offScreenSeconds,
        highFocusPercent: s.highFocusPercent,
        medFocusPercent: s.medFocusPercent,
        lowFocusPercent: s.lowFocusPercent,
        noteTakingPercent: s.noteTakingPercent,
        phonePercent: s.phonePercent,
        drowsinessPercent: s.drowsinessPercent,
        lookAwayPercent: s.lookAwayPercent,
        longestFocusStreakSec: s.longestFocusStreakSec,
      })),
    };
  }

  async getLatestForRoom(userId: string, roomId: string) {
    return this.prisma.focusSession.findFirst({
      where: { userId, roomId },
      orderBy: { sessionDate: 'desc' },
    });
  }
}
