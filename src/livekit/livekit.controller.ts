import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
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

  @Get('token')
  async getToken(
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
      },
    });

    if (!roomRecord) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const now = new Date();
    if (roomRecord.startTime && now < roomRecord.startTime) {
      return res.status(403).json({
        error: 'This classroom has not started yet.',
        startTime: roomRecord.startTime.toISOString(),
      });
    }

    const identity = user || `guest-${Math.random().toString(36).slice(2)}`;
    const displayName = name || 'Guest';
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
    });
  }
}
