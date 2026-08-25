import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RoomServiceClient } from 'livekit-server-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';

type RoomStatsRecord = {
  roomId: string;
  startTime: Date | null;
  durationMinutes: number | null;
  isRecurring: boolean;
  recurrenceType: string | null;
  recurrenceEndDate: Date | null;
};

type AnalyticsAttendanceRecord = {
  id: string;
  roomId: string;
  joinedAt: Date;
  leftAt: Date | null;
  roomName: string | null;
  roomTags: string[];
  roomDurationMinutes: number | null;
};

type AnalyticsRoomMembershipRecord = {
  joinedAt: Date;
  room: {
    roomId: string;
    name: string;
    tags: string[];
    createdAt: Date;
  };
};

@Injectable()
export class StatsService {
  private readonly attendanceTimeZone = 'Asia/Kolkata';
  private readonly timeZoneAliases: Record<string, string> = {
    'Asia/Calcutta': 'Asia/Kolkata',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceService: PresenceService,
  ) {}

  async getStats() {
    const [rooms, todayAttendance, historicalRooms, historicalAttendance] =
      await Promise.all([
        this.prisma.room.findMany({
          where: {
            visibility: 'PUBLIC',
            startTime: { not: null },
            durationMinutes: { not: null },
          },
          select: {
            roomId: true,
            startTime: true,
            durationMinutes: true,
            isRecurring: true,
            recurrenceType: true,
            recurrenceEndDate: true,
          },
        }),
        this.prisma.roomAttendance.findMany({
          where: {
            joinedAt: this.getTodayAttendanceRange(),
          },
          select: {
            roomId: true,
            userId: true,
          },
        }),
        this.prisma.room.findMany({
          where: {
            durationMinutes: { not: null },
          },
          select: {
            roomId: true,
            durationMinutes: true,
          },
        }),
        this.prisma.roomAttendance.findMany({
          distinct: ['roomId'],
          select: {
            roomId: true,
          },
        }),
      ]);

    const visibleRooms = rooms.filter((room) =>
      this.shouldShowPublicRoom(room),
    );
    const scheduledActiveRooms = visibleRooms.filter((room) =>
      this.isRoomActive(room),
    );
    const liveRoomStats = await this.getLiveKitRoomStats();

    const presentSiteUsers = this.presenceService.getActiveUserIds();
    const activeUsers =
      liveRoomStats === null
        ? new Set([
            ...todayAttendance.map((entry) => entry.userId),
            ...presentSiteUsers,
          ]).size
        : new Set([...liveRoomStats.activeUserIds, ...presentSiteUsers]).size;
    const avgFocusMinutes = this.getHistoricalAverageRoomMinutes(
      historicalRooms,
      historicalAttendance,
    );

    return {
      stats: {
        activeRooms:
          liveRoomStats === null
            ? scheduledActiveRooms.length
            : liveRoomStats.activeRooms,
        activeUsers,
        avgFocus: avgFocusMinutes,
        avgFocusLabel: this.formatMinutes(avgFocusMinutes),
      },
    };
  }

