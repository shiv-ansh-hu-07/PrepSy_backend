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

@Controller('auth')
export class AuthController {
  private googleClient: OAuth2Client;

  constructor(private readonly auth: AuthService) {
    this.googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
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
  ) {
    return this.auth.login(email, password);
  }

  // =========================
  // GOOGLE OAUTH (ID TOKEN)
  // =========================
  @Post('oauth/google')
  async googleAuth(@Body('idToken') idToken: string) {
    if (!idToken) {
      throw new UnauthorizedException('Missing Google ID token');
    }

    const ticket = await this.googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.email || !payload?.sub) {
      throw new UnauthorizedException('Invalid Google token payload');
    }

    return this.auth.oauthLogin('google', {
      email: payload.email,
      providerId: payload.sub,
      name: payload.name,
    });
  }

  // ========================
  // CURRENT USER
  // =========================
  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@Req() req: any) {
    return this.auth.me(req.user.sub);
  }

}
