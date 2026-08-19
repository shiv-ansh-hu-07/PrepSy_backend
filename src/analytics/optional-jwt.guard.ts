import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Like JwtAuthGuard but never rejects. If a valid Bearer token is present,
 * `req.user` is populated; otherwise the request proceeds anonymously.
 *
 * Needed so pre-signup events (e.g. `signup_started`) can be tracked before a
 * user account exists, while still attributing events to the user once logged in.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(_err: any, user: any): TUser {
    return (user || undefined) as TUser;
  }
}