  async getUserAnalytics(userId: string) {
    const now = new Date();
    const timeZone = this.normalizeTimeZone(this.attendanceTimeZone);

    const [user, attendance, memberships, userProfile] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
        },
      }),
      this.prisma.roomAttendance.findMany({
        where: { userId },
        orderBy: {
          joinedAt: 'asc',
        },
      }),
      this.prisma.roomMember.findMany({
        where: { userId },
        include: {
          room: {
            select: {
              roomId: true,
              name: true,
              tags: true,
              createdAt: true,
            },
          },
        },
        orderBy: {
          joinedAt: 'desc',
        },
      }),
      this.prisma.userProfile.findUnique({
        where: { userId },
        select: { dailyStudyGoalMinutes: true },
      }),
    ]);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const attendanceRows = (attendance as AnalyticsAttendanceRecord[]).map(
      (entry) => {
        const minutes = this.getAttendanceMinutes(entry, now, timeZone);
        const completed =
          Boolean(entry.leftAt) &&
          Number(entry.leftAt?.getTime()) > entry.joinedAt.getTime();

        return {
          id: entry.id,
          roomId: entry.roomId,
          roomName: entry.roomName ?? 'Study room',
          tags: entry.roomTags || [],
          joinedAt: entry.joinedAt,
          leftAt: entry.leftAt,
          dateKey: this.getDateKeyInTimeZone(entry.joinedAt, timeZone),
          minutes,
          completed,
        };
      },
    );

    const completedRows = attendanceRows.filter((entry) => entry.completed);
    const liveRows = attendanceRows.filter(
      (entry) => !entry.completed && entry.minutes > 0,
    );
    const completedDateKeys = Array.from(
      new Set(completedRows.map((entry) => entry.dateKey)),
    ).sort();
    const totalFocusMinutes = completedRows.reduce(
      (total, entry) => total + entry.minutes,
      0,
    );
    const liveFocusMinutes = liveRows.reduce(
      (total, entry) => total + entry.minutes,
      0,
    );
    const currentStreakDays = this.getCurrentStudyStreak(
      completedDateKeys,
      now,
      timeZone,
    );
    const bestStreakDays = this.getBestStudyStreak(completedDateKeys);
    const minutesByDate = this.getMinutesByDate(completedRows);
    const monthDateKeys = this.getMonthDateKeys(now, timeZone);
    const weekDateKeys = this.getWeekDateKeys(now, timeZone);
    const studiedDaysThisWeek = weekDateKeys.filter(
      (dateKey) => (minutesByDate.get(dateKey) || 0) > 0,
    ).length;

    const rooms = this.getRoomAnalytics(attendanceRows);
    const topics = this.getTopicAnalytics(completedRows);
    const joinedRooms = this.getJoinedRoomAnalytics(
      memberships as AnalyticsRoomMembershipRecord[],
    );

    return {
      analytics: {
        generatedAt: now.toISOString(),
        timeZone,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        summary: {
          totalFocusMinutes,
          totalFocusLabel: this.formatMinutes(totalFocusMinutes),
          liveFocusMinutes,
          liveFocusLabel: this.formatMinutes(liveFocusMinutes),
          sessionsJoined: attendanceRows.length,
          sessionsCompleted: completedRows.length,
          roomsJoined: joinedRooms.length,
          topicsStudied: topics.length,
          completedStudyDays: completedDateKeys.length,
          currentStreakDays,
          bestStreakDays,
          studiedDaysThisWeek,
          consistencyScore: Math.round((studiedDaysThisWeek / 7) * 100),
          dailyStudyGoalMinutes: userProfile?.dailyStudyGoalMinutes ?? 0,
        },
        heatmap: {
          month: `${this.getDatePartsInTimeZone(now, timeZone).year}-${String(
            this.getDatePartsInTimeZone(now, timeZone).month,
          ).padStart(2, '0')}`,
          days: monthDateKeys.map((dateKey) => ({
            date: dateKey,
            minutes: minutesByDate.get(dateKey) || 0,
          })),
        },
        weeklyFocus: weekDateKeys.map((dateKey) => ({
          date: dateKey,
          minutes: minutesByDate.get(dateKey) || 0,
        })),
        rooms,
        topics,
        classes: attendanceRows
          .slice()
          .sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime())
          .map((entry) => ({
            id: entry.id,
            roomId: entry.roomId,
            roomName: entry.roomName,
            tags: entry.tags,
            joinedAt: entry.joinedAt.toISOString(),
            leftAt: entry.leftAt?.toISOString() || null,
            minutes: entry.completed ? entry.minutes : 0,
            liveMinutes: entry.completed ? 0 : entry.minutes,
            completed: entry.completed,
          })),
        joinedRooms,
        achievements: this.getAchievements({
          completedRows,
          completedDateKeys,
          bestStreakDays,
        }),
      },
    };
  }

  private getLiveKitHost() {
    const wsUrl = process.env.LIVEKIT_WS_URL;
    if (!wsUrl) return null;

    if (wsUrl.startsWith('wss://')) {
      return wsUrl.replace('wss://', 'https://');
    }

    if (wsUrl.startsWith('ws://')) {
      return wsUrl.replace('ws://', 'http://');
    }

    return wsUrl;
  }

  private getRoomServiceClient() {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const host = this.getLiveKitHost();

    if (!apiKey || !apiSecret || !host) {
      return null;
    }

    return new RoomServiceClient(host, apiKey, apiSecret);
  }

  private async getLiveKitRoomStats() {
    const roomService = this.getRoomServiceClient();

    if (!roomService) {
      return null;
    }

    try {
      const liveRooms = await roomService.listRooms();
      const activeRooms = liveRooms.filter(
        (room) => (room.numParticipants ?? 0) > 0,
      );
      const participantLists = await Promise.all(
        activeRooms.map(async (room) => {
          try {
            return await roomService.listParticipants(room.name);
          } catch {
            return [];
          }
        }),
      );
      const activeUserIds = participantLists
        .flatMap((participants) =>
          participants.map((participant) => participant.identity),
        )
        .filter(Boolean);

      return {
        activeRooms: activeRooms.length,
        activeUsers: activeUserIds.length,
        activeUserIds,
      };
    } catch {
      return null;
    }
  }

  private getHistoricalAverageRoomMinutes(
    rooms: { roomId: string; durationMinutes: number | null }[],
    attendance: { roomId: string }[],
  ) {
    const usedRoomIds = new Set(attendance.map((entry) => entry.roomId));
    const usedDurations = rooms
      .filter(
        (room) =>
          usedRoomIds.has(room.roomId) &&
          typeof room.durationMinutes === 'number' &&
          room.durationMinutes > 0,
      )
      .map((room) => room.durationMinutes as number);

    if (usedDurations.length === 0) {
      return 0;
    }

    return Math.round(
      usedDurations.reduce((total, duration) => total + duration, 0) /
        usedDurations.length,
    );
  }

  private formatMinutes(minutes: number) {
    if (minutes < 60) {
      return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes === 0
      ? `${hours}h`
      : `${hours}h ${remainingMinutes}m`;
  }

  // A single session can't legitimately run longer than this; it caps runaway
  // attendance rows so they can't post impossible hours to one day.
  private static readonly SESSION_CAP_MIN = 600; // 10h

  private getAttendanceMinutes(
    attendance: { joinedAt: Date; leftAt: Date | null },
    now: Date,
    timeZone: string,
  ) {
    if (!attendance.leftAt) {
      const joinedKey = this.getDateKeyInTimeZone(
        attendance.joinedAt,
        timeZone,
      );
      const todayKey = this.getDateKeyInTimeZone(now, timeZone);

      if (joinedKey !== todayKey) {
        return 0;
      }
    }

    const endAt = attendance.leftAt || now;
    const raw = Math.max(
      0,
      Math.round((endAt.getTime() - attendance.joinedAt.getTime()) / 60000),
    );

    // Cap the session length. A row can span far more than a real sitting when
    // the leave handler is skipped (crash / closed tab), when a session crosses
    // midnight, or when a stale row is finally closed on a much later leave —
    // all of which otherwise dump impossible hours onto the join date. Applied
    // on read, so already-inflated historical rows are corrected too, no
    // migration needed. Left uncapped by room duration on purpose: people often
    // study past a room's planned Pomodoro length, and that time is real.
    return Math.min(raw, StatsService.SESSION_CAP_MIN);
  }

  private getMinutesByDate(
    attendanceRows: {
      dateKey: string;
      minutes: number;
    }[],
  ) {
    return attendanceRows.reduce((minutesByDate, entry) => {
      minutesByDate.set(
        entry.dateKey,
        (minutesByDate.get(entry.dateKey) || 0) + entry.minutes,
      );
      return minutesByDate;
    }, new Map<string, number>());
  }

  private getRoomAnalytics(
    attendanceRows: {
      roomId: string;
      roomName: string;
      tags: string[];
      joinedAt: Date;
      minutes: number;
      completed: boolean;
    }[],
  ) {
    const byRoom = new Map<
      string,
      {
        roomId: string;
        name: string;
        tags: Set<string>;
        minutes: number;
        liveMinutes: number;
        sessions: number;
        completedSessions: number;
        lastJoinedAt: Date;
      }
    >();

    attendanceRows.forEach((entry) => {
      const current =
        byRoom.get(entry.roomId) ||
        ({
          roomId: entry.roomId,
          name: entry.roomName,
          tags: new Set<string>(),
          minutes: 0,
          liveMinutes: 0,
          sessions: 0,
          completedSessions: 0,
          lastJoinedAt: entry.joinedAt,
        } satisfies {
          roomId: string;
          name: string;
          tags: Set<string>;
          minutes: number;
          liveMinutes: number;
          sessions: number;
          completedSessions: number;
          lastJoinedAt: Date;
        });

      entry.tags.forEach((tag) => current.tags.add(tag));
      current.minutes += entry.completed ? entry.minutes : 0;
      current.liveMinutes += entry.completed ? 0 : entry.minutes;
      current.sessions += 1;
      current.completedSessions += entry.completed ? 1 : 0;

      if (entry.joinedAt > current.lastJoinedAt) {
        current.lastJoinedAt = entry.joinedAt;
      }

      byRoom.set(entry.roomId, current);
    });

    return Array.from(byRoom.values())
      .map((room) => ({
        roomId: room.roomId,
        name: room.name,
        tags: Array.from(room.tags),
        minutes: room.minutes,
        liveMinutes: room.liveMinutes,
        totalTimeLabel: this.formatMinutes(room.minutes),
        sessions: room.sessions,
        completedSessions: room.completedSessions,
        lastJoinedAt: room.lastJoinedAt.toISOString(),
      }))
      .sort((a, b) => b.minutes - a.minutes || b.sessions - a.sessions);
  }

  private getTopicAnalytics(
    attendanceRows: {
      tags: string[];
      minutes: number;
      completed: boolean;
    }[],
  ) {
    const byTopic = new Map<
      string,
      {
        name: string;
        minutes: number;
        sessions: number;
        completedSessions: number;
      }
    >();

    attendanceRows.forEach((entry) => {
      entry.tags.forEach((tag) => {
        const current =
          byTopic.get(tag) ||
          ({
            name: tag,
            minutes: 0,
            sessions: 0,
            completedSessions: 0,
          } satisfies {
            name: string;
            minutes: number;
            sessions: number;
            completedSessions: number;
          });

        current.minutes += entry.minutes;
        current.sessions += 1;
        current.completedSessions += entry.completed ? 1 : 0;
        byTopic.set(tag, current);
      });
    });

    return Array.from(byTopic.values())
      .map((topic) => ({
        ...topic,
        totalTimeLabel: this.formatMinutes(topic.minutes),
      }))
      .sort((a, b) => b.minutes - a.minutes || b.sessions - a.sessions);
  }

  private getJoinedRoomAnalytics(memberships: AnalyticsRoomMembershipRecord[]) {
    const uniqueRooms = new Map<string, AnalyticsRoomMembershipRecord>();

    memberships.forEach((membership) => {
      if (!uniqueRooms.has(membership.room.roomId)) {
        uniqueRooms.set(membership.room.roomId, membership);
      }
    });

    return Array.from(uniqueRooms.values()).map((membership) => ({
      roomId: membership.room.roomId,
      name: membership.room.name,
      tags: membership.room.tags || [],
      joinedAt: membership.joinedAt.toISOString(),
      createdAt: membership.room.createdAt.toISOString(),
    }));
  }

  private getAchievements({
    completedRows,
    completedDateKeys,
    bestStreakDays,
  }: {
    completedRows: { joinedAt: Date }[];
    completedDateKeys: string[];
    bestStreakDays: number;
  }) {
    const completedSessionCount = completedRows.length;
    const completedStudyDays = completedDateKeys.length;

    return [
      {
        id: 'first-session',
        title: 'Completing first session',
        description: 'Complete your first study session.',
        achieved: completedSessionCount >= 1,
        progress: Math.min(completedSessionCount, 1),
        target: 1,
        unlockedAt:
          completedSessionCount >= 1
            ? completedRows[0].joinedAt.toISOString()
            : null,
      },
      {
        id: 'seven-day-streak',
        title: 'Completing 7 continuous in 7 days',
        description: 'Complete sessions for 7 continuous days.',
        achieved: bestStreakDays >= 7,
        progress: Math.min(bestStreakDays, 7),
        target: 7,
        unlockedAt: this.getStreakUnlockedAt(completedDateKeys, 7),
      },
      {
        id: 'fifty-days',
        title: 'Completing 50 days',
        description: 'Complete sessions on 50 different days.',
        achieved: completedStudyDays >= 50,
        progress: Math.min(completedStudyDays, 50),
        target: 50,
        unlockedAt:
          completedStudyDays >= 50
            ? `${completedDateKeys[49]}T00:00:00.000Z`
            : null,
      },
      {
        id: 'hundred-days',
        title: 'Completing 100 days',
        description: 'Complete sessions on 100 different days.',
        achieved: completedStudyDays >= 100,
        progress: Math.min(completedStudyDays, 100),
        target: 100,
        unlockedAt:
          completedStudyDays >= 100
            ? `${completedDateKeys[99]}T00:00:00.000Z`
            : null,
      },
    ];
  }

  private getStreakUnlockedAt(dateKeys: string[], target: number) {
    let runLength = 0;
    let previousKey = '';

    for (const dateKey of dateKeys) {
      runLength =
        previousKey && this.shiftDateKey(previousKey, 1) === dateKey
          ? runLength + 1
          : 1;

      if (runLength >= target) {
        return `${dateKey}T00:00:00.000Z`;
      }

      previousKey = dateKey;
    }

    return null;
  }

  private getCurrentStudyStreak(
    completedDateKeys: string[],
    now: Date,
    timeZone: string,
  ) {
    const dateKeySet = new Set(completedDateKeys);
    const todayKey = this.getDateKeyInTimeZone(now, timeZone);
    const yesterdayKey = this.shiftDateKey(todayKey, -1);

    if (dateKeySet.has(todayKey)) {
      return this.getConsecutiveStudyDaysEndingAt(todayKey, dateKeySet);
    }

    if (dateKeySet.has(yesterdayKey)) {
      return this.getConsecutiveStudyDaysEndingAt(yesterdayKey, dateKeySet);
    }

    return 0;
  }

  private getBestStudyStreak(completedDateKeys: string[]) {
    let best = 0;
    let current = 0;
    let previousKey = '';

    completedDateKeys.forEach((dateKey) => {
      current =
        previousKey && this.shiftDateKey(previousKey, 1) === dateKey
          ? current + 1
          : 1;
      best = Math.max(best, current);
      previousKey = dateKey;
    });

    return best;
  }

  private getConsecutiveStudyDaysEndingAt(
    dateKey: string,
    dateKeySet: Set<string>,
  ) {
    let streak = 0;
    let currentKey = dateKey;

    while (dateKeySet.has(currentKey)) {
      streak += 1;
      currentKey = this.shiftDateKey(currentKey, -1);
    }

    return streak;
  }

  private getMonthDateKeys(now: Date, timeZone: string) {
    const parts = this.getDatePartsInTimeZone(now, timeZone);
    const dateKeys: string[] = [];

    for (let day = 1; day <= 31; day += 1) {
      const date = this.zonedTimeToUtc(
        parts.year,
        parts.month,
        day,
        0,
        0,
        timeZone,
      );
      const dateParts = this.getDatePartsInTimeZone(date, timeZone);

      if (dateParts.month !== parts.month) {
        break;
      }

      dateKeys.push(
        `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(
          dateParts.day,
        ).padStart(2, '0')}`,
      );
    }

    return dateKeys;
  }

  private getWeekDateKeys(now: Date, timeZone: string) {
    const todayKey = this.getDateKeyInTimeZone(now, timeZone);
    const todayParts = this.getDatePartsInTimeZone(now, timeZone);
    const dayOfWeek = new Date(
      Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day),
    ).getUTCDay();
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const mondayKey = this.shiftDateKey(todayKey, -daysSinceMonday);

    return Array.from({ length: 7 }, (_, index) =>
      this.shiftDateKey(mondayKey, index),
    );
  }

  private getDateKeyInTimeZone(date: Date, timeZone: string) {
    const parts = this.getDatePartsInTimeZone(date, timeZone);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(
      parts.day,
    ).padStart(2, '0')}`;
  }

  private shiftDateKey(dateKey: string, days: number) {
    const [yearText, monthText, dayText] = dateKey.split('-');
    const shifted = new Date(
      Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + days),
    );
    return shifted.toISOString().slice(0, 10);
  }

  private getTodayAttendanceRange() {
    const now = new Date();
    const parts = this.getDatePartsInTimeZone(now, this.attendanceTimeZone);

    return {
      gte: this.zonedTimeToUtc(
        parts.year,
        parts.month,
        parts.day,
        0,
        0,
        this.attendanceTimeZone,
      ),
      lt: this.zonedTimeToUtc(
        parts.year,
        parts.month,
        parts.day + 1,
        0,
        0,
        this.attendanceTimeZone,
      ),
    };
  }

  private normalizeTimeZone(timeZone: string) {
    return this.timeZoneAliases[timeZone] || timeZone;
  }

  private parseRecurrenceMeta(recurrenceType?: string | null) {
    if (!recurrenceType) {
      return { timeZone: null };
    }

    const [, timeZone] = recurrenceType.split('|');
    return {
      timeZone: timeZone || null,
    };
  }

  private getDatePartsInTimeZone(date: Date, timeZone: string) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.normalizeTimeZone(timeZone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });

    const parts = formatter.formatToParts(date);
    const read = (type: string) => {
      const value = parts.find((part) => part.type === type)?.value;
      return value ? Number(value) : 0;
    };

    return {
      year: read('year'),
      month: read('month'),
      day: read('day'),
      hour: read('hour'),
      minute: read('minute'),
      second: read('second'),
    };
  }

  private getTimeZoneOffsetMs(date: Date, timeZone: string) {
    const parts = this.getDatePartsInTimeZone(date, timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );

    return asUtc - date.getTime();
  }

  private zonedTimeToUtc(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timeZone: string,
  ) {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const offset = this.getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
    return new Date(utcGuess - offset);
  }

  private getRecurringWindow(room: RoomStatsRecord, baseDate: Date) {
    if (!room.startTime || !room.durationMinutes) {
      return null;
    }

    const recurrenceMeta = this.parseRecurrenceMeta(room.recurrenceType);
    const timeZone = this.normalizeTimeZone(
      recurrenceMeta.timeZone || this.attendanceTimeZone,
    );
    const scheduledTime = this.getDatePartsInTimeZone(room.startTime, timeZone);
    const targetDate = this.getDatePartsInTimeZone(baseDate, timeZone);
    const start = this.zonedTimeToUtc(
      targetDate.year,
      targetDate.month,
      targetDate.day,
      scheduledTime.hour,
      scheduledTime.minute,
      timeZone,
    );

    return {
      start,
      end: new Date(start.getTime() + room.durationMinutes * 60 * 1000),
    };
  }

  private shouldStopRecurringRoom(room: RoomStatsRecord) {
    if (!room.recurrenceEndDate || !room.startTime) {
      return false;
    }

    const recurrenceMeta = this.parseRecurrenceMeta(room.recurrenceType);
    const timeZone = this.normalizeTimeZone(
      recurrenceMeta.timeZone || this.attendanceTimeZone,
    );
    const endDate = this.getDatePartsInTimeZone(
      room.recurrenceEndDate,
      timeZone,
    );
    const startDate = this.getDatePartsInTimeZone(room.startTime, timeZone);

    const endKey = Date.UTC(endDate.year, endDate.month - 1, endDate.day);
    const startKey = Date.UTC(
      startDate.year,
      startDate.month - 1,
      startDate.day,
    );

    return startKey >= endKey;
  }

  private shouldShowPublicRoom(room: RoomStatsRecord) {
    if (!room.startTime || !room.durationMinutes) {
      return false;
    }

    if (room.isRecurring) {
      return !this.shouldStopRecurringRoom(room);
    }

    const endTime = new Date(
      room.startTime.getTime() + room.durationMinutes * 60 * 1000,
    );
    return new Date() <= endTime;
  }

  private isRoomActive(room: RoomStatsRecord) {
    if (!room.startTime || !room.durationMinutes) {
      return false;
    }

    const now = new Date();
    const durationMs = room.durationMinutes * 60 * 1000;

    if (!room.isRecurring) {
      const endTime = new Date(room.startTime.getTime() + durationMs);
      return now >= room.startTime && now <= endTime;
    }

    const currentWindow = this.getRecurringWindow(room, now);
    if (!currentWindow) {
      return false;
    }

    return now >= currentWindow.start && now <= currentWindow.end;
  }

  // Monday 00:00 in Asia/Kolkata, as a UTC instant.
  private weekStartUtc(): Date {
    const IST = 5.5 * 3600 * 1000;
    const nowIst = new Date(Date.now() + IST);
    const dowMon = (nowIst.getUTCDay() + 6) % 7; // 0 = Monday
    const istMidnight = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate());
    return new Date(istMidnight - dowMon * 86_400_000 - IST);
  }

  // Focus-time leaderboard. scope: 'friends' (me + accepted friends) or
  // 'global'; period: 'week' (this IST week) or 'all'.
  async getLeaderboard(
    userId: string,
    scope: 'friends' | 'global',
    period: 'week' | 'all',
  ) {
    const gte = period === 'all' ? undefined : this.weekStartUtc();

    let userFilter: string[] | undefined;
    if (scope === 'friends') {
      const edges = await this.prisma.friendship.findMany({
        where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
        select: { requesterId: true, addresseeId: true },
      });
      const ids = new Set<string>([userId]);
      edges.forEach((e) => {
        ids.add(e.requesterId);
        ids.add(e.addresseeId);
      });
      userFilter = [...ids];
    }

    // Rank by RoomAttendance minutes (same source as "Total Focus Time") so ALL
    // studying counts — YouTube co-learning watch parties and camera-off rooms
    // included — not just camera-monitored FocusSessions. Include in-progress
    // (open) rows too, so time shows while someone is still in the room / before
    // their leave lands. getAttendanceMinutes gives (leftAt − joinedAt) for
    // completed rows, (now − joinedAt) for rows still open TODAY, and 0 for stale
    // opens from earlier days (so a forgotten session can't inflate forever).
    const attendanceRows = await this.prisma.roomAttendance.findMany({
      where: {
        ...(gte ? { joinedAt: { gte } } : {}),
        ...(userFilter ? { userId: { in: userFilter } } : {}),
      },
      select: { userId: true, joinedAt: true, leftAt: true },
    });

    const nowTs = new Date();
    const tz = this.normalizeTimeZone(this.attendanceTimeZone);
    const minutesById = new Map<string, number>();
    for (const a of attendanceRows) {
      const mins = this.getAttendanceMinutes(a, nowTs, tz);
      if (mins > 0) {
        minutesById.set(a.userId, (minutesById.get(a.userId) ?? 0) + mins);
      }
    }

    // Friends board: always list me + every accepted friend, even with 0
    // focus minutes this period, so you can always see who you're competing
    // with. Global board: only people who actually logged focus time.
    const rows = (
      scope === 'friends' && userFilter
        ? userFilter.map((id) => ({
            userId: id,
            minutes: minutesById.get(id) ?? 0,
          }))
        : [...minutesById.entries()]
            .map(([id, minutes]) => ({ userId: id, minutes }))
            .filter((r) => r.minutes > 0)
    ).sort((a, b) => b.minutes - a.minutes);

    const myIndex = rows.findIndex((r) => r.userId === userId);
    const top = rows.slice(0, 50);

    const ids = new Set(top.map((r) => r.userId));
    ids.add(userId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true, profile: { select: { avatarUrl: true } } },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    const entries = top.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      name: byId.get(r.userId)?.name || 'PrepSy Learner',
      avatarUrl: byId.get(r.userId)?.profile?.avatarUrl ?? null,
      focusMinutes: r.minutes,
      isMe: r.userId === userId,
    }));

    return {
      scope,
      period,
      entries,
      me: {
        rank: myIndex >= 0 ? myIndex + 1 : null,
        focusMinutes: myIndex >= 0 ? rows[myIndex].minutes : 0,
        name: byId.get(userId)?.name || 'You',
        avatarUrl: byId.get(userId)?.profile?.avatarUrl ?? null,
      },
    };
  }

  // Concept mastery: read the user's quiz attempts, score each question against
  // its stored answer, and aggregate per question topic into strong / weak /
  // developing concepts. (Questions generated before topic-tagging bucket into
  // "General".)
  async getUserMastery(userId: string) {
    const attempts = await this.prisma.quizAttempt.findMany({
      where: { userId },
      select: { questions: true, answers: true },
      orderBy: { completedAt: 'desc' },
      take: 200,
    });

    const byTopic = new Map<string, { attempted: number; correct: number }>();
    let totalQ = 0;
    let totalCorrect = 0;

    for (const a of attempts) {
      const qs = Array.isArray(a.questions) ? (a.questions as unknown[]) : [];
      const ans = Array.isArray(a.answers) ? (a.answers as unknown[]) : [];
      qs.forEach((qRaw, i) => {
        if (!qRaw || typeof qRaw !== 'object') return;
        const q = qRaw as Record<string, unknown>;
        const topic =
          typeof q.topic === 'string' && q.topic.trim() ? q.topic.trim() : 'General';
        const correct = ans[i] !== undefined && ans[i] === q.answer;
        const e = byTopic.get(topic) || { attempted: 0, correct: 0 };
        e.attempted += 1;
        e.correct += correct ? 1 : 0;
        byTopic.set(topic, e);
        totalQ += 1;
        totalCorrect += correct ? 1 : 0;
      });
    }

    const topics = [...byTopic.entries()]
      .map(([topic, e]) => {
        const accuracy = e.attempted ? Math.round((e.correct / e.attempted) * 100) : 0;
        const level =
          e.attempted < 3 ? 'developing' : accuracy >= 70 ? 'strong' : accuracy < 50 ? 'weak' : 'developing';
        return { topic, attempted: e.attempted, correct: e.correct, accuracy, level };
      })
      .sort((a, b) => a.accuracy - b.accuracy);

    return {
      quizzesTaken: attempts.length,
      totalQuestions: totalQ,
      overallAccuracy: totalQ ? Math.round((totalCorrect / totalQ) * 100) : 0,
      weak: topics.filter((t) => t.level === 'weak'),
      strong: topics.filter((t) => t.level === 'strong').sort((a, b) => b.accuracy - a.accuracy),
      developing: topics.filter((t) => t.level === 'developing'),
    };
  }
}
