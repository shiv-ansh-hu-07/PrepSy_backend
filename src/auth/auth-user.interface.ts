import { Request } from 'express';

export interface AuthUserPayload {
  id?: string;
  sub?: string;
  email?: string;
  name?: string;
}

export interface RequestWithUser extends Request {
  user?: AuthUserPayload;
}
