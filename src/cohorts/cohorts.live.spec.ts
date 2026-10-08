// Private/public cohorts, presence-based study time and the live scoreboard.
import { ForbiddenException } from '@nestjs/common';
import { CohortsService } from './cohorts.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

// uuid@13 is ESM-only and ts-jest runs CJS; S3 isn't exercised here.
jest.mock('../s3/s3.service', () => ({ S3Service: class {} }));

const svcWith = (prisma: any) =>
  new CohortsService(prisma, {} as any, {} as any);

describe('private cohorts', () => {
  const cohortRow = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    visibility: 'PRIVATE',
    inviteCode: 'secret',
    members: [
      {
        id: 'm1',
        cohortId: 'c1',
        userId: 'owner',
        joinedAt: new Date(),
        progress: {},
        user: { id: 'owner', name: 'O' },
      },
    ],
    ...over,
  });

  it('hides a private cohort from non-members without the invite', async () => {
    const svc = svcWith({
      cohort: { findUnique: jest.fn().mockResolvedValue(cohortRow()) },
    });
    await expect(svc.getCohort('c1', 'stranger')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.getCohort('c1', 'stranger', 'wrong'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an invited non-member preview, without leaking the code', async () => {
    const svc = svcWith({
      cohort: { findUnique: jest.fn().mockResolvedValue(cohortRow()) },
    });
    const c: any = await svc.getCohort('c1', 'stranger', 'secret');
    expect(c.isMember).toBe(false);
    expect(c.inviteCode).toBeNull();
  });

  it('gives members the invite code', async () => {
    const svc = svcWith({
      cohort: { findUnique: jest.fn().mockResolvedValue(cohortRow()) },
    });
    const c: any = await svc.getCohort('c1', 'owner');
    expect(c.inviteCode).toBe('secret');
  });

  it('requires the invite to join a private cohort', async () => {
    const row = {
      roomId: null,
      maxSize: 6,
      visibility: 'PRIVATE',
      inviteCode: 'secret',
      members: [],
      _count: { members: 1 },
    };
    const upsert = jest.fn().mockResolvedValue({ id: 'new' });
    const svc = svcWith({
      cohort: { findUnique: jest.fn().mockResolvedValue(row) },
      cohortMember: { upsert },
    });
    await expect(svc.joinCohort('c1', 'stranger')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(upsert).not.toHaveBeenCalled();
    await svc.joinCohort('c1', 'stranger', 'secret');
    expect(upsert).toHaveBeenCalled();
  });

  it('public cohorts stay open to everyone', async () => {
    const row = {
      roomId: null,
      maxSize: 6,
      visibility: 'PUBLIC',
      inviteCode: 'x',
      members: [],
      _count: { members: 1 },
    };
    const upsert = jest.fn().mockResolvedValue({ id: 'new' });
    const svc = svcWith({
      cohort: { findUnique: jest.fn().mockResolvedValue(row) },
      cohortMember: { upsert },
    });
    await svc.joinCohort('c1', 'anyone');
    expect(upsert).toHaveBeenCalled();
  });
});

describe('updatePresence study time', () => {
  const make = (presenceAt: Date | null) => {
    const update = jest.fn().mockResolvedValue({});
    const dayUpsert = jest.fn().mockResolvedValue({});
    const svc = svcWith({
      cohort: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
      cohortMember: {
        findUnique: jest.fn().mockResolvedValue({ presenceAt }),
        update,
      },
      cohortStudyDay: { upsert: dayUpsert },
    });
    return { svc, update, dayUpsert };
  };

  it('credits the real gap between beats', async () => {
    const { svc, update, dayUpsert } = make(new Date(Date.now() - 15_000));
    await svc.updatePresence('r1', 'u1', {
      videoId: 'v1',
      positionSec: 42,
      playing: true,
    });
    const data = update.mock.calls[0][0].data;
    expect(data.studySeconds.increment).toBeGreaterThanOrEqual(14);
    expect(data.studySeconds.increment).toBeLessThanOrEqual(16);
    expect(data.watchingVideoId).toBe('v1');
    expect(data.watchingPositionSec).toBe(42);
    expect(dayUpsert.mock.calls[0][0].update.seconds.increment).toBe(
      data.studySeconds.increment,
    );
  });

  it('credits nothing after a long gap (tab closed) or on the first beat', async () => {
    const a = make(new Date(Date.now() - 10 * 60_000));
    await a.svc.updatePresence('r1', 'u1', {});
    expect(a.update.mock.calls[0][0].data.studySeconds).toBeUndefined();
    const b = make(null);
    await b.svc.updatePresence('r1', 'u1', {});
    expect(b.update.mock.calls[0][0].data.studySeconds).toBeUndefined();
  });
});

describe('getLiveBoard', () => {
  it('ranks by study time and reports who is watching what', async () => {
    const now = Date.now();
    const svc = svcWith({
      cohortMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm' }) },
      cohortStudyDay: { findMany: jest.fn().mockResolvedValue([]) },
      cohort: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          createdById: 'a',
          syncMode: 'SOLO',
          skippedVideoIds: [],
          playlist: {
            videos: [
              { ytVideoId: 'v1', title: 'One', position: 0, durationSec: 600 },
              { ytVideoId: 'v2', title: 'Two', position: 1, durationSec: 600 },
            ],
          },
          members: [
            {
              userId: 'a',
              user: { name: 'Ann' },
              studySeconds: 600,
              presenceAt: new Date(now - 5_000),
              watchingVideoId: 'v2',
              watchingPositionSec: 90,
              watchingPlaying: true,
              progress: { watchedVideos: ['v1'] },
            },
            {
              userId: 'b',
              user: { name: 'Bo' },
              studySeconds: 3600,
              presenceAt: new Date(now - 3_600_000),
              watchingVideoId: 'v1',
              watchingPositionSec: 10,
              watchingPlaying: false,
              progress: {},
            },
          ],
        }),
      },
    });
    const board: any = await svc.getLiveBoard('c1', 'a');
    expect(board.syncMode).toBe('SOLO');
    expect(board.members.map((m: any) => m.userId)).toEqual(['b', 'a']);
    const ann = board.members.find((m: any) => m.userId === 'a');
    expect(ann.live).toBe(true);
    expect(ann.watching).toMatchObject({
      videoId: 'v2',
      index: 2,
      positionSec: 90,
    });
    expect(ann.percent).toBe(50);
    expect(board.members.find((m: any) => m.userId === 'b').live).toBe(false);
    expect(board.liveCount).toBe(1);
  });
});

