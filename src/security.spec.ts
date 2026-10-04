// Regression tests for the 2026-10-04 security sweep: server-decided
// identities, member-only writes, and bounded client-reported scores.
import { ForbiddenException } from '@nestjs/common';
import { MessagesService } from './messages/messages.service';
import { RoomsService } from './rooms/rooms.service';
import { CohortsService } from './cohorts/cohorts.service';
import { LivekitController } from './livekit/livekit.controller';

/* eslint-disable @typescript-eslint/no-explicit-any */

// uuid@13 is ESM-only and ts-jest runs CJS; S3 isn't exercised here.
jest.mock('./s3/s3.service', () => ({ S3Service: class {} }));

describe('MessagesService.create', () => {
  const prisma: any = {
    room: { findUnique: jest.fn().mockResolvedValue({ roomId: 'r1' }) },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'u1', name: 'Real Name', email: 'r@x.in' }),
    },
    message: { create: jest.fn(({ data }) => Promise.resolve(data)) },
  };
  const svc = new MessagesService(prisma);

  it('stores a logged-in sender as their account, ignoring the body', async () => {
    const m = await svc.create(
      { roomId: 'r1', text: 'hi', senderId: 'victim', senderName: 'Victim' },
      'u1',
    );
    expect(m.senderId).toBe('u1');
    expect(m.senderName).toBe('Real Name');
  });

  it('never stores an anonymous sender as a real user id', async () => {
    const m = await svc.create(
      { roomId: 'r1', text: 'hi', senderId: 'victim-user-id' },
      null,
    );
    expect(m.senderId).toBe('guest-victim-user-id');
  });

  it('keeps an already-guest id as-is', async () => {
    const m = await svc.create(
      { roomId: 'r1', text: 'hi', senderId: 'guest-abc' },
      null,
    );
    expect(m.senderId).toBe('guest-abc');
  });

  it('rejects empty messages', async () => {
    await expect(
      svc.create({ roomId: 'r1', text: '  ' }, null),
    ).rejects.toThrow();
  });
});

describe('RoomsService.saveVideoState', () => {
  const make = (member: unknown) => {
    const prisma: any = {
      room: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ roomId: 'r1', ownerId: 'owner' }),
      },
      roomMember: { findFirst: jest.fn().mockResolvedValue(member) },
      roomVideoState: { upsert: jest.fn().mockResolvedValue({ ok: true }) },
    };
    return { prisma, svc: new RoomsService(prisma, {} as any) };
  };

  it('rejects a signed-in non-member', async () => {
    const { svc, prisma } = make(null);
    await expect(
      svc.saveVideoState('r1', 'stranger', { positionSec: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.roomVideoState.upsert).not.toHaveBeenCalled();
  });

  it('allows a member and the owner', async () => {
    const a = make({ id: 'm' });
    await a.svc.saveVideoState('r1', 'member', { positionSec: 5 });
    expect(a.prisma.roomVideoState.upsert).toHaveBeenCalled();
    const b = make(null);
    await b.svc.saveVideoState('r1', 'owner', { positionSec: 5 });
    expect(b.prisma.roomVideoState.upsert).toHaveBeenCalled();
  });
});

