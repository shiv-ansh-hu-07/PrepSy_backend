import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      // Public routes never require a login, but still learn who's asking
      // when a valid token is sent (e.g. to hide women-only rooms from men).
      try {
        await super.canActivate(context);
      } catch {
        /* anonymous is fine */
      }
      return true;
    }

    return (await super.canActivate(context)) as boolean;
  }
}