describe('video flags', () => {
  const make = (video: unknown, flag: unknown = null) => {
    const create = jest.fn(({ data }) => Promise.resolve(data));
    const svc = svcWith({
      cohortMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm' }) },
      cohort: { findUnique: jest.fn().mockResolvedValue({ playlistId: 'p1' }) },
      playlistVideo: { findFirst: jest.fn().mockResolvedValue(video) },
      discussionPost: {
        create,
        findUnique: jest.fn().mockResolvedValue(flag),
        deleteMany: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    });
    return { svc, create };
  };

  it('pins a note to a moment in a cohort video', async () => {
    const { svc, create } = make({ ytVideoId: 'v1' });
    const f: any = await svc.createFlag('c1', 'u1', {
      videoId: 'v1',
      timeSec: 1200.4,
      content: ' key formula ',
    });
    expect(f).toMatchObject({
      videoId: 'v1',
      timeSec: 1200,
      content: 'key formula',
      authorId: 'u1',
    });
    expect(create).toHaveBeenCalled();
  });

  it('rejects videos outside the playlist, bad times and empty notes', async () => {
    await expect(
      make(null).svc.createFlag('c1', 'u1', {
        videoId: 'x',
        timeSec: 5,
        content: 'hi',
      }),
    ).rejects.toThrow();
    await expect(
      make({ ytVideoId: 'v1' }).svc.createFlag('c1', 'u1', {
        videoId: 'v1',
        timeSec: -3,
        content: 'hi',
      }),
    ).rejects.toThrow();
    await expect(
      make({ ytVideoId: 'v1' }).svc.createFlag('c1', 'u1', {
        videoId: 'v1',
        timeSec: 5,
        content: '  ',
      }),
    ).rejects.toThrow();
  });

  it('only the author or the cohort creator can remove a flag', async () => {
    const flag = {
      cohortId: 'c1',
      authorId: 'a',
      videoId: 'v1',
      cohort: { createdById: 'boss' },
    };
    await expect(
      make(null, flag).svc.deleteFlag('c1', 'stranger', 'f1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      make(null, flag).svc.deleteFlag('c1', 'a', 'f1'),
    ).resolves.toEqual({ ok: true });
    await expect(
      make(null, flag).svc.deleteFlag('c1', 'boss', 'f1'),
    ).resolves.toEqual({ ok: true });
  });
});

describe('weekly standings', () => {
  // 2026-10-07 is a Wednesday (IST); the week started Monday 2026-10-05.
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T10:00:00+05:30'));
  });
  afterAll(() => jest.useRealTimers());

  const make = () =>
    svcWith({
      cohort: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          name: 'DSA',
          roomId: 'r1',
          members: [
            {
              userId: 'a',
              studySeconds: 99999,
              presenceAt: null,
              progress: {},
              user: { name: 'Ann A', email: 'a@x' },
            },
            {
              userId: 'b',
              studySeconds: 10,
              presenceAt: new Date(),
              progress: {},
              user: { name: 'Bo B', email: 'b@x' },
            },
            {
              userId: 'c',
              studySeconds: 10,
              presenceAt: null,
              progress: {},
              user: { name: 'Cy C', email: 'c@x' },
            },
          ],
        }),
      },
      cohortStudyDay: {
        findMany: jest.fn().mockResolvedValue([
          // last week: Ann won
          { userId: 'a', day: '2026-10-01', seconds: 7200 },
          // this week up to yesterday: Ann ahead of Bo
          { userId: 'a', day: '2026-10-06', seconds: 3000 },
          { userId: 'b', day: '2026-10-05', seconds: 1200 },
          // today: Bo overtakes Ann
          { userId: 'b', day: '2026-10-07', seconds: 2400 },
        ]),
      },
    });

  it('ranks this week only, tracks movement and last week champion', async () => {
    const st: any = await make().getStandings('c1');
    const by = Object.fromEntries(st.members.map((m: any) => [m.userId, m]));
    expect(st.weekStart).toBe('2026-10-05');
    expect(by.b.weekSec).toBe(3600);
    expect(by.b.todaySec).toBe(2400);
    expect(by.a.weekSec).toBe(3000); // last week's 2h doesn't count
    expect(by.b.weekRank).toBe(1);
    expect(by.b.rankDelta).toBe(1); // was #2 yesterday
    expect(by.a.rankDelta).toBe(-1);
    expect(by.b.live).toBe(true);
    expect(st.champion).toMatchObject({ userId: 'a', seconds: 7200 });
  });

  it('personal standing gives the near-peer target', async () => {
    const svc = make();
    const st: any = await svc.getStandings('c1');
    const ann: any = svc.personalStanding(st, 'a');
    expect(ann.rank).toBe(2);
    expect(ann.above).toEqual({ name: 'Bo B', gapSec: 600 });
    expect(ann.leader).toMatchObject({ name: 'Bo B', isYou: false });
    expect(ann.liveNames).toEqual(['Bo B']);
    expect(ann.champion.isYou).toBe(true);
  });
});

