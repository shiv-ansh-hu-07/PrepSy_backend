import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OptionalJwtAuthGuard } from '../analytics/optional-jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { PrismaService } from '../prisma/prisma.service';

@Controller('livekit')
export class LivekitController {
  constructor(private readonly prisma: PrismaService) {}

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

  // Guests may join rooms, so a token isn't required — but the LiveKit identity
  // is decided here: a signed-in caller is always their own user id, and an
  // anonymous caller is always a `guest-` identity (can't impersonate a user).
  @Get('token')
  @UseGuards(OptionalJwtAuthGuard)
  async getToken(
    @Req() req: RequestWithUser,
    @Query('room') room: string,
    @Query('user') user: string,
    @Query('name') name: string,
    @Res() res: Response,
  ) {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      console.error('Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET');
      return res.status(500).json({ error: 'LiveKit keys missing' });
    }

    if (!room) {
      console.error('LiveKit token requested with undefined room');
      return res.status(400).json({ error: 'Room is required' });
    }

    const roomRecord = await this.prisma.room.findUnique({
      where: { roomId: room },
      select: {
        roomId: true,
        name: true,
        startTime: true,
        durationMinutes: true,
        collaborationStyle: true,
        youtubeVideoId: true,
        youtubePlaylistId: true,
        tags: true,
        femaleOnly: true,
        ownerId: true,
      },
    });

    if (!roomRecord) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const isWatchParty = Boolean(
      roomRecord.youtubeVideoId || roomRecord.youtubePlaylistId,
    );

    // Scheduled rooms open 15 minutes early (the reminder email goes out then,
    // with a join link). The room's creator can always enter — to set up or
    // study before the session. Previously even the creator was locked out.
    const EARLY_ENTRY_MS = 15 * 60_000;
    const requesterId = req?.user?.id || req?.user?.sub || null;
    const now = new Date();
    if (
      roomRecord.startTime &&
      !isWatchParty &&
      requesterId !== roomRecord.ownerId &&
      now.getTime() < roomRecord.startTime.getTime() - EARLY_ENTRY_MS
    ) {
      const opensAt = new Date(roomRecord.startTime.getTime() - EARLY_ENTRY_MS);
      return res.status(403).json({
        error: 'This room opens 15 minutes before it starts.',
        startTime: roomRecord.startTime.toISOString(),
        opensAt: opensAt.toISOString(),
      });
    }

    const authedId = req?.user?.id || req?.user?.sub || null;

    // Women-only rooms: signed-in women only (by profile gender). Guests and
    // everyone else can't get a token, so they can't enter even with the link.
    if (roomRecord.femaleOnly) {
      const profile = authedId
        ? await this.prisma.userProfile.findUnique({
            where: { userId: authedId },
            select: { gender: true },
          })
        : null;
      if (!/^\s*(woman|women|female|girl)\b/i.test(profile?.gender ?? '')) {
        return res.status(403).json({ error: 'This room is for women only.' });
      }
    }
    let identity: string;
    let displayName: string;
    if (authedId) {
      const account = await this.prisma.user.findUnique({
        where: { id: authedId },
        select: { id: true, name: true, email: true },
      });
      if (!account) {
        return res.status(401).json({ error: 'Unknown user' });
      }
      identity = account.id;
      displayName = account.name || account.email.split('@')[0] || 'User';
    } else {
      const claimed = (user || '').trim();
      identity = claimed.startsWith('guest-')
        ? claimed.slice(0, 64)
        : `guest-${claimed.slice(0, 40) || Math.random().toString(36).slice(2)}`;
      displayName = (name || 'Guest').trim().slice(0, 60) || 'Guest';
    }
    const roomService = this.getRoomServiceClient();

    if (!roomService) {
      return res.status(500).json({ error: 'LiveKit service unavailable' });
    }

    try {
      const activeRooms = await roomService.listRooms([room]);
      if (activeRooms.length === 0) {
        await roomService.createRoom({
          name: room,
          maxParticipants: 6,
          emptyTimeout: 600,
        });
      }

      const participants = await roomService.listParticipants(room);
      const alreadyJoined = participants.some(
        (participant) => participant.identity === identity,
      );

      if (participants.length >= 6 && !alreadyJoined) {
        return res.status(403).json({
          error: 'This classroom is full. Only 6 participants are allowed.',
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown LiveKit error';
      console.error(`LiveKit room validation failed: ${message}`);
      return res.status(500).json({ error: 'Unable to validate room access' });
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name: displayName,
      ttl: '2h',
    });

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await at.toJwt();

    return res.json({
      token: jwt,
      url: process.env.LIVEKIT_WS_URL,
      roomName: roomRecord.name,
      durationMinutes: roomRecord.durationMinutes ?? 90,
      collaborationStyle: roomRecord.collaborationStyle ?? 'quiet-focus',
      youtubeVideoId: roomRecord.youtubeVideoId ?? null,
      youtubePlaylistId: roomRecord.youtubePlaylistId ?? null,
      startTime: roomRecord.startTime
        ? roomRecord.startTime.toISOString()
        : null,
      tags: roomRecord.tags ?? [],
    });
  }
}
