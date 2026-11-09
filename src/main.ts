import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // The app has no web routes yet, so it runs without an HTTP server
  const app = await NestFactory.createApplicationContext(AppModule);

  // When the app is stopped (Ctrl+C or SIGTERM), NestJS closes the queue and Redis connections
  app.enableShutdownHooks();
}

bootstrap();
