// Free-text room search: names/descriptions/tags, synonyms, ranking.
import { RoomsService } from './rooms.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const room = (
  roomId: string,
  name: string,
  tags: string[] = [],
  description = '',
) => ({
  roomId,
  name,
  tags,
  description,
  startTime: null,
  durationMinutes: 60,
  isRecurring: true,
  recurrenceType: 'DAILY',
  recurrenceEndDate: null,
  ownerId: 'o',
  id: roomId,
  createdAt: new Date(),
});

const make = () => {
  const rooms = [
    room('r1', 'Java + DSA + Interview Preparation Course Study Group'),
    room(
      'r2',
      'DSA Patterns 2025 | Crack FAANG in 3 Months | DSA Patterns by IITian Study Group',
    ),
    room('r3', 'DBMS : Decomposition of a Relation | GO Classes Study Group'),
    room('r4', 'Python - Intermediat', ['youtube-watch-party']),
    room('r5', 'Late night grind', ['leetcode'], 'solving graph problems'),
    room('r6', 'Thursday OS revision'),
  ];
  const prisma: any = {
    room: { findMany: jest.fn().mockResolvedValue(rooms) },
    cohort: {
      findMany: jest.fn().mockResolvedValue([{ id: 'c1', roomId: 'r1' }]),
    },
  };
  const svc = new RoomsService(prisma, {} as any);
  (svc as any).attachActiveUserCounts = (rs: any[]) =>
    Promise.resolve(rs.map((r) => ({ ...r, activeUsers: 0 })));
  (svc as any).shouldShowPublicRoom = () => true;
  return svc;
};

const ids = async (q: string) =>
  ((await make().searchRooms(q)) as any).rooms.map((r: any) => r.roomId);

describe('RoomsService.searchRooms', () => {
  it('finds DSA cohort rooms by name (they have no tags) and via synonyms', async () => {
    const r = await ids('dsa');
    expect(r).toEqual(expect.arrayContaining(['r1', 'r2', 'r5']));
    expect(r).not.toContain('r3'); // "dbms" must not match "dsa"
  });
  it('ranks name matches above tag/description matches', async () => {
    const r = await ids('dsa');
    expect(r.indexOf('r1')).toBeLessThan(r.indexOf('r5'));
  });
  it('is case-insensitive and handles multi-term queries', async () => {
    expect(await ids('PYTHON')).toEqual(['r4']);
    expect((await ids('dsa, dbms')).slice(0, 1)).toEqual(['r1']);
  });
  it('matches short words whole (os ≠ "most"/"posts")', async () => {
    expect(await ids('os')).toEqual(['r6']);
  });
  it('flags cohort rooms and ignores empty/stopword queries', async () => {
    const res: any = await make().searchRooms('dsa');
    expect(res.rooms.find((x: any) => x.roomId === 'r1').isCohortRoom).toBe(
      true,
    );
    expect(((await make().searchRooms('study group')) as any).rooms).toEqual(
      [],
    );
  });
});
