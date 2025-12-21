import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
  origin: [
    'http://localhost:5173',                  // local dev
    'https://prep-sy-frontend.vercel.app',    // old vercel (safe to keep)
    'https://prepsy.in',                      // NEW
    'https://www.prepsy.in',                  // NEW
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

bootstrap();
