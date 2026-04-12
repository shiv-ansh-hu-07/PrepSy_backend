import { Socket } from 'socket.io';
import { AuthUserPayload } from '../auth/auth-user.interface';

export interface AuthenticatedSocket extends Socket {
  data: {
    user?: AuthUserPayload;
  };
}
