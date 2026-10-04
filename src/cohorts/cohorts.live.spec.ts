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
    const svc = svcWith({
      cohort: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
      cohortMember: {
        findUnique: jest.fn().mockResolvedValue({ presenceAt }),
        update,
      },
    });
    return { svc, update };
  };

  it('credits the real gap between beats', async () => {
    const { svc, update } = make(new Date(Date.now() - 15_000));
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
