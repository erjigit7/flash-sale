FROM node:24-slim
# openssl нужен движку миграций Prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PRISMA_HIDE_UPDATE_MESSAGE=true
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
EXPOSE 3000
# exec: node получает SIGTERM напрямую и корректно завершается (без npm-обёртки)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/seed.js && exec node dist/main.js"]