describe('late joiners', () => {
  beforeAll(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-10-10T12:00:00+05:30')),
  );
  afterAll(() => jest.useRealTimers());

  it('are not "behind" for days before they joined', async () => {
    const day = (n: number) =>
      new Date(`2026-10-${String(n).padStart(2, '0')}T15:00:00+05:30`);
    const sessions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
      id: `s${n}`,
      topic: `Day ${n}`,
      scheduledAt: day(n),
      roomId: null,
      videoIds: [`v${n}`],
      status: 'SCHEDULED',
    }));
    const svc = svcWith({
      cohort: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          name: 'DSA',
          roomId: null,
          playlist: { title: 'P', _count: { videos: 10 } },
          members: [
            {
              userId: 'early',
              joinedAt: day(1),
              progress: {
                watchedVideos: [
                  'v1',
                  'v2',
                  'v3',
                  'v4',
                  'v5',
                  'v6',
                  'v7',
                  'v8',
                  'v9',
                  'v10',
                ],
              },
              user: { name: 'E', email: 'e@x' },
            },
            {
              userId: 'late',
              joinedAt: day(9),
              progress: { watchedVideos: [] },
              user: { name: 'L', email: 'l@x' },
            },
          ],
        }),
      },
      studySession: { findMany: jest.fn().mockResolvedValue(sessions) },
      roomAttendance: { findMany: jest.fn().mockResolvedValue([]) },
      quizAttempt: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const p: any = await (svc as any).buildCohortProgress('c1');
    const late = p.rows.find((r: any) => r.userId === 'late');
    expect(late.elapsed).toBe(1); // only day 9 is owed (day 10 starts at 3 PM, after 'now')
    expect(late.behind).toBe(1); // day 9 not done; days 1-8 are not held against them
    expect(late.joinedAfterDays).toBe(8);
    const early = p.rows.find((r: any) => r.userId === 'early');
    expect(early.behind).toBe(0);
  });
});
