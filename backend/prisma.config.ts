import { defineConfig } from 'prisma/config';

// Дефолт указывает на postgres из docker compose, чтобы локально ничего не настраивать.
// В контейнерах DATABASE_URL задаётся в docker-compose.yml.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://flashsale:flashsale@localhost:5432/flashsale',
  },
});
