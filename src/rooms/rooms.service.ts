import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { RoomServiceClient } from 'livekit-server-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { RoomWithRelations } from './room.types';
import { EmailService } from '../email/email.service';

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);
  private readonly attendanceTimeZone = 'Asia/Kolkata';
  private readonly timeZoneAliases: Record<string, string> = {
    'Asia/Calcutta': 'Asia/Kolkata',
  };
  private readonly roomListSelect = {
    id: true,
    roomId: true,
    name: true,
    description: true,
    tags: true,
    ownerId: true,
    createdAt: true,
    startTime: true,
    durationMinutes: true,
    isRecurring: true,
    recurrenceType: true,
    recurrenceEndDate: true,
  } as const;

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  private parseRecurrenceMeta(recurrenceType?: string | null) {
    if (!recurrenceType) {
      return { frequency: null, timeZone: null };
    }

    const [frequency, timeZone] = recurrenceType.split('|');
    return {
      frequency: frequency || null,
      timeZone: timeZone || null,
    };
  }

  private getRecurringWindow(
    room: {
      startTime: Date | null;
      durationMinutes: number | null;
      recurrenceType: string | null;
    },
    baseDate: Date,
  ) {
    if (!room.startTime || !room.durationMinutes) {
      return null;
    }

    const recurrenceMeta = this.parseRecurrenceMeta(room.recurrenceType);
    const timeZone = this.normalizeTimeZone(
      recurrenceMeta.timeZone || 'Asia/Kolkata',
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
      timeZone,
    };
  }

  private shouldStopRecurringRoom(room: {
    recurrenceEndDate: Date | null;
    recurrenceType: string | null;
    startTime: Date | null;
  }) {
    if (!room.recurrenceEndDate || !room.startTime) {
      return false;
    }

    const recurrenceMeta = this.parseRecurrenceMeta(room.recurrenceType);
    const timeZone = this.normalizeTimeZone(
      recurrenceMeta.timeZone || 'Asia/Kolkata',
    );
    const endDateParts = this.getDatePartsInTimeZone(
      room.recurrenceEndDate,
      timeZone,
    );
    const startDateParts = this.getDatePartsInTimeZone(
      room.startTime,
      timeZone,
    );

    const endKey = Date.UTC(
      endDateParts.year,
      endDateParts.month - 1,
      endDateParts.day,
    );
    const startKey = Date.UTC(
      startDateParts.year,
      startDateParts.month - 1,
      startDateParts.day,
    );

    return startKey >= endKey;
  }

  private getDatePartsInTimeZone(date: Date, timeZone: string) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
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

  private getDateKeyInTimeZone(date: Date, timeZone: string) {
    const parts = this.getDatePartsInTimeZone(date, timeZone);
    const month = String(parts.month).padStart(2, '0');
    const day = String(parts.day).padStart(2, '0');
    return `${parts.year}-${month}-${day}`;
  }

  private shiftDateKey(dateKey: string, days: number) {
    const [yearText, monthText, dayText] = dateKey.split('-');
    const shifted = new Date(
      Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + days),
    );
    return shifted.toISOString().slice(0, 10);
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

  private getAttendanceWindow(date: Date) {
    const timeZone = this.normalizeTimeZone(this.attendanceTimeZone);
    const parts = this.getDatePartsInTimeZone(date, timeZone);
    const start = this.zonedTimeToUtc(
      parts.year,
      parts.month,
      parts.day,
      0,
      0,
      timeZone,
    );
    const end = this.zonedTimeToUtc(
      parts.year,
      parts.month,
      parts.day + 1,
      0,
      0,
      timeZone,
    );

    return { start, end, timeZone };
  }

  private validateTimeZone(timeZone: string) {
    try {
      const normalizedTimeZone = this.normalizeTimeZone(timeZone);
      new Intl.DateTimeFormat('en-US', { timeZone: normalizedTimeZone }).format(
        new Date(),
      );
      return true;
    } catch {
      return false;
    }
  }

  private normalizeTimeZone(timeZone: string) {
    return this.timeZoneAliases[timeZone] || timeZone;
  }

  private buildScheduledStartTime(scheduleTime: string, timeZone: string) {
    const normalizedTimeZone = this.normalizeTimeZone(timeZone);

    if (!/^\d{2}:\d{2}$/.test(scheduleTime)) {
      throw new BadRequestException('Schedule time must be in HH:mm format');
    }

    if (!this.validateTimeZone(normalizedTimeZone)) {
      throw new BadRequestException('Invalid timezone');
    }

    const [hourText, minuteText] = scheduleTime.split(':');
    const hour = Number(hourText);
    const minute = Number(minuteText);

    if (
      Number.isNaN(hour) ||
      Number.isNaN(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      throw new BadRequestException('Invalid schedule time');
    }

    const now = new Date();
    const zonedNow = this.getDatePartsInTimeZone(now, normalizedTimeZone);

    let nextStart = this.zonedTimeToUtc(
      zonedNow.year,
      zonedNow.month,
      zonedNow.day,
      hour,
      minute,
      normalizedTimeZone,
    );

    if (nextStart.getTime() <= now.getTime()) {
      nextStart = this.zonedTimeToUtc(
        zonedNow.year,
        zonedNow.month,
        zonedNow.day + 1,
        hour,
        minute,
        normalizedTimeZone,
      );
    }

    return nextStart;
  }

  private isRoomActive(room: {
    startTime: Date | null;
    durationMinutes: number | null;
    isRecurring: boolean;
    recurrenceType: string | null;
  }) {
    if (!room.startTime || !room.durationMinutes) {
      return false;
    }

    const now = new Date();
    const durationMs = room.durationMinutes * 60 * 1000;

    if (!room.isRecurring) {
      const endTime = new Date(room.startTime.getTime() + durationMs);
      return now >= room.startTime && now <= endTime;
    }

    const todaysWindow = this.getRecurringWindow(room, now);

    if (!todaysWindow) {
      return false;
    }

    return now >= todaysWindow.start && now <= todaysWindow.end;
  }

  private shouldShowPublicRoom(room: {
    startTime: Date | null;
    durationMinutes: number | null;
    isRecurring: boolean;
    recurrenceType: string | null;
    recurrenceEndDate?: Date | null;
  }) {
    if (!room.startTime || !room.durationMinutes) {
      return false;
    }

    if (room.isRecurring) {
      return !this.shouldStopRecurringRoom({
        recurrenceEndDate: room.recurrenceEndDate ?? null,
        recurrenceType: room.recurrenceType,
        startTime: room.startTime,
      });
    }

    const endTime = new Date(
      room.startTime.getTime() + room.durationMinutes * 60 * 1000,
    );

    return new Date() <= endTime;
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

  private async attachActiveUserCounts<
    T extends {
      roomId: string;
    },
  >(rooms: T[]) {
    const roomService = this.getRoomServiceClient();

    if (!roomService || rooms.length === 0) {
      return rooms.map((room) => ({ ...room, activeUsers: 0 }));
    }

    return Promise.all(
      rooms.map(async (room) => {
        try {
          const participants = await roomService.listParticipants(room.roomId);
          return { ...room, activeUsers: participants.length };
        } catch {
          return { ...room, activeUsers: 0 };
        }
      }),
    );
  }

  async createRoom(
    name: string,
    roomId: string,
    description: string,
    tags: string[],
    visibility: 'PUBLIC' | 'PRIVATE',
    userId: string,
    startTime?: string,
    durationMinutes?: number,
    isRecurring?: boolean,
    recurrenceType?: string,
    recurrenceEndDate?: string,
    scheduleTime?: string,
    timezone?: string,
  ) {
    if (!name?.trim()) {
      throw new BadRequestException('Room name is required');
    }

    const normalizedTimeZone = timezone
      ? this.normalizeTimeZone(timezone)
      : undefined;

    const cleanTags = Array.from(
      new Set(
        (tags || [])
          .map((tag) => tag?.trim().toLowerCase())
          .filter((tag): tag is string => Boolean(tag)),
      ),
    );

    const safeDuration =
      typeof durationMinutes === 'number' && durationMinutes > 0
        ? Math.round(durationMinutes)
        : null;

    const scheduleRequested =
      Boolean(startTime) || (Boolean(scheduleTime) && Boolean(timezone));

    const resolvedStartTime = scheduleRequested
      ? startTime
        ? new Date(startTime)
        : this.buildScheduledStartTime(scheduleTime!, normalizedTimeZone!)
      : null;

    if (resolvedStartTime && Number.isNaN(resolvedStartTime.getTime())) {
      throw new BadRequestException('Invalid room start time');
    }

    const recurrenceMeta =
      scheduleRequested && normalizedTimeZone
        ? `${isRecurring ? 'DAILY' : 'ONE_TIME'}|${normalizedTimeZone}`
        : recurrenceType || null;

    const finalRoomId = roomId || randomUUID();

    const room = await this.prisma.$transaction(async (tx) => {
      const createdRoom = await tx.room.create({
        data: {
          name: name.trim(),
          roomId: finalRoomId,
          description: description?.trim() || null,
          tags: cleanTags,
          visibility,
          ownerId: userId,
          startTime: resolvedStartTime,
          durationMinutes: safeDuration,
          isRecurring: Boolean(scheduleRequested && isRecurring),
          recurrenceType: recurrenceMeta,
          recurrenceEndDate: recurrenceEndDate
            ? new Date(recurrenceEndDate)
            : null,
          remindersent: false,
        },
      });

      await tx.roomMember.create({
        data: {
          roomId: createdRoom.roomId,
          userId,
        },
      });

      return createdRoom;
    });

    if (resolvedStartTime) {
      const owner = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
        },
      });

      if (owner?.email) {
        const meta = this.parseRecurrenceMeta(room.recurrenceType);
        await this.emailService.sendScheduledRoomConfirmationEmail(
          owner.email,
          room.name,
          resolvedStartTime,
          room.durationMinutes,
          meta.timeZone || normalizedTimeZone,
        );
      }
    }

    return {
      success: true,
      roomId: room.roomId,
      name: room.name,
    };
  }

  async getRooms() {
    const rooms = await this.prisma.room.findMany();
    return { rooms };
  }

  async getPublicRooms() {
    const rooms = await this.prisma.room.findMany({
      where: {
        visibility: 'PUBLIC',
        startTime: {
          not: null,
        },
      },
      select: this.roomListSelect,
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      rooms: await this.attachActiveUserCounts(
        rooms.filter((room) => this.shouldShowPublicRoom(room)),
      ),
    };
  }

  async searchRoomsByTags(tags: string[]) {
    if (!tags || tags.length === 0) {
      return { rooms: [] };
    }

    const rooms = await this.prisma.room.findMany({
      where: {
        tags: {
          hasSome: tags,
        },
      },
      select: this.roomListSelect,
    });

    return { rooms: await this.attachActiveUserCounts(rooms) };
  }

  async getMyRooms(userId: string) {
    const rooms = await this.prisma.room.findMany({
      where: {
        OR: [
          { ownerId: userId },
          {
            members: {
              some: {
                userId,
              },
            },
          },
        ],
      },
      select: this.roomListSelect,
      orderBy: {
        createdAt: 'desc',
      },
    });

    const createdRooms = rooms.filter((room) => room.ownerId === userId);
    const joinedRooms = rooms.filter((room) => room.ownerId !== userId);

    return {
      createdRooms: await this.attachActiveUserCounts(createdRooms),
      joinedRooms: await this.attachActiveUserCounts(joinedRooms),
    };
  }

  async joinRoom(roomId: string, userId: string) {
    const room = await this.prisma.room.findUnique({
      where: { roomId },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const exists = await this.prisma.roomMember.findFirst({
      where: { roomId, userId },
    });

    if (!exists) {
      await this.prisma.roomMember.create({
        data: { roomId, userId },
      });
    }

    const { start, end } = this.getAttendanceWindow(new Date());
    const alreadyJoinedToday = await this.prisma.roomAttendance.findFirst({
      where: {
        roomId,
        userId,
        joinedAt: {
          gte: start,
          lt: end,
        },
      },
    });

    if (!alreadyJoinedToday) {
      await this.prisma.roomAttendance.create({
        data: { roomId, userId },
      });
    }

    return { success: true };
  }

  async leaveRoom(roomId: string, userId: string) {
    const room = await this.prisma.room.findUnique({
      where: { roomId },
      select: {
        roomId: true,
        name: true,
      },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const now = new Date();
    const { start, end } = this.getAttendanceWindow(now);
    const currentAttendance = await this.prisma.roomAttendance.findFirst({
      where: {
        roomId,
        userId,
        joinedAt: {
          gte: start,
          lt: end,
        },
      },
      orderBy: {
        joinedAt: 'desc',
      },
    });

    if (currentAttendance && !currentAttendance.leftAt) {
      await this.prisma.roomAttendance.update({
        where: { id: currentAttendance.id },
        data: { leftAt: now },
      });
    }

    const [allUserAttendance, companionAttendance, user] = await Promise.all([
      this.prisma.roomAttendance.findMany({
        where: {
          roomId,
          userId,
        },
        select: {
          joinedAt: true,
          leftAt: true,
        },
      }),
      this.prisma.roomAttendance.findMany({
        where: {
          roomId,
          userId: {
            not: userId,
          },
        },
        distinct: ['userId'],
        select: {
          userId: true,
        },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          loginStreak: true,
          lastLoginAt: true,
          streakDisabled: true,
        },
      }),
    ]);

    const todayAttendance = allUserAttendance.filter((attendance) => {
  return attendance.joinedAt >= start && attendance.joinedAt < end;
});

const totalMinutes = Math.round(
  todayAttendance.reduce((total, attendance) => {
    const leftAt = attendance.leftAt ?? now;
    return total + Math.max(0, leftAt.getTime() - attendance.joinedAt.getTime());
  }, 0) / 60000,
);
    const streakUser =
      user
        ? await this.recordSessionStreak(user, now)
        : user;
    const streak = streakUser ? this.getCurrentStreak(streakUser, now) : 0;

    return {
      roomId: room.roomId,
      roomName: room.name,
      totalMinutes,
      totalTimeLabel: this.formatMinutes(totalMinutes),
      studiedWithCount: companionAttendance.length,
      streak,
      //streakDisabled: false,
      message:
        'Great work today. Rest up, keep the rhythm alive, and come back tomorrow for the next focused session.',
    };
  }

  private async recordSessionStreak(
    user: {
      id: string;
      loginStreak: number;
      lastLoginAt: Date | null;
      streakDisabled: boolean;
    },
    now: Date,
  ) {
    const timeZone = this.normalizeTimeZone(this.attendanceTimeZone);
    const todayKey = this.getDateKeyInTimeZone(now, timeZone);
    const lastSessionKey = user.lastLoginAt
      ? this.getDateKeyInTimeZone(user.lastLoginAt, timeZone)
      : null;

    if (lastSessionKey === todayKey) {
      return user;
    }

    const yesterdayKey = this.shiftDateKey(todayKey, -1);
    const nextStreak =
      lastSessionKey === yesterdayKey ? user.loginStreak + 1 : 1;

    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        loginStreak: nextStreak,
        lastLoginAt: now,
      },
      select: {
        id: true,
        loginStreak: true,
        lastLoginAt: true,
        streakDisabled: true,
      },
    });
  }

  private getCurrentStreak(
  user: {
    loginStreak: number;
    lastLoginAt: Date | null;
  },
  now: Date,
) {
  if (!user.lastLoginAt) return 0;

  const timeZone = this.normalizeTimeZone(this.attendanceTimeZone);

  const todayKey = this.getDateKeyInTimeZone(now, timeZone);
  const lastKey = this.getDateKeyInTimeZone(user.lastLoginAt, timeZone);

  return lastKey === todayKey ? user.loginStreak : 0;
}

  async deleteRoom(roomId: string, userId: string) {
    const room = await this.prisma.room.findUnique({
      where: { roomId },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.ownerId !== userId) {
      throw new ForbiddenException('You are not allowed to delete this room');
    }

    await this.prisma.$transaction([
      this.prisma.roomMember.deleteMany({
        where: { roomId },
      }),
      this.prisma.message.deleteMany({
        where: { roomId },
      }),
      this.prisma.pomodoro.deleteMany({
        where: { roomId },
      }),
      this.prisma.roomAttendance.deleteMany({
        where: { roomId },
      }),
      this.prisma.room.delete({
        where: { roomId },
      }),
    ]);

    return { success: true };
  }

  async getRoomDetails(roomId: string): Promise<RoomWithRelations> {
    const room = await this.prisma.room.findUnique({
      where: { roomId },
      include: {
        members: true,
        messages: { orderBy: { createdAt: 'asc' } },
        pomodoro: true,
      },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    return room;
  }

  async saveMessage(
    roomId: string,
    senderId: string,
    text: string,
    senderName?: string,
  ) {
    return this.prisma.message.create({
      data: {
        roomId,
        senderId,
        senderName,
        text,
      },
    });
  }

  async getRoomMessages(roomId: string) {
    return this.prisma.message.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async savePomodoro(
    roomId: string,
    pomodoro: {
      running: boolean;
      mode: string;
      remaining: number;
    },
  ) {
    return this.prisma.pomodoro.upsert({
      where: { roomId },
      create: {
        roomId,
        running: pomodoro.running,
        mode: pomodoro.mode,
        remaining: pomodoro.remaining,
      },
      update: {
        running: pomodoro.running,
        mode: pomodoro.mode,
        remaining: pomodoro.remaining,
      },
    });
  }

  async getRoomsStartingIn(minutes: number) {
    const now = new Date();
    const future = new Date(now.getTime() + minutes * 60000);

    return this.prisma.room.findMany({
      where: {
        startTime: {
          gte: now,
          lte: future,
        },
      },
      include: {
        members: true,
      },
    });
  }

  async getAbsentMembers(roomId: string) {
    const members = await this.prisma.roomMember.findMany({
      where: { roomId },
    });

    const { start, end } = this.getAttendanceWindow(new Date());
    const attendance = await this.prisma.roomAttendance.findMany({
      where: {
        roomId,
        joinedAt: {
          gte: start,
          lt: end,
        },
      },
    });

    const joinedUserIds = attendance.map((entry) => entry.userId);

    return members.filter((member) => !joinedUserIds.includes(member.userId));
  }

  async notifyUserRoomJoined(
    targetUserId: string,
    roomId: string,
    joinedUserId: string,
  ) {
    const room = await this.prisma.room.findUnique({
      where: { roomId },
    });

    if (!room) return;

    const { start, end } = this.getAttendanceWindow(new Date());
    const attendance = await this.prisma.roomAttendance.findMany({
      where: {
        roomId,
        joinedAt: {
          gte: start,
          lt: end,
        },
      },
    });

    const joinedUserIds = [...new Set(attendance.map((entry) => entry.userId))];
    const joinedCount = joinedUserIds.length;

    if (joinedCount === 0 || targetUserId === joinedUserId) {
      return;
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        email: true,
      },
    });

    if (!targetUser?.email) {
      return;
    }

    await this.emailService.sendJoinNudgeEmail(
      targetUser.email,
      room.name,
      joinedCount,
    );
  }

  async checkAndSendReminders() {
    await this.advanceCompletedRecurringRooms();

    const now = new Date();
    const in15Minutes = new Date(now.getTime() + 15 * 60000);

    const rooms = await this.prisma.room.findMany({
      where: {
        remindersent: false,
        startTime: {
          gte: now,
          lte: in15Minutes,
        },
      },
    });

    for (const room of rooms) {
      const startTime = room.startTime;
      if (!startTime) continue;

      const recurrenceMeta = this.parseRecurrenceMeta(room.recurrenceType);
      const members = await this.prisma.roomMember.findMany({
        where: { roomId: room.roomId },
        select: {
          user: {
            select: {
              email: true,
            },
          },
        },
      });

      await Promise.all(
        members
          .map((member) => member.user.email)
          .filter((email): email is string => Boolean(email))
          .map((email) =>
            this.emailService.sendReminderEmail(
              email,
              room.name,
              startTime,
              recurrenceMeta.timeZone || undefined,
            ),
          ),
      );

      await this.prisma.room.update({
        where: { roomId: room.roomId },
        data: { remindersent: true },
      });
    }

    return { success: true, roomsChecked: rooms.length };
  }

  private async advanceCompletedRecurringRooms() {
    const now = new Date();
    const recurringRooms = await this.prisma.room.findMany({
      where: {
        isRecurring: true,
        recurrenceType: {
          startsWith: 'DAILY|',
        },
        startTime: {
          not: null,
        },
        durationMinutes: {
          not: null,
        },
      },
    });

    for (const room of recurringRooms) {
      if (!room.startTime || !room.durationMinutes) {
        continue;
      }

      let nextStartTime = room.startTime;
      let nextWindow = this.getRecurringWindow(
        { ...room, startTime: nextStartTime },
        nextStartTime,
      );

      if (!nextWindow || now < nextWindow.end) {
        continue;
      }

      while (nextWindow && now >= nextWindow.end) {
        if (
          this.shouldStopRecurringRoom({
            recurrenceEndDate: room.recurrenceEndDate,
            recurrenceType: room.recurrenceType,
            startTime: nextStartTime,
          })
        ) {
          await this.prisma.room.update({
            where: { roomId: room.roomId },
            data: {
              isRecurring: false,
              remindersent: true,
            },
          });
          nextWindow = null;
          break;
        }

        nextStartTime = new Date(nextStartTime.getTime() + 24 * 60 * 60 * 1000);
        nextWindow = this.getRecurringWindow(
          { ...room, startTime: nextStartTime },
          nextStartTime,
        );
      }

      if (!nextWindow) {
        continue;
      }

      if (nextStartTime.getTime() === room.startTime.getTime()) {
        continue;
      }

      await this.prisma.room.update({
        where: { roomId: room.roomId },
        data: {
          startTime: nextStartTime,
          remindersent: false,
        },
      });
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async runReminderScheduler() {
    try {
      await this.checkAndSendReminders();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown reminder error';
      this.logger.error(`Reminder scheduler failed: ${message}`);
    }
  }
}
