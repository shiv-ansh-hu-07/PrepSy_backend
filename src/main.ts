import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ---- FIXED CORS ----
  app.enableCors({
    origin: [
      "http://localhost:5173",   // Vite frontend
      "http://localhost:3000",   // optional (if you proxy)
    ],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    exposedHeaders: ["Authorization"],
  });


  await app.listen(process.env.PORT || 5000);
  console.log(`🚀 Backend running at http://localhost:${process.env.PORT || 5000}`);
}
bootstrap();
