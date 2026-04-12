import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server } from 'socket.io';
import type { AuthUserPayload } from '../auth/auth-user.interface';
import { RoomsService } from './rooms.service';
import { RoomWithRelations } from './room.types';
import type { AuthenticatedSocket } from './socket-user.interface';

type SignalPayload = {
  roomId: string;
  toSocketId: string;
  sdp: unknown;
};

type IcePayload = {
  roomId: string;
  toSocketId: string;
  candidate: unknown;
};

@WebSocketGateway({
  namespace: 'rooms',
  cors: { origin: '*' },
})
@Injectable()
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly roomsService: RoomsService,
  ) {}

  private readonly socketUserMap: Record<string, string> = {};
  private readonly roomMembers: Record<string, string[]> = {};
  private readonly pending = new Map<string, boolean>();

  private key(from: string, to: string, type: string) {
    return `${from}->${to}:${type}`;
  }

  handleConnection(client: AuthenticatedSocket) {
    try {
      const authToken =
        typeof client.handshake.auth?.token === 'string'
          ? client.handshake.auth.token
          : null;
      const headerValue =
        typeof client.handshake.headers?.authorization === 'string'
          ? client.handshake.headers.authorization
          : null;
      const token = authToken || headerValue?.replace('Bearer ', '') || null;

      if (!token) {
        throw new UnauthorizedException('No token');
      }

      const payload = this.jwt.verify<AuthUserPayload>(token, {
        secret: process.env.JWT_SECRET,
      });

      client.data.user = payload;
      this.socketUserMap[client.id] = payload.id || payload.sub || client.id;

      console.log('Socket connected:', client.id);
    } catch (error) {
      console.log(
        'WebSocket auth failed:',
        client.id,
        error instanceof Error ? error.message : 'Unknown auth error',
      );
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const socketId = client.id;

    for (const roomId of Object.keys(this.roomMembers)) {
      const room = this.roomMembers[roomId];
      const idx = room?.indexOf(socketId) ?? -1;

      if (idx !== -1) {
        room.splice(idx, 1);
        this.server.to(roomId).emit('user-left', {
          socketId,
          userId: this.socketUserMap[socketId],
        });
      }
    }

    delete this.socketUserMap[socketId];
    console.log('Client disconnected:', socketId);
  }

  @SubscribeMessage('joinRoom')
  async joinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: { roomId: string },
  ) {
    const { roomId } = body;
    this.getSocketUser(client);
    const userId = this.getRequiredSocketUserId(client);

    void client.join(roomId);
    this.roomMembers[roomId] ??= [];

    if (!this.roomMembers[roomId].includes(client.id)) {
      this.roomMembers[roomId].push(client.id);
    }

    try {
      await this.roomsService.joinRoom(roomId, userId);

      const absentMembers = await this.roomsService.getAbsentMembers(roomId);
      for (const member of absentMembers) {
        if (member.userId === userId) {
          continue;
        }

        try {
          await this.roomsService.notifyUserRoomJoined(
            member.userId,
            roomId,
            userId,
          );
        } catch (error) {
          console.log(
            'Join notification failed:',
            error instanceof Error
              ? error.message
              : 'Unknown join notification error',
          );
        }
      }
    } catch (error) {
      console.log(
        'Join logic error:',
        error instanceof Error ? error.message : 'Unknown join logic error',
      );
    }

    const existing = this.roomMembers[roomId].filter((id) => id !== client.id);
    client.emit('existing-users', { existing });

    client.broadcast.to(roomId).emit('user-joined', {
      socketId: client.id,
      userId,
    });

    try {
      const roomDetails: RoomWithRelations =
        await this.roomsService.getRoomDetails(roomId);

      client.emit('roomUsers', {
        users: (roomDetails.members || []).map((member) => ({
          userId: member.userId,
          joinedAt: member.joinedAt,
        })),
        pomodoro: roomDetails.pomodoro || null,
        messages: roomDetails.messages || [],
      });
    } catch (error) {
      console.log(
        'Room details fetch failed:',
        error instanceof Error ? error.message : 'Unknown room details error',
      );
    }

    return { joined: true };
  }

  @SubscribeMessage('offer')
  handleOffer(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: SignalPayload,
  ) {
    const { roomId, toSocketId, sdp } = data;
    this.pending.set(this.key(client.id, toSocketId, 'media'), true);

    this.server.to(toSocketId).emit('offer', {
      roomId,
      fromSocketId: client.id,
      sdp,
    });
  }

  @SubscribeMessage('answer')
  handleAnswer(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: SignalPayload,
  ) {
    const { roomId, toSocketId, sdp } = data;
    const pendingKey = this.key(toSocketId, client.id, 'media');

    if (!this.pending.has(pendingKey)) {
      console.warn(
        `Dropping duplicate/late media-answer for pair ${pendingKey}`,
      );
      return;
    }

    this.pending.delete(pendingKey);
    this.server.to(toSocketId).emit('answer', {
      roomId,
      fromSocketId: client.id,
      sdp,
    });
  }

  @SubscribeMessage('ice-candidate')
  handleIce(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: IcePayload,
  ) {
    const { roomId, toSocketId, candidate } = data;

    this.server.to(toSocketId).emit('ice-candidate', {
      roomId,
      fromSocketId: client.id,
      candidate,
    });
  }

  @SubscribeMessage('join-screen')
  handleJoinScreen(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ) {
    const roomId = data.roomId;
    if (!roomId) {
      return;
    }

    void client.join(`${roomId}-screen`);
    client.to(roomId).emit('user-started-screen', {
      socketId: client.id,
      userId: this.getSocketUserId(client),
    });
  }

  @SubscribeMessage('screen-offer')
  handleScreenOffer(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: SignalPayload,
  ) {
    const { roomId, toSocketId, sdp } = data;
    this.pending.set(this.key(client.id, toSocketId, 'screen'), true);

    this.server.to(toSocketId).emit('screen-offer', {
      roomId,
      fromSocketId: client.id,
      sdp,
    });
  }

  @SubscribeMessage('screen-answer')
  handleScreenAnswer(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: SignalPayload,
  ) {
    const { roomId, toSocketId, sdp } = data;
    const pendingKey = this.key(toSocketId, client.id, 'screen');

    if (!this.pending.has(pendingKey)) {
      console.warn(
        `Dropping duplicate/late screen-answer for pair ${pendingKey}`,
      );
      return;
    }

    this.pending.delete(pendingKey);
    this.server.to(toSocketId).emit('screen-answer', {
      roomId,
      fromSocketId: client.id,
      sdp,
    });
  }

  @SubscribeMessage('screen-ice')
  handleScreenIce(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: IcePayload,
  ) {
    const { roomId, toSocketId, candidate } = data;

    this.server.to(toSocketId).emit('screen-ice', {
      roomId,
      fromSocketId: client.id,
      candidate,
    });
  }

  @SubscribeMessage('leave-screen')
  handleLeaveScreen(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ) {
    const { roomId } = data;
    if (!roomId) {
      return;
    }

    client.to(roomId).emit('user-stopped-screen', {
      socketId: client.id,
      userId: this.getSocketUserId(client),
    });
  }

  @SubscribeMessage('startPomodoro')
  startPomodoro(@MessageBody() data: { roomId: string; minutes: number }) {
    const duration = Math.max(1, Number(data.minutes)) * 60;
    let remaining = duration;

    this.server.to(data.roomId).emit('pomodoroUpdate', { remaining });

    const interval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(interval);
        this.server.to(data.roomId).emit('pomodoroEnd');
      } else {
        this.server.to(data.roomId).emit('pomodoroUpdate', { remaining });
      }
    }, 1000);

    void interval;
  }

  @SubscribeMessage('chat:message')
  async handleChatMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string; text: string },
  ) {
    const user = this.getSocketUser(client);

    const savedMessage = await this.roomsService.saveMessage(
      data.roomId,
      this.getRequiredSocketUserId(client),
      data.text,
      user.name,
    );

    this.server.to(data.roomId).emit('chat:message', savedMessage);
  }

  private getSocketUser(client: AuthenticatedSocket) {
    const user = client.data.user;
    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }

  private getSocketUserId(client: AuthenticatedSocket) {
    return client.data.user?.id || client.data.user?.sub;
  }

  private getRequiredSocketUserId(client: AuthenticatedSocket) {
    const userId = this.getSocketUserId(client);
    if (!userId) {
      throw new UnauthorizedException('Socket user is missing an id');
    }

    return userId;
  }
}
