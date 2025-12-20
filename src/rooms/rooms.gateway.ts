// src/rooms/rooms.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { RoomWithRelations } from './room.types';
import * as socketUserInterface from './socket-user.interface';


@WebSocketGateway({
  namespace: 'rooms',
  cors: { origin: '*' },
})
@Injectable()
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private jwt: JwtService, private roomsService: RoomsService) { }

  private socketUserMap: Record<string, string> = {};
  private roomMembers: Record<string, string[]> = {};

  // Track pending negotiations to prevent duplicate/late answers
  private pending: Map<string, boolean> = new Map();
  private key = (from: string, to: string, type: string) => `${from}->${to}:${type}`;

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) throw new UnauthorizedException('No token');

      const payload = this.jwt.verify(token, {
        secret: process.env.JWT_SECRET,
      });

      client.data.user = payload;
      this.socketUserMap[client.id] = payload.id || payload.sub || client.id;

      console.log('🟢 Socket connected:', client.id);
    } catch (err) {
      console.log('❌ WebSocket auth failed:', client.id, err?.message);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const socketId = client.id;

    for (const roomId of Object.keys(this.roomMembers)) {
      const idx = this.roomMembers[roomId]?.indexOf(socketId);
      if (idx !== -1) {
        this.roomMembers[roomId].splice(idx, 1);

        this.server.to(roomId).emit('user-left', {
          socketId,
          userId: this.socketUserMap[socketId],
        });
      }
    }

    delete this.socketUserMap[socketId];
    console.log('🔴 Client disconnected:', socketId);
  }

  // -------------------------------------------------------------
  // JOIN ROOM
  // -------------------------------------------------------------
  @SubscribeMessage('joinRoom')
  async joinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string },
  ) {
    const { roomId } = body;
    const user = client.data.user;
    if (!user) throw new UnauthorizedException();

    client.join(roomId);

    if (!this.roomMembers[roomId]) this.roomMembers[roomId] = [];
    if (!this.roomMembers[roomId].includes(client.id)) {
      this.roomMembers[roomId].push(client.id);
    }

    try {
      await this.roomsService.joinRoom(roomId, user.id || user.sub || client.id);
    } catch { }

    const existing = this.roomMembers[roomId].filter((id) => id !== client.id);
    client.emit('existing-users', { existing });

    client.broadcast.to(roomId).emit('user-joined', {
      socketId: client.id,
      userId: user.id || user.sub,
    });

    try {
      const roomDetails: RoomWithRelations = await this.roomsService.getRoomDetails(roomId);
      client.emit('roomUsers', {
        users: (roomDetails?.members || []).map((m) => ({
          userId: m.userId,
          joinedAt: m.joinedAt,
        })),
        pomodoro: roomDetails?.pomodoro || null,
        messages: roomDetails?.messages || [],
      });
    } catch { }

    return { joined: true };
  }

  // -------------------------------------------------------------
  // OFFER (media)
  // -------------------------------------------------------------
  @SubscribeMessage('offer')
  handleOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; toSocketId: string; sdp: any },
  ) {
    const { roomId, toSocketId, sdp } = data;

    // Mark negotiation pending for this pair
    this.pending.set(this.key(client.id, toSocketId, 'media'), true);

    this.server.to(toSocketId).emit('offer', {
      roomId,
      fromSocketId: client.id,
      sdp,
    });

    console.log(`📡 OFFER (media) from=${client.id} → ${toSocketId}`);
  }

  // -------------------------------------------------------------
  // ANSWER (media)
  // -------------------------------------------------------------
  @SubscribeMessage('answer')
  handleAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; toSocketId: string; sdp: any },
  ) {
    const { roomId, toSocketId, sdp } = data;

    const k = this.key(toSocketId, client.id, 'media');
    if (!this.pending.has(k)) {
      console.warn(`⚠️ Dropping duplicate/late media-answer for pair ${k}`);
      return;
    }

    this.pending.delete(k);

    this.server.to(toSocketId).emit('answer', {
      roomId,
      fromSocketId: client.id,
      sdp,
    });

    console.log(`📡 ANSWER (media) from=${client.id} → ${toSocketId}`);
  }

  // -------------------------------------------------------------
  // ICE CANDIDATE (media)
  // -------------------------------------------------------------
  @SubscribeMessage('ice-candidate')
  handleIce(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { roomId: string; toSocketId: string; candidate: any },
  ) {
    const { roomId, toSocketId, candidate } = data;

    this.server.to(toSocketId).emit('ice-candidate', {
      roomId,
      fromSocketId: client.id,
      candidate,
    });
  }

  // -------------------------------------------------------------
  // SCREEN SHARE CHANNEL
  // -------------------------------------------------------------
  @SubscribeMessage('join-screen')
  handleJoinScreen(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const roomId = data?.roomId;
    if (!roomId) return;
    client.join(`${roomId}-screen`);

    // NEW: notify others in the room that this user started screen sharing
    client.to(roomId).emit('user-started-screen', {
      socketId: client.id,
      userId: client.data?.user?.id || client.data?.user?.sub,
    });

    console.log(`🖥️ Screen-mode join: ${client.id} (room ${roomId})`);
  }

  // -------------------------------------------------------------
  // SCREEN OFFER
  // -------------------------------------------------------------
  @SubscribeMessage('screen-offer')
  handleScreenOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { roomId: string; toSocketId: string; sdp: any },
  ) {
    const { roomId, toSocketId, sdp } = data;

    this.pending.set(this.key(client.id, toSocketId, 'screen'), true);

    this.server.to(toSocketId).emit('screen-offer', {
      roomId,
      fromSocketId: client.id,
      sdp,
    });

    console.log(`📡 SCREEN OFFER from=${client.id} → ${toSocketId}`);
  }

  // -------------------------------------------------------------
  // SCREEN ANSWER
  // -------------------------------------------------------------
  @SubscribeMessage('screen-answer')
  handleScreenAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { roomId: string; toSocketId: string; sdp: any },
  ) {
    const { roomId, toSocketId, sdp } = data;

    const k = this.key(toSocketId, client.id, 'screen');
    if (!this.pending.has(k)) {
      console.warn(`⚠️ Dropping duplicate/late screen-answer for pair ${k}`);
      return;
    }

    this.pending.delete(k);

    this.server.to(toSocketId).emit('screen-answer', {
      roomId,
      fromSocketId: client.id,
      sdp,
    });

    console.log(`📡 SCREEN ANSWER from=${client.id} → ${toSocketId}`);
  }

  // -------------------------------------------------------------
  // SCREEN ICE
  // -------------------------------------------------------------
  @SubscribeMessage('screen-ice')
  handleScreenIce(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { roomId: string; toSocketId: string; candidate: any },
  ) {
    const { roomId, toSocketId, candidate } = data;

    this.server.to(toSocketId).emit('screen-ice', {
      roomId,
      fromSocketId: client.id,
      candidate,
    });
  }

  // -------------------------------------------------------------
  // SCREEN SHARE STOP (NEW)
  // -------------------------------------------------------------
  @SubscribeMessage('leave-screen')
  handleLeaveScreen(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const { roomId } = data || {};
    if (!roomId) return;

    // Notify others that this user stopped screen sharing
    client.to(roomId).emit('user-stopped-screen', {
      socketId: client.id,
      userId: client.data?.user?.id || client.data?.user?.sub,
    });

    console.log(`🛑 Screen share stopped by ${client.id} (room ${roomId})`);
  }

  // -------------------------------------------------------------
  // POMODORO + CHAT (unchanged)
  // -------------------------------------------------------------
  @SubscribeMessage('startPomodoro')
  async startPomodoro(
    @MessageBody() data: { roomId: string; minutes: number },
  ) {
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
  }

  @SubscribeMessage("chat:message")
async handleChatMessage(
  @ConnectedSocket() client: Socket,
  @MessageBody() data: { roomId: string; text: string }
) {
  const user = client.data.user;

  if (!user) {
    throw new UnauthorizedException();
  }

  const savedMessage = await this.roomsService.saveMessage(
    data.roomId,
    user.id || user.sub,
    data.text,
    user.name
  );

  this.server
    .to(data.roomId)
    .emit("chat:message", savedMessage);
}


}
