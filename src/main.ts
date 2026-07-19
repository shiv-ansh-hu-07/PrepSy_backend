import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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
