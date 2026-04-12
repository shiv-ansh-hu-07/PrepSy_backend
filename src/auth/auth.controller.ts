import {
  Controller,
  Post,
  Body,
  Get,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';
import { OAuth2Client } from 'google-auth-library';
import type { RequestWithUser } from './auth-user.interface';

@Controller('auth')
export class AuthController {
  private googleClient: OAuth2Client;

  constructor(private readonly auth: AuthService) {
    this.googleClient = new OAuth2Client();
  }

  private getGoogleAudiences() {
    return (process.env.GOOGLE_CLIENT_ID || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  // =========================
  // REGISTER (EMAIL/PASSWORD)
  // =========================

  @Post('register')
  register(
    @Body('email') email: string,
    @Body('password') password: string,
    @Body('name') name?: string,
  ) {
    return this.auth.register(email, password, name);
  }

  // =========================
  // LOGIN (EMAIL/PASSWORD)
  // =========================

  @Post('login')
  login(
    @Body('email') email: string,
    @Body('password') password: string,
    @Body('disableStreak') disableStreak?: boolean,
  ) {
    return this.auth.login(email, password, disableStreak);
  }

  // =========================
  // GOOGLE OAUTH (ID TOKEN)
  // =========================
  @Post('oauth/google')
  async googleAuth(
    @Body('idToken') idToken: string,
    @Body('disableStreak') disableStreak?: boolean,
  ) {
    if (!idToken) {
      throw new UnauthorizedException('Missing Google ID token');
    }

    const audiences = this.getGoogleAudiences();
    if (audiences.length === 0) {
      throw new UnauthorizedException('Google login is not configured');
    }

    const ticket = await this.googleClient.verifyIdToken({
      idToken,
      audience: audiences.length === 1 ? audiences[0] : audiences,
    });

    const payload = ticket.getPayload();
    if (!payload?.email || !payload?.sub) {
      throw new UnauthorizedException('Invalid Google token payload');
    }

    return this.auth.oauthLogin(
      'google',
      {
        email: payload.email,
        providerId: payload.sub,
        name: payload.name,
      },
      disableStreak,
    );
  }

  // ========================
  // CURRENT USER
  // =========================
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: RequestWithUser) {
    return this.auth.me(req.user?.sub || req.user?.id || '');
  }
}
