// Room details page: members + study stats from attendance, women-only gate.
import { ForbiddenException } from '@nestjs/common';
import { RoomsService } from './rooms.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const make = (room: any, gender = 'man') => {
  const prisma: any = {
    room: { findUnique: jest.fn().mockResolvedValue(room) },
    userProfile: { findUnique: jest.fn().mockResolvedValue({ gender }) },
    cohort: { findMany: jest.fn().mockResolvedValue([]) },
    roomAttendance: {
      findMany: jest.fn().mockResolvedValue([
        {
          userId: 'owner',
          joinedAt: new Date(Date.now() - 120 * 60000),
          leftAt: new Date(Date.now() - 60 * 60000),
        },
        {
          userId: 'm1',
          joinedAt: new Date(Date.now() - 30 * 60000),
          leftAt: new Date(Date.now() - 28 * 60000),
        },
      ]),
    },
  };
  const svc = new RoomsService(prisma, {} as any);
  (svc as any).attachActiveUserCounts = (r: any[]) =>
    Promise.resolve(r.map((x) => ({ ...x, activeUsers: 2 })));
  return svc;
};

const baseRoom = {
  roomId: 'r1',
  name: 'DSA',
  description: 'd',
  tags: ['dsa'],
  visibility: 'PUBLIC',
  femaleOnly: false,
  collaborationStyle: 'quiet-focus',
  preferredLanguages: [],
  startTime: null,
  durationMinutes: 60,
  isRecurring: true,
  recurrenceType: 'DAILY|Asia/Kolkata',
  recurrenceEndDate: null,
  createdAt: new Date(),
  ownerId: 'owner',
  studyPlanId: 'p1',
  owner: { id: 'owner', name: 'Owner', email: 'o@x' },
  members: [
    { userId: 'm1', joinedAt: new Date(), user: { name: 'Mem', email: 'm@x' } },
  ],
};

describe('RoomsService.getRoomPage', () => {
  it('returns info, schedule and members with study stats', async () => {
    const r: any = await make(baseRoom).getRoomPage('r1', 'm1');
    expect(r).toMatchObject({
      name: 'DSA',
      frequency: 'DAILY',
      timeZone: 'Asia/Kolkata',
      isOwner: false,
      isMember: true,
      activeUsers: 2,
      studyPlanId: 'p1',
    });
    const owner = r.members.find((m: any) => m.userId === 'owner');
    expect(owner).toMatchObject({
      isOwner: true,
      minutesTotal: 60,
      sessions: 1,
    });
    const mem = r.members.find((m: any) => m.userId === 'm1');
    expect(mem).toMatchObject({ isMe: true, minutesTotal: 2, sessions: 0 });
    expect(r.totals.minutesTotal).toBe(62);
  });

  it('women-only rooms stay women-only', async () => {
    await expect(
      make({ ...baseRoom, femaleOnly: true }, 'man').getRoomPage('r1', 'm1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      make({ ...baseRoom, femaleOnly: true }, 'woman').getRoomPage('r1', 'm1'),
    ).resolves.toBeDefined();
  });
});
