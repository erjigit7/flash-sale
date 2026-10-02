import { INestApplication, ValidationPipe } from '@nestjs/common';

/** Общая настройка приложения — одна и та же в main.ts и в e2e-тестах. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
}
