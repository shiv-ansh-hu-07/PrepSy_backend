import { Injectable } from '@nestjs/common';
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
    const [rooms, todayAttendance, roomPomodoros] = await Promise.all([
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
          userId: true,
        },
      }),
      this.prisma.pomodoro.findMany({
        select: {
          roomId: true,
          running: true,
          mode: true,
        },
      }),
    ]);

    const visibleRooms = rooms.filter((room) =>
      this.shouldShowPublicRoom(room),
    );
    const activeRooms = visibleRooms.filter((room) => this.isRoomActive(room));
    const activeRoomIds = new Set(activeRooms.map((room) => room.roomId));
    const workPomodoros = roomPomodoros.filter(
      (pomodoro) =>
        pomodoro.running &&
        pomodoro.mode === 'work' &&
        activeRoomIds.has(pomodoro.roomId),
    );

    const activeUsers = new Set(todayAttendance.map((entry) => entry.userId))
      .size;
    const avgFocus =
      activeRooms.length === 0
        ? 0
        : Math.round((workPomodoros.length / activeRooms.length) * 100);

    return {
      stats: {
        activeRooms: activeRooms.length,
        activeUsers,
        avgFocus,
      },
    };
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