describe('CohortsService quiz points + discussions', () => {
  const make = (progress: Record<string, unknown> | null, isMember = true) => {
    const prisma: any = {
      cohortMember: {
        findUnique: jest
          .fn()
          .mockResolvedValue(isMember ? { id: 'cm', progress } : null),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      discussionPost: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { prisma, svc: new CohortsService(prisma, {} as any, {} as any) };
  };

  it('caps one score post at 1200 points', async () => {
    const { svc, prisma } = make({ quizPoints: 0 });
    await svc.addQuizPoints('c1', 'u1', 1_000_000);
    expect(
      prisma.cohortMember.update.mock.calls[0][0].data.progress.quizPoints,
    ).toBe(1200);
  });

  it('ignores a second score post within 60s', async () => {
    const { svc, prisma } = make({
      quizPoints: 500,
      lastQuizScoreAt: Date.now() - 5_000,
    });
    await svc.addQuizPoints('c1', 'u1', 800);
    expect(prisma.cohortMember.update).not.toHaveBeenCalled();
  });

  it('blocks non-members from reading discussions', async () => {
    const { svc, prisma } = make(null, false);
    await expect(svc.getDiscussions('c1', 'stranger')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.discussionPost.findMany).not.toHaveBeenCalled();
  });
});

describe('LivekitController.getToken identity', () => {
  const OLD = { ...process.env };
  beforeAll(() => {
    process.env.LIVEKIT_API_KEY = 'k';
    process.env.LIVEKIT_API_SECRET = 'secret-secret-secret-secret-12345';
    process.env.LIVEKIT_WS_URL = 'wss://example.livekit.cloud';
  });
  afterAll(() => {
    process.env = OLD;
  });

  const run = async (reqUser: any, user: string) => {
    const prisma: any = {
      room: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ roomId: 'r1', name: 'R', startTime: null }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'u1', name: 'Real', email: 'r@x.in' }),
      },
    };
    const ctrl = new LivekitController(prisma);
    (ctrl as any).getRoomServiceClient = () => ({
      listRooms: jest.fn().mockResolvedValue([{}]),
      listParticipants: jest.fn().mockResolvedValue([]),
    });
    let body: any;
    const res: any = { status: () => res, json: (b: any) => ((body = b), res) };
    await ctrl.getToken({ user: reqUser } as any, 'r1', user, 'Name', res);
    const payload = JSON.parse(
      Buffer.from(body.token.split('.')[1], 'base64url').toString(),
    );
    return payload.sub as string;
  };

  it('anonymous caller claiming a user id gets a guest identity', async () => {
    expect(await run(undefined, 'u1')).toBe('guest-u1');
  });

  it('signed-in caller is always their own id', async () => {
    expect(await run({ sub: 'u1' }, 'someone-else')).toBe('u1');
  });
});

describe('CohortsService.postDiscussion', () => {
  const make = (parent: unknown) => {
    const prisma: any = {
      cohortMember: { findUnique: jest.fn().mockResolvedValue({ id: 'cm' }) },
      discussionPost: {
        findUnique: jest.fn().mockResolvedValue(parent),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    return { prisma, svc: new CohortsService(prisma, {} as any, {} as any) };
  };

  it("rejects a reply into another cohort's thread", async () => {
    const { svc, prisma } = make({ cohortId: 'other' });
    await expect(svc.postDiscussion('c1', 'u1', 'hi', 'p1')).rejects.toThrow();
    expect(prisma.discussionPost.create).not.toHaveBeenCalled();
  });

  it('rejects attachments that are not our uploads', async () => {
    process.env.CLOUDFRONT_DOMAIN = 'cdn.prepsy.test';
    const { svc } = make(null);
    await expect(
      svc.postDiscussion('c1', 'u1', '', undefined, undefined, {
        url: 'https://evil.example/x',
      }),
    ).rejects.toThrow();
    await expect(
      svc.postDiscussion('c1', 'u1', '', undefined, undefined, {
        url: 'https://cdn.prepsy.test/chat/u1/a.pdf',
      }),
    ).resolves.toBeDefined();
  });
});

describe('EmailService escaping', () => {
  it('escapes room names in HTML', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EmailService } = require('./email/email.service');
    const svc = new EmailService({} as any);
    let html = '';
    (svc as any).sendEmail = (o: any) => (
      (html = o.html),
      Promise.resolve(true)
    );
    await svc.sendScheduledRoomConfirmationEmail(
      'a@b.in',
      '<a href="x">Click</a>',
      new Date(),
    );
    expect(html).not.toContain('<a href');
    expect(html).toContain('&lt;a href=&quot;x&quot;&gt;');
  });
});
