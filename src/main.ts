import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ---- FIXED CORS (DEV + PROD SAFE) ----
  app.enableCors({
    origin: [
      "http://localhost:5173",                // local dev
      "https://prep-sy-frontend.vercel.app/",     // production frontend
    ],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    exposedHeaders: ["Authorization"],
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log(`🚀 Backend running on port ${port}`);
}

bootstrap();
