import { Injectable } from '@nestjs/common';
import { RoomServiceClient } from 'livekit-server-sdk';
import { PrismaService } from '../prisma/prisma.service';

type RoomStatsRecord = {
  roomId: string;
  startTime: Date | null;
  durationMinutes: number | null;
  isRecurring: boolean;
  recurrenceType: string | null;
  recurrenceEndDate: Date | null;
};

@Injectable()
export class StatsService {
  private readonly attendanceTimeZone = 'Asia/Kolkata';
  private readonly timeZoneAliases: Record<string, string> = {
    'Asia/Calcutta': 'Asia/Kolkata',
  };

  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const [rooms, todayAttendance] = await Promise.all([
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
          joinedAt: true,
          leftAt: true,
        },
      }),
    ]);

    const visibleRooms = rooms.filter((room) =>
      this.shouldShowPublicRoom(room),
    );
    const scheduledActiveRooms = visibleRooms.filter((room) =>
      this.isRoomActive(room),
    );
    const liveRoomStats =
      await this.getLiveKitRoomStats(scheduledActiveRooms);

    const activeUsers =
      liveRoomStats === null
        ? new Set(todayAttendance.map((entry) => entry.userId)).size
        : liveRoomStats.activeUsers;
    const focusDurations =
      liveRoomStats === null
        ? this.getAttendanceDurations(todayAttendance)
        : liveRoomStats.focusDurations;
    const avgFocusMinutes =
      focusDurations.length === 0
        ? 0
        : Math.round(
            focusDurations.reduce((total, duration) => total + duration, 0) /
              focusDurations.length /
              60000,
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

  private async getLiveKitRoomStats(rooms: RoomStatsRecord[]) {
    const roomService = this.getRoomServiceClient();

    if (!roomService) {
      return null;
    }

    const now = Date.now();
    const roomResults = await Promise.all(
      rooms.map(async (room) => {
        try {
          const participants = await roomService.listParticipants(room.roomId);
          return participants.map((participant) => {
            const joinedAtMs =
              Number(participant.joinedAtMs || 0n) ||
              Number(participant.joinedAt || 0n) * 1000;
            return joinedAtMs > 0 ? now - joinedAtMs : 0;
          });
        } catch {
          return [];
        }
      }),
    );
    const activeRoomDurations = roomResults.filter(
      (durations) => durations.length > 0,
    );
    const focusDurations = activeRoomDurations.flat().filter((duration) => duration > 0);

    return {
      activeRooms: activeRoomDurations.length,
      activeUsers: activeRoomDurations.reduce(
        (total, durations) => total + durations.length,
        0,
      ),
      focusDurations,
    };
  }

  private getAttendanceDurations(
    attendance: { joinedAt: Date; leftAt: Date | null }[],
  ) {
    const now = Date.now();
    return attendance
      .map((entry) => (entry.leftAt?.getTime() ?? now) - entry.joinedAt.getTime())
      .filter((duration) => duration > 0);
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
}
