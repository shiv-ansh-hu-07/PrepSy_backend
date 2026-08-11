import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Relationship of another user to the current user.
export type FriendStatus = 'none' | 'friends' | 'outgoing' | 'incoming';

@Injectable()
export class FriendsService {
  constructor(private readonly prisma: PrismaService) {}

  private publicUserSelect = {
    id: true,
    name: true,
    profile: { select: { username: true, avatarUrl: true, role: true, institutionName: true } },
  } as const;

  private toCard(user: {
    id: string;
    name: string | null;
    profile?: { username: string | null; avatarUrl: string | null; role: string | null; institutionName: string | null } | null;
  }) {
    return {
      userId: user.id,
      name: user.name || user.profile?.username || 'PrepSy Learner',
      username: user.profile?.username ?? null,
      avatarUrl: user.profile?.avatarUrl ?? null,
      role: user.profile?.role ?? null,
      institutionName: user.profile?.institutionName ?? null,
    };
  }

  // The single friendship row between two users, whichever direction.
  private async edge(a: string, b: string) {
    return this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: a, addresseeId: b },
          { requesterId: b, addresseeId: a },
        ],
      },
    });
  }

  async sendRequest(userId: string, targetId: string) {
    if (userId === targetId) {
      throw new BadRequestException('You cannot add yourself.');
    }
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('User not found');

    const existing = await this.edge(userId, targetId);
    if (existing) {
      if (existing.status === 'ACCEPTED') return { status: 'friends' as FriendStatus };
      // They already asked me — sending back accepts it.
      if (existing.addresseeId === userId) {
        await this.prisma.friendship.update({
          where: { id: existing.id },
          data: { status: 'ACCEPTED', respondedAt: new Date() },
        });
        return { status: 'friends' as FriendStatus };
      }
      return { status: 'outgoing' as FriendStatus }; // already requested
    }

    await this.prisma.friendship.create({
      data: { requesterId: userId, addresseeId: targetId, status: 'PENDING' },
    });
    return { status: 'outgoing' as FriendStatus };
  }

  // Accept or reject a request that `requesterId` sent to me.
  async respond(userId: string, requesterId: string, accept: boolean) {
    const req = await this.prisma.friendship.findFirst({
      where: { requesterId, addresseeId: userId, status: 'PENDING' },
    });
    if (!req) throw new NotFoundException('No pending request from this user');

    if (accept) {
      await this.prisma.friendship.update({
        where: { id: req.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
      return { status: 'friends' as FriendStatus };
    }
    await this.prisma.friendship.delete({ where: { id: req.id } });
    return { status: 'none' as FriendStatus };
  }

  // Unfriend, cancel an outgoing request, or decline — removes the edge.
  async remove(userId: string, otherId: string) {
    const edge = await this.edge(userId, otherId);
    if (edge) await this.prisma.friendship.delete({ where: { id: edge.id } });
    return { status: 'none' as FriendStatus };
  }

  async statusWith(userId: string, otherId: string): Promise<FriendStatus> {
    if (userId === otherId) return 'none';
    const edge = await this.edge(userId, otherId);
    if (!edge) return 'none';
    if (edge.status === 'ACCEPTED') return 'friends';
    return edge.requesterId === userId ? 'outgoing' : 'incoming';
  }

  // Map of otherUserId -> status, for the current user. Used to annotate lists.
  async statusMap(userId: string, otherIds: string[]): Promise<Record<string, FriendStatus>> {
    const map: Record<string, FriendStatus> = {};
    if (!otherIds.length) return map;
    const edges = await this.prisma.friendship.findMany({
      where: {
        OR: [
          { requesterId: userId, addresseeId: { in: otherIds } },
          { addresseeId: userId, requesterId: { in: otherIds } },
        ],
      },
    });
    for (const e of edges) {
      const other = e.requesterId === userId ? e.addresseeId : e.requesterId;
      map[other] =
        e.status === 'ACCEPTED'
          ? 'friends'
          : e.requesterId === userId
            ? 'outgoing'
            : 'incoming';
    }
    return map;
  }

  async listFriends(userId: string) {
    const edges = await this.prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: { select: this.publicUserSelect },
        addressee: { select: this.publicUserSelect },
      },
      orderBy: { respondedAt: 'desc' },
    });
    return edges.map((e) => this.toCard(e.requesterId === userId ? e.addressee : e.requester));
  }

  async listIncomingRequests(userId: string) {
    const edges = await this.prisma.friendship.findMany({
      where: { addresseeId: userId, status: 'PENDING' },
      include: { requester: { select: this.publicUserSelect } },
      orderBy: { createdAt: 'desc' },
    });
    return edges.map((e) => this.toCard(e.requester));
  }

  async counts(userId: string) {
    const [friends, incoming] = await Promise.all([
      this.prisma.friendship.count({
        where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
      }),
      this.prisma.friendship.count({ where: { addresseeId: userId, status: 'PENDING' } }),
    ]);
    return { friends, incomingRequests: incoming };
  }
}
