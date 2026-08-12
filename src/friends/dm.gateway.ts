import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import type { AuthUserPayload } from '../auth/auth-user.interface';

// Real-time direct messages. Each socket joins a personal room `user:<id>`;
// the FriendsService emits new messages here, and typing pings hop socket→socket.
@WebSocketGateway({ namespace: 'dm', cors: { origin: '*' } })
@Injectable()
export class DmGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;

  constructor(private readonly jwt: JwtService) {}

  private userOf(client: Socket): string | null {
    const authToken =
      typeof client.handshake.auth?.token === 'string' ? client.handshake.auth.token : null;
    const header =
      typeof client.handshake.headers?.authorization === 'string'
        ? client.handshake.headers.authorization
        : null;
    const token = authToken || header?.replace('Bearer ', '') || null;
    if (!token) return null;
    try {
      const payload = this.jwt.verify<AuthUserPayload>(token, {
        secret: process.env.JWT_SECRET,
      });
      return payload.id || payload.sub || null;
    } catch {
      return null;
    }
  }

  handleConnection(client: Socket) {
    const userId = this.userOf(client);
    if (!userId) {
      client.disconnect();
      return;
    }
    client.data.userId = userId;
    client.join(`user:${userId}`);
  }

  @SubscribeMessage('dm:typing')
  onTyping(@ConnectedSocket() client: Socket, @MessageBody() body: { to?: string }) {
    const from = client.data.userId as string;
    if (!from || !body?.to) return;
    this.server.to(`user:${body.to}`).emit('dm:typing', { from });
  }

  // Push a persisted message to both participants (recipient + sender's devices).
  emitMessage(message: { senderId: string; recipientId: string }) {
    if (!this.server) return;
    this.server.to(`user:${message.recipientId}`).emit('dm:message', message);
    this.server.to(`user:${message.senderId}`).emit('dm:message', message);
  }
}
