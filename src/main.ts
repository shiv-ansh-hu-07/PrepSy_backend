import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Behind Caddy on EC2: trust the proxy so req.ip is the real client IP
  // (from X-Forwarded-For). Without this the rate limiter would see every
  // request as the proxy's single IP and throttle all users as one.
  app.set('trust proxy', 1);

  // Security headers. This is a JSON API (the SPA is served separately from
  // Vercel), so CSP isn't needed here and CORP must allow cross-origin so the
  // Vercel frontend can read responses.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Global input validation. DTOs today are interfaces (skipped at runtime), so
  // this is a safe baseline that strips unknown properties and coerces types for
  // any class-validator DTOs added later. Not forbidNonWhitelisted — we don't
  // want to start 400-ing existing clients that send extra fields.
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true }),
  );

  app.enableCors({
    origin: [
      'http://localhost:5173',
      'https://prep-sy-frontend.vercel.app',
      'https://prepsy.in',
      'https://www.prepsy.in',
    ],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  const port = Number(process.env.PORT);
  if (!port) {
    throw new Error('PORT not defined');
  }

  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Backend running on port ${port}`);
}

void bootstrap();
