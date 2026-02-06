import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  // =========================
  // HELPER: SIGN JWT
  // =========================
  private signJwt(user: User) {
  return this.jwt.sign({
    sub: user.id,
    email: user.email,
  });
}


  // =========================
  // REGISTER (EMAIL/PASSWORD)
  // =========================
  async register(email: string, password: string, name?: string) {
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new BadRequestException('User already exists');

    const hashed = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashed,
        name: name ?? "",
        
      },
    });

    return { 
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    };
  }

  // =========================
  // LOGIN (EMAIL/PASSWORD)
  // =========================
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid email or password');

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    const token = this.jwt.sign(
      {
        id: user.id,
        email: user.email,
        name: user.name,
      }
    );

    return { 
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    };
  }

  // =========================
  // CURRENT USER
  // =========================
  async me(userId: string) {
  if (!userId) {
    throw new UnauthorizedException("Invalid token");
  }
  

  const user = await this.prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new UnauthorizedException("User not found");
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
  };
}


  // =========================
  // GOOGLE OAUTH LOGIN
  // =========================
  async oauthLogin(
    provider: 'google',
    profile: { email: string; providerId: string; name?: string },
  ) {
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { provider, providerId: profile.providerId },
          { email: profile.email },
        ],
      },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: profile.email,
          name: profile.name ?? '',
          provider,
          providerId: profile.providerId,
        },
      });
    }

    return this.signJwt(user);
  }
}
