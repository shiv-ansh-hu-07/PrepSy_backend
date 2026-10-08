// Women-only rooms: only women (by profile gender) can see, create or enter.
import { ForbiddenException } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { LivekitController } from '../livekit/livekit.controller';

/* eslint-disable @typescript-eslint/no-explicit-any */

const profileFor = (gender: string | null) => ({
  findUnique: jest.fn().mockResolvedValue(gender == null ? null : { gender }),
});

describe('women-only rooms', () => {
  it('recognises the profile gender values', () => {
    expect(RoomsService.isFemaleGender('woman')).toBe(true);
    expect(RoomsService.isFemaleGender('Female')).toBe(true);
    expect(RoomsService.isFemaleGender('man')).toBe(false);
    expect(RoomsService.isFemaleGender('non-binary')).toBe(false);
    expect(RoomsService.isFemaleGender(null)).toBe(false);
  });

  it('hides them from the public list for men and guests, not for women', async () => {
    const run = async (gender: string | null, userId: string | null) => {
      const prisma: any = {
        userProfile: profileFor(gender),
        room: { findMany: jest.fn().mockResolvedValue([]) },
        cohort: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const svc = new RoomsService(prisma, {} as any);
      (svc as any).attachActiveUserCounts = (r: any[]) => Promise.resolve(r);
      await svc.getPublicRooms(userId);
      return prisma.room.findMany.mock.calls[0][0].where;
    };
    expect(await run('man', 'u1')).toMatchObject({ femaleOnly: false });
    expect(await run(null, null)).toMatchObject({ femaleOnly: false });
    expect((await run('woman', 'u2')).femaleOnly).toBeUndefined();
  });

  it("men can't join or create one", async () => {
    const prisma: any = {
      userProfile: profileFor('man'),
      room: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ roomId: 'r1', femaleOnly: true }),
      },
    };
    const svc = new RoomsService(prisma, {} as any);
    await expect(svc.joinRoom('r1', 'u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.createRoom(
        'Girls DSA',
        'r2',
        '',
        [],
        'PUBLIC',
        'u1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no video token for men or guests; women get one', async () => {
    const OLD = { ...process.env };
    process.env.LIVEKIT_API_KEY = 'k';
    process.env.LIVEKIT_API_SECRET = 'secret-secret-secret-secret-12345';
    process.env.LIVEKIT_WS_URL = 'wss://example.livekit.cloud';
    const run = async (gender: string | null, reqUser: any) => {
      const prisma: any = {
        room: {
          findUnique: jest
            .fn()
            .mockResolvedValue({
              roomId: 'r1',
              name: 'R',
              startTime: null,
              femaleOnly: true,
            }),
        },
        userProfile: profileFor(gender),
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'u1', name: 'A', email: 'a@x' }),
        },
      };
      const ctrl = new LivekitController(prisma);
      (ctrl as any).getRoomServiceClient = () => ({
        listRooms: jest.fn().mockResolvedValue([{}]),
        listParticipants: jest.fn().mockResolvedValue([]),
      });
      let status = 200;
      const res: any = {
        status: (c: number) => ((status = c), res),
        json: () => res,
      };
      await ctrl.getToken({ user: reqUser } as any, 'r1', 'x', 'X', res);
      return status;
    };
    expect(await run('man', { sub: 'u1' })).toBe(403);
    expect(await run(null, undefined)).toBe(403);
    expect(await run('woman', { sub: 'u1' })).toBe(200);
    process.env = OLD;
  });
});
